import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Library, toAbsolute, toRelative } from '../library.js'
import type { Asset } from '../../../shared/types.js'

const asset = (dir: string): Asset => ({
  key: 'trip/beach/beach-1.avif',
  kind: 'image',
  postSlug: 'trip',
  group: 'beach',
  state: 'live',
  originalPath: path.join(dir, 'originals', 'trip', 'beach', 'IMG_1.HEIC'),
  outputPath: path.join(dir, 'media', 'trip', 'beach', 'beach-1.avif'),
  posterPath: path.join(dir, 'cache', 'beach-1.avif.poster.jpg'),
  bytesOriginal: 10,
  createdAt: 1,
})

describe('library paths', () => {
  it('stores paths inside the data folder relative, and reads them back absolute', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lib-'))
    const lib = await Library.open(path.join(dir, 'library.json'))
    await lib.put(asset(dir))

    const onDisk = JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8'))
    expect(onDisk.version).toBe(2)
    expect(onDisk.assets['trip/beach/beach-1.avif'].originalPath).toBe('originals/trip/beach/IMG_1.HEIC')

    const again = await Library.open(path.join(dir, 'library.json'))
    expect(again.get('trip/beach/beach-1.avif')).toEqual(asset(dir))
  })

  it('reads a version 1 file with absolute paths unchanged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lib-'))
    const a = asset(dir)
    await writeFile(path.join(dir, 'library.json'), JSON.stringify({ version: 1, assets: { [a.key]: a } }))
    const lib = await Library.open(path.join(dir, 'library.json'))
    expect(lib.get(a.key)).toEqual(a)
  })

  it('a moved data folder still resolves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lib-'))
    const lib = await Library.open(path.join(dir, 'library.json'))
    await lib.put(asset(dir))
    const moved = await mkdtemp(path.join(tmpdir(), 'lib-moved-'))
    await writeFile(path.join(moved, 'library.json'), await readFile(path.join(dir, 'library.json')))
    const there = await Library.open(path.join(moved, 'library.json'))
    expect(there.get('trip/beach/beach-1.avif')!.outputPath).toBe(
      path.join(moved, 'media', 'trip', 'beach', 'beach-1.avif'),
    )
  })

  it('leaves paths outside the data folder absolute, on either platform', () => {
    expect(toRelative('/data', '/Users/a/Desktop/x.jpg')).toBe('/Users/a/Desktop/x.jpg')
    expect(toAbsolute('/data', 'C:\\Users\\a\\x.jpg')).toBe('C:\\Users\\a\\x.jpg')
    expect(toAbsolute('/data', 'media/a/b.avif')).toBe(path.join('/data', 'media', 'a', 'b.avif'))
  })
})
