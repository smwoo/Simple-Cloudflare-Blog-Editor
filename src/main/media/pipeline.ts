/**
 * Converting dropped files into web media.
 *
 * Settings are lifted unchanged from the reference pipeline, where they were
 * hard-won. Do not re-derive them casually — see PLAN.md's appendix.
 *
 *   images  sharp  -> AVIF, longest side 1200, EXIF baked in and stripped,
 *                    ICC profile PRESERVED (phone photos are Display P3; without
 *                    the profile a browser reads P3 as sRGB and every saturated
 *                    colour flattens)
 *   video   ffmpeg -> HEVC/AAC MP4, <=1080p30, hvc1 tag, faststart, SDR
 */
import { mkdir, copyFile, stat, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { toolPath, run, probe, type Probe } from './ffmpeg.js'
import { posterKey, type Asset, type AssetKind } from '../../shared/types.js'

export const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'webp', 'gif', 'bmp',
])
export const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm'])

/** sharp's prebuilt binaries cannot decode these; ffmpeg decodes them first. */
const NEEDS_FFMPEG_DECODE = new Set(['heic', 'heif'])

export interface ConvertSettings {
  /** AVIF quality. Recalibrate against the reference library before shipping. */
  imageQuality: number
  /** Longest image side; 0 disables resizing. Never upscales. */
  maxDim: number
  /**
   * x265 CRF. Lower is better quality and larger. 28 measured at VMAF ~93 from
   * a phone original (clean on phones and laptops) for ~25% less storage than 26.
   */
  videoCrf: number
  videoPreset: string
}

export const DEFAULT_SETTINGS: ConvertSettings = {
  imageQuality: 62,
  maxDim: 1200,
  videoCrf: 28,
  videoPreset: 'slow',
}

export function kindOf(file: string): AssetKind | null {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

/** "Chief 1 (2).JPG" -> "chief-1-2" */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Allocate the object key at drop time, not upload time.
 *
 * This is what keeps the document stable: the editor inserts the node
 * immediately, the gallery renders with placeholders, and nothing has to be
 * rewritten underneath the writer when the upload finally lands.
 */
export function allocateKey(
  postSlug: string,
  group: string,
  kind: AssetKind,
  taken: ReadonlySet<string>,
): string {
  const g = slugify(group) || 'photos'
  const suffix = kind === 'video' ? '-video-' : '-'
  const ext = kind === 'video' ? '.mp4' : '.avif'
  let n = 1
  for (;;) {
    const key = `${postSlug}/${g}/${g}${suffix}${n}${ext}`
    if (!taken.has(key)) return key
    n++
  }
}

// ---------------------------------------------------------------- images

async function decodeToPng(src: string, dest: string): Promise<void> {
  // HEIC/HEIF: sharp's prebuilds have no libheif, so ffmpeg decodes first.
  const { code, stderr } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', src,
    '-frames:v', '1',
    dest,
  ])
  if (code !== 0) throw new Error(`decode failed: ${stderr.trim().slice(0, 200)}`)
}

export async function convertImage(
  src: string,
  dest: string,
  settings: ConvertSettings,
): Promise<{ width: number; height: number; bytes: number }> {
  const ext = path.extname(src).slice(1).toLowerCase()
  let input = src
  let temp: string | undefined

  if (NEEDS_FFMPEG_DECODE.has(ext)) {
    temp = dest.replace(/\.avif$/, '.decode.png')
    await decodeToPng(src, temp)
    input = temp
  }

  const pipeline = sharp(input, { failOn: 'none' })
    // Bake EXIF orientation into the pixels. 38 of 59 sampled reference photos
    // have a non-default orientation, so skipping this turns a library sideways.
    .rotate()
    .resize({
      width: settings.maxDim || undefined,
      height: settings.maxDim || undefined,
      fit: 'inside',
      withoutEnlargement: true,
    })
    // keepIccProfile() alone: keeps the colour profile, drops EXIF and the rest.
    .keepIccProfile()
    .avif({ quality: settings.imageQuality, effort: 4 })

  const info = await pipeline.toFile(dest)
  if (temp) await run(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'del', temp] : ['-f', temp])
  return { width: info.width, height: info.height, bytes: info.size }
}

