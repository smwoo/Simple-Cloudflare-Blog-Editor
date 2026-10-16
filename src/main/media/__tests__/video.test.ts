/**
 * Video conversion with the real ffmpeg, on small generated clips: when the app
 * re-encodes, when it remuxes, and that a remux is lossless and still strips
 * metadata such as GPS location.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { convertVideo, isWebReady, DEFAULT_SETTINGS, MIN_REENCODE_SAVING } from '../pipeline.js'
import { probe, run, toolPath, type Probe } from '../ffmpeg.js'

let dir: string
const FAST = { ...DEFAULT_SETTINGS, videoPreset: 'ultrafast' }

/** A 3 s test clip with a tone and a GPS tag, encoded as asked. */
async function makeClip(name: string, video: string[], opts: { fps?: number } = {}) {
  const file = path.join(dir, name)
  const { code, stderr } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${opts.fps ?? 30}:duration=3`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    ...video,
    '-c:a', 'aac', '-b:a', '96k',
    '-metadata', 'location=+47.6062-122.3321/',
    '-movflags', '+faststart', '-f', 'mp4', file,
  ])
  if (code !== 0) throw new Error(stderr)
  return file
}

async function videoMd5(file: string): Promise<string> {
  const { stdout } = await run(toolPath('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-',
  ])
  return stdout.trim()
}

async function tags(file: string): Promise<{ format: Record<string, string>; codecTag: string }> {
  const { stdout } = await run(toolPath('ffprobe'), [
    '-v', 'error', '-show_entries', 'format_tags:stream=codec_tag_string', '-select_streams', 'v:0', '-of', 'json', file,
  ])
  const j = JSON.parse(stdout)
  return { format: j.format?.tags ?? {}, codecTag: j.streams?.[0]?.codec_tag_string }
}

/** moov before mdat = playback can start before the download finishes. */
async function isFaststart(file: string): Promise<boolean> {
  const buf = await readFile(file)
  return buf.indexOf('moov') < buf.indexOf('mdat')
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'blog-video-'))
})

describe('isWebReady', () => {
  const base: Probe = {
    width: 1080, height: 1920, durationSec: 10, isHdr: false, hasAudio: true,
    videoCodec: 'hevc', pixFmt: 'yuv420p', fps: 30, audioCodec: 'aac',
  }
  it('accepts what the converter itself produces', () => {
    expect(isWebReady(base)).toBe(true)
    expect(isWebReady({ ...base, fps: 29.97 })).toBe(true)
    expect(isWebReady({ ...base, hasAudio: false, audioCodec: undefined })).toBe(true)
  })
  it('rejects anything the converter would change', () => {
    expect(isWebReady({ ...base, videoCodec: 'h264' })).toBe(false)
    expect(isWebReady({ ...base, pixFmt: 'yuv420p10le' })).toBe(false)
    expect(isWebReady({ ...base, isHdr: true })).toBe(false)
    expect(isWebReady({ ...base, width: 2160, height: 3840 })).toBe(false)
    expect(isWebReady({ ...base, fps: 60 })).toBe(false)
    expect(isWebReady({ ...base, audioCodec: 'pcm_s16le' })).toBe(false)
  })
})

describe('convertVideo', () => {
  it('defaults to CRF 28', () => {
    expect(DEFAULT_SETTINGS.videoCrf).toBe(28)
  })

  it('remuxes an already-converted video: lossless, but GPS still stripped', async () => {
    const src = await makeClip('converted.mp4', ['-c:v', 'libx265', '-crf', '28', '-tag:v', 'hev1', '-x265-params', 'log-level=error'])
    expect((await tags(src)).format.location).toBeDefined()

    const dest = path.join(dir, 'converted-out.mp4')
    const res = await convertVideo(src, dest, FAST)

    expect(res.method).toBe('remuxed')
    expect(await videoMd5(dest)).toBe(await videoMd5(src))
    const out = await tags(dest)
    expect(out.format.location).toBeUndefined()
    expect(out.codecTag).toBe('hvc1')
    expect(await isFaststart(dest)).toBe(true)
  }, 60_000)

  it('re-encodes an H.264 phone-style video', async () => {
    const src = await makeClip('phone.mp4', ['-c:v', 'libx264', '-crf', '12'])
    const res = await convertVideo(src, path.join(dir, 'phone-out.mp4'), FAST)
    expect(res.method).toBe('encoded')
    expect((await probe(path.join(dir, 'phone-out.mp4'))).videoCodec).toBe('hevc')
  }, 60_000)

  it('re-encodes a web-ready HEVC video when that saves enough', async () => {
    const src = await makeClip('dense.mp4', ['-c:v', 'libx265', '-crf', '8', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'])
    const dest = path.join(dir, 'dense-out.mp4')
    const res = await convertVideo(src, dest, FAST)
    expect(res.method).toBe('encoded')
    expect(res.bytes).toBeLessThan((await stat(src)).size * (1 - MIN_REENCODE_SAVING))
    // The trial file is cleaned up either way.
    await expect(stat(`${dest}.trial.mp4`)).rejects.toThrow()
  }, 60_000)

  it('re-encodes 60 fps HEVC down to 30 fps rather than remuxing it', async () => {
    const src = await makeClip('sixty.mp4', ['-c:v', 'libx265', '-crf', '28', '-x265-params', 'log-level=error'], { fps: 60 })
    const dest = path.join(dir, 'sixty-out.mp4')
    const res = await convertVideo(src, dest, FAST)
    expect(res.method).toBe('encoded')
    expect(Math.round((await probe(dest)).fps)).toBe(30)
  }, 60_000)
})
