/**
 * Locating and running the bundled ffmpeg/ffprobe.
 *
 * The binaries are NOT taken from npm. `ffmpeg-static` ships ffmpeg 6.1.1 and
 * `@ffmpeg-installer/ffmpeg` ships the 4.x series; the HDR branch in
 * `convertVideo` needs swscale colour conversion from ffmpeg >= 8. CI fetches
 * pinned >= 8 builds per platform into `resources/bin/<platform>-<arch>/`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Minimum ffmpeg major version; below this the HDR tone-mapping path is wrong. */
export const MIN_FFMPEG_MAJOR = 8

function resourcesDir(): string {
  // Packaged: process.resourcesPath/bin. Dev: ./resources/bin.
  const packaged = (process as any).resourcesPath
  if (packaged && existsSync(path.join(packaged, 'bin'))) return path.join(packaged, 'bin')
  return path.join(process.cwd(), 'resources', 'bin')
}

function binaryName(tool: string): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool
}

/** Bundled binary if present, else the one on PATH (dev convenience only). */
export function toolPath(tool: 'ffmpeg' | 'ffprobe'): string {
  const bundled = path.join(
    resourcesDir(),
    `${process.platform}-${process.arch}`,
    binaryName(tool),
  )
  return existsSync(bundled) ? bundled : tool
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  bin: string,
  args: string[],
  onStderr?: (chunk: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      onStderr?.(s)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Assert the bundled ffmpeg is new enough, at startup, so a bad build surfaces
 * immediately rather than as washed-out video months later.
 */
export async function assertFfmpegVersion(): Promise<{ ok: boolean; version: string }> {
  const { stdout, stderr, code } = await run(toolPath('ffmpeg'), ['-hide_banner', '-version'])
  const text = stdout || stderr
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(text)
  if (code !== 0 || !m) return { ok: false, version: 'unknown' }
  return { ok: Number(m[1]) >= MIN_FFMPEG_MAJOR, version: `${m[1]}.${m[2]}` }
}

export interface Probe {
  width: number
  height: number
  durationSec: number
  /** HLG or PQ source — needs tone mapping to SDR. */
  isHdr: boolean
  hasAudio: boolean
  videoCodec: string
  /** e.g. yuv420p (8-bit) or yuv420p10le (10-bit). */
  pixFmt: string
  /** Average frame rate; iPhone video is variable-rate, so not r_frame_rate. */
  fps: number
  audioCodec?: string
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run(toolPath('ffprobe'), [
    '-v', 'error',
    '-show_entries', 'stream=width,height,codec_type,codec_name,pix_fmt,avg_frame_rate,color_transfer',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ])
  const json = JSON.parse(stdout || '{}')
  const streams: any[] = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video') ?? {}
  const a = streams.find((s) => s.codec_type === 'audio')
  const trc = v.color_transfer
  const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number)
  return {
    width: Number(v.width ?? 0),
    height: Number(v.height ?? 0),
    durationSec: Number(json.format?.duration ?? 0),
    isHdr: trc === 'smpte2084' || trc === 'arib-std-b67',
    hasAudio: !!a,
    videoCodec: String(v.codec_name ?? ''),
    pixFmt: String(v.pix_fmt ?? ''),
    fps: den ? num / den : 0,
    audioCodec: a?.codec_name,
  }
}