/** A small JPEG thumbnail for the library grid. */
export async function makeThumbnail(src: string, dest: string): Promise<void> {
  await sharp(src, { failOn: 'none' })
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(dest)
}

// ---------------------------------------------------------------- video

/** Fit inside 1080p without upscaling; -2 keeps the free dimension even. */
const SCALE =
  "scale=w='if(gt(iw,ih),-2,min(1080,iw))':h='if(gt(iw,ih),min(1080,ih),-2)'"

/**
 * Re-encoding must save at least this fraction of the source's size, or the
 * source is remuxed instead. A video that is already HEVC was usually converted
 * once already; a second pass measured -4.7 VMAF for only -8% size.
 */
export const MIN_REENCODE_SAVING = 0.15

/** Already in the shape convertVideo produces, so it can be published as-is. */
export function isWebReady(p: Probe): boolean {
  return (
    p.videoCodec === 'hevc' &&
    p.pixFmt === 'yuv420p' &&
    !p.isHdr &&
    Math.min(p.width, p.height) <= 1080 &&
    p.fps > 0 &&
    p.fps <= 30.5 &&
    (!p.hasAudio || p.audioCodec === 'aac')
  )
}

export async function convertVideo(
  src: string,
  dest: string,
  settings: ConvertSettings,
  onProgress?: (fraction: number) => void,
): Promise<{
  width: number
  height: number
  durationSec: number
  bytes: number
  /** "remuxed": the source was repackaged, not re-encoded (no quality loss). */
  method: 'encoded' | 'remuxed'
}> {
  const info = await probe(src)
  const webReady = isWebReady(info)
  // A web-ready source gets a trial encode, kept only if it is worth it.
  const target = webReady ? `${dest}.trial.mp4` : dest

  await encodeVideo(src, target, info, settings, onProgress)

  let method: 'encoded' | 'remuxed' = 'encoded'
  if (webReady) {
    const [{ size: srcBytes }, { size: encBytes }] = await Promise.all([stat(src), stat(target)])
    if (encBytes > srcBytes * (1 - MIN_REENCODE_SAVING)) {
      await remuxVideo(src, dest)
      method = 'remuxed'
    } else {
      await rename(target, dest)
    }
    await rm(target, { force: true })
  }

  const out = await probe(dest)
  const { size } = await stat(dest)
  return { width: out.width, height: out.height, durationSec: out.durationSec, bytes: size, method }
}

async function encodeVideo(
  src: string,
  dest: string,
  info: Probe,
  settings: ConvertSettings,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  let scale = SCALE
  const colour: string[] = []
  if (info.isHdr) {
    // iPhone HDR (HLG/PQ, 10-bit) -> SDR BT.709 while scaling, so colours are
    // not washed out. Needs swscale colour conversion from ffmpeg >= 8.
    scale +=
      ':out_primaries=bt709:out_transfer=bt709:out_color_matrix=bt709:out_range=tv'
    colour.push(
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
    )
  }

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `${scale},fps=30,format=yuv420p`,
    '-c:v', 'libx265',
    '-preset', settings.videoPreset,
    '-crf', String(settings.videoCrf),
    // hvc1, not ffmpeg's default hev1: Safari will not recognise the track
    // otherwise, which is the whole reason HEVC was chosen.
    '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error',
    ...colour,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    // moov atom up front so playback starts before the download finishes.
    '-movflags', '+faststart',
    '-progress', 'pipe:2', '-nostats',
    '-f', 'mp4',
    dest,
  ]

  const total = info.durationSec || 0
  const { code, stderr } = await run(toolPath('ffmpeg'), args, (chunk) => {
    if (!onProgress || !total) return
    const m = /out_time_ms=(\d+)/.exec(chunk)
    if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / total))
  })
  if (code !== 0) throw new Error(`encode failed: ${stderr.trim().slice(0, 300)}`)
}

