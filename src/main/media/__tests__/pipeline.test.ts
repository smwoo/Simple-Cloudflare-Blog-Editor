/**
 * Integration tests against the reference media library.
 *
 * These exercise real sharp and real ffmpeg, because the two things most likely
 * to go silently wrong — EXIF orientation and the ICC colour profile — cannot be
 * verified any other way. They skip when the reference library is absent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { convertImage, allocateKey, slugify, kindOf, DEFAULT_SETTINGS } from '../pipeline.js'
import { assertFfmpegVersion, probe } from '../ffmpeg.js'

const REF = path.join(process.env.HOME ?? '', 'workspace/blog/media')
const ROTATED = path.join(REF, '_originals/may-2026/chief 2.JPG')
const HAVE_REF = existsSync(ROTATED)

describe('key allocation', () => {
  it('slugifies group names', () => {
    expect(slugify('Chief 1 (2)')).toBe('chief-1-2')
    expect(slugify('Tofino Surf!')).toBe('tofino-surf')
  })

  it('numbers within a post/group and skips taken keys', () => {
    const taken = new Set(['nov-2026/surf/surf-1.avif'])
    expect(allocateKey('nov-2026', 'Surf', 'image', taken)).toBe('nov-2026/surf/surf-2.avif')
    expect(allocateKey('nov-2026', 'Surf', 'video', taken)).toBe(
      'nov-2026/surf/surf-video-1.mp4',
    )
  })

  it('classifies files', () => {
    expect(kindOf('a.JPG')).toBe('image')
    expect(kindOf('a.HEIC')).toBe('image')
    expect(kindOf('a.MOV')).toBe('video')
    expect(kindOf('a.txt')).toBeNull()
  })
})

describe.skipIf(!HAVE_REF)('image conversion against the reference library', () => {
  let out: string

  beforeAll(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'blog-editor-'))
  })

  it('bakes EXIF orientation into the pixels', async () => {
    // Stored 4032x3024 with Orientation=6, so it must come out 900x1200 portrait.
    const src = await sharp(ROTATED).metadata()
    expect(src.width).toBe(4032)
    expect(src.height).toBe(3024)
    expect(src.orientation).toBe(6)

    const dest = path.join(out, 'rotated.avif')
    const info = await convertImage(ROTATED, dest, DEFAULT_SETTINGS)
    expect(info.width).toBe(900)
    expect(info.height).toBe(1200)
  })

  it('PRESERVES the ICC colour profile', async () => {
    // Phone photos are Display P3. Dropping the profile makes a browser read P3
    // primaries as sRGB and every saturated colour flattens.
    const dest = path.join(out, 'icc.avif')
    await convertImage(ROTATED, dest, DEFAULT_SETTINGS)
    const meta = await sharp(dest).metadata()
    expect(meta.icc).toBeDefined()
    expect(meta.icc!.length).toBeGreaterThan(100)
  })

  it('strips EXIF while keeping the profile', async () => {
    const dest = path.join(out, 'noexif.avif')
    await convertImage(ROTATED, dest, DEFAULT_SETTINGS)
    const meta = await sharp(dest).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.icc).toBeDefined()
  })

  it('never upscales a small source', async () => {
    const small = path.join(out, 'small.png')
    await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#336699' },
    })
      .png()
      .toFile(small)
    const dest = path.join(out, 'small.avif')
    const info = await convertImage(small, dest, DEFAULT_SETTINGS)
    expect(info.width).toBe(300)
    expect(info.height).toBe(200)
  })

  it('lands in the same size class as the reference pipeline', async () => {
    // ImageMagick -quality 80 produced 327,950 bytes for this photo at 1200x900.
    const src = path.join(REF, '_originals/may-2026/Ally Dad Bod Photo.jpg')
    if (!existsSync(src)) return
    const dest = path.join(out, 'size.avif')
    const info = await convertImage(src, dest, DEFAULT_SETTINGS)
    expect(info.width).toBe(1200)
    expect(info.height).toBe(900)
    // Must not balloon past the reference, and must not be suspiciously tiny.
    expect(info.bytes).toBeLessThan(400_000)
    expect(info.bytes).toBeGreaterThan(40_000)
    console.log(`      AVIF q${DEFAULT_SETTINGS.imageQuality}: ${info.bytes} bytes (reference magick q80: 327950)`)
  })
})

describe('ffmpeg', () => {
  it('is new enough for the HDR tone-mapping path', async () => {
    const { ok, version } = await assertFfmpegVersion()
    console.log(`      ffmpeg ${version}`)
    expect(ok).toBe(true)
  })

  it.skipIf(!HAVE_REF)('probes HDR and dimensions', async () => {
    const v = path.join(REF, 'aug-2026/boris-cave/boris-cave-video-2.mp4')
    if (!existsSync(v)) return
    const info = await probe(v)
    expect(info.width).toBeGreaterThan(0)
    expect(info.durationSec).toBeGreaterThan(0)
    expect(typeof info.isHdr).toBe('boolean')
  })
})