/** Repackage without re-encoding: same tag, faststart and stripped metadata as an encode. */
async function remuxVideo(src: string, dest: string): Promise<void> {
  const { code, stderr } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-sn', '-dn',
    // Phone video carries GPS location in its metadata; never publish it.
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-c', 'copy',
    '-tag:v', 'hvc1',
    '-movflags', '+faststart',
    '-f', 'mp4',
    dest,
  ])
  if (code !== 0) throw new Error(`remux failed: ${stderr.trim().slice(0, 300)}`)
}

/** First frame, for the library grid and the editor's video node. */
export async function makePoster(src: string, dest: string): Promise<void> {
  const { code } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', src,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    dest,
  ])
  if (code !== 0) throw new Error('poster frame failed')
}

/**
 * A small H.264 copy, used ONLY for playback inside the app.
 *
 * Chromium decodes HEVC natively on macOS but on Windows leans on a platform
 * decoder that many machines lack. Without this the owner drags in a video,
 * finds it will not play in the editor, and concludes it is broken — while it
 * plays perfectly on the published site.
 */
export async function makePreviewProxy(src: string, dest: string): Promise<void> {
  const { code } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', src,
    '-vf', "scale=w='if(gt(iw,ih),-2,min(720,iw))':h='if(gt(iw,ih),min(720,ih),-2)',fps=30,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4',
    dest,
  ])
  if (code !== 0) throw new Error('preview proxy failed')
}

// ---------------------------------------------------------------- ingest

export interface IngestPaths {
  /** Preserved originals, never deleted automatically. */
  originalsDir: string
  /** Converted web outputs, uploaded from here. */
  outputDir: string
  /** Thumbnails, poster frames and preview proxies. */
  cacheDir: string
}

/**
 * Copy a dropped file into the originals archive and produce every derivative.
 * Returns the asset with its final key already assigned.
 */
export async function ingest(
  srcFile: string,
  key: string,
  postSlug: string,
  group: string,
  paths: IngestPaths,
  settings: ConvertSettings,
  onProgress?: (fraction: number) => void,
): Promise<Asset> {
  const kind = kindOf(srcFile)
  if (!kind) throw new Error(`unsupported file type: ${path.basename(srcFile)}`)

  const base = path.basename(key)
  const originalPath = path.join(paths.originalsDir, postSlug, slugify(group), path.basename(srcFile))
  const outputPath = path.join(paths.outputDir, key)
  const posterPath = path.join(paths.cacheDir, `${base}.poster.jpg`)

  await mkdir(path.dirname(originalPath), { recursive: true })
  await mkdir(path.dirname(outputPath), { recursive: true })
  await mkdir(paths.cacheDir, { recursive: true })

  // A retry re-ingests from the archived original itself.
  if (path.resolve(srcFile) !== path.resolve(originalPath)) await copyFile(srcFile, originalPath)
  const { size: bytesOriginal } = await stat(originalPath)

  const asset: Asset = {
    key,
    kind,
    postSlug,
    group: slugify(group),
    state: 'converting',
    originalPath,
    outputPath,
    bytesOriginal,
    createdAt: Date.now(),
  }

  if (kind === 'image') {
    const out = await convertImage(originalPath, outputPath, settings)
    await makeThumbnail(outputPath, posterPath)
    Object.assign(asset, {
      width: out.width,
      height: out.height,
      bytesOutput: out.bytes,
      posterPath,
      state: 'uploading',
    })
  } else {
    const out = await convertVideo(originalPath, outputPath, settings, onProgress)
    // Beside the video rather than in the cache: it is uploaded with it, and
    // the preview server serves this folder as /media.
    const videoPoster = path.join(paths.outputDir, posterKey(key))
    await makePoster(outputPath, videoPoster)
    const proxyPath = path.join(paths.cacheDir, `${base}.preview.mp4`)
    await makePreviewProxy(outputPath, proxyPath)
    Object.assign(asset, {
      width: out.width,
      height: out.height,
      durationSec: out.durationSec,
      bytesOutput: out.bytes,
      posterPath: videoPoster,
      proxyPath,
      state: 'uploading',
    })
  }

  return asset
}
