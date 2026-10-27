import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeD1 } from './fakeD1.js'
import { BlogDb } from '../remote.js'
import { SyncEngine, friendlyName } from '../engine.js'
import { Library } from '../../db/library.js'
import { readPost, writePost, readPostMarkdown, deletePost } from '../../site/hugo.js'
import type { Asset, Post } from '../../../shared/types.js'

const post = (slug: string, text: string, title = slug): Post => ({
  slug,
  frontMatter: { title, date: '2026-10-27', draft: true },
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
})

const textOf = (p: Post | null) => p?.doc.content?.[0]?.content?.[0]?.text

interface Computer {
  engine: SyncEngine
  siteDir: string
  library: Library
  save: (p: Post, base?: number | null) => Promise<void>
}

let d1: FakeD1
let db: BlogDb

async function computer(name: string): Promise<Computer> {
  const dir = await mkdtemp(path.join(tmpdir(), `sync-${name}-`))
  const siteDir = path.join(dir, 'site')
  const library = await Library.open(path.join(dir, 'library.json'))
  const engine = await SyncEngine.open(db, { siteDir, library, statePath: path.join(dir, 'sync.json') })
  ;(engine as any).state.machineName = name
  await engine.heartbeat({ platform: 'test', appVersion: '0' })
  return {
    engine,
    siteDir,
    library,
    save: async (p, base) => {
      await writePost(siteDir, p)
      await engine.postSaved(p.slug, base)
    },
  }
}

beforeEach(async () => {
  d1 = new FakeD1()
  db = new BlogDb(d1)
  await db.applySchema()
})

describe('posts between two computers', () => {
  it('a post saved on one computer arrives on the other', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.save(post('trip', 'hello'))
    expect(await a.engine.flush()).toEqual([])

    const pulled = await b.engine.pull()
    expect(pulled.posts).toEqual(['trip'])
    expect(textOf(await readPost(b.siteDir, 'trip'))).toBe('hello')
    expect(b.engine.versionOf('trip')).toBe(1)

    // And an edit from there comes back.
    await b.save(post('trip', 'edited on PC'), b.engine.versionOf('trip'))
    await b.engine.flush()
    await a.engine.pull()
    expect(textOf(await readPost(a.siteDir, 'trip'))).toBe('edited on PC')
  })

  it('two computers editing the same post keep both versions', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.save(post('trip', 'v1'))
    await a.engine.flush()
    await b.engine.pull()

    await a.save(post('trip', 'from mac'), 1)
    await a.engine.flush()
    await b.save(post('trip', 'from pc'), 1)
    const conflicts = await b.engine.flush()

    expect(conflicts).toEqual([{ slug: 'trip', copySlug: 'trip-from-macbook', machineName: 'MacBook' }])
    // The computer that is typing keeps its text at the slug.
    expect(textOf(await readPost(b.siteDir, 'trip'))).toBe('from pc')
    const copy = await readPost(b.siteDir, 'trip-from-macbook')
    expect(textOf(copy)).toBe('from mac')
    expect(copy!.frontMatter).toMatchObject({ title: 'trip (from MacBook)', draft: true })

    await a.engine.pull()
    expect(textOf(await readPost(a.siteDir, 'trip'))).toBe('from pc')
    expect(textOf(await readPost(a.siteDir, 'trip-from-macbook'))).toBe('from mac')
  })

  it('an edit that started before a pull is checked against what it started from', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.save(post('trip', 'v1'))
    await a.engine.flush()
    await b.engine.pull()
    await a.save(post('trip', 'v2 on mac'), 1)
    await a.engine.flush()
    // PC pulls v2 while its editor still shows v1, then autosaves from v1.
    await b.engine.pull()
    await b.save(post('trip', 'typed over v1'), 1)
    const conflicts = await b.engine.flush()
    expect(conflicts).toHaveLength(1)
    expect(textOf(await readPost(b.siteDir, conflicts[0].copySlug))).toBe('v2 on mac')
  })

  it('a deleted post goes everywhere and does not come back', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.save(post('trip', 'v1'))
    await a.engine.flush()
    await b.engine.pull()

    await deletePost(a.siteDir, 'trip')
    await a.engine.postDeleted('trip')
    await a.engine.flush()
    expect((await b.engine.pull()).posts).toEqual(['trip'])
    expect(await readPostMarkdown(b.siteDir, 'trip')).toBeNull()

    await a.engine.pull()
    expect(await readPostMarkdown(a.siteDir, 'trip')).toBeNull()
  })

  it('editing a post another computer deleted brings it back rather than losing the writing', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.save(post('trip', 'v1'))
    await a.engine.flush()
    await b.engine.pull()
    await a.engine.postDeleted('trip')
    await a.engine.flush()

    await b.save(post('trip', 'still writing'), 1)
    expect(await b.engine.flush()).toEqual([])
    const row = await db.getPost('trip')
    expect(row!.deletedAt).toBeNull()
    expect(row!.markdown).toContain('still writing')
  })

  it('saves made offline are kept and sent when the database answers again', async () => {
    const a = await computer('MacBook')
    d1.offline = true
    await a.save(post('trip', 'offline 1'))
    await a.save(post('trip', 'offline 2'))
    await expect(a.engine.flush()).rejects.toThrow()
    expect(a.engine.pending).toBe(1)

    // The unsent work survives a restart.
    const again = await SyncEngine.open(db, {
      siteDir: a.siteDir,
      library: a.library,
      statePath: path.join(path.dirname(a.siteDir), 'sync.json'),
    })
    d1.offline = false
    await again.flush()
    expect(again.pending).toBe(0)
    expect((await db.getPost('trip'))!.markdown).toContain('offline 2')
  })
})

describe('assets between two computers', () => {
  const asset = (key: string, state: Asset['state'] = 'live'): Asset => ({
    key,
    kind: 'image',
    postSlug: 'trip',
    group: 'beach',
    state,
    originalPath: '/orig/x.heic',
    outputPath: '/out/x.avif',
    bytesOriginal: 100,
    bytesOutput: 10,
    createdAt: 1,
  })

  it('arrive as remote assets with no original, and only once live', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.library.put(asset('trip/beach/beach-1.avif', 'uploading'))
    await a.engine.assetChanged('trip/beach/beach-1.avif')
    await a.engine.flush()
    await b.engine.pull()
    expect(b.library.all()).toHaveLength(0)

    await a.library.setState('trip/beach/beach-1.avif', 'live')
    await a.engine.assetChanged('trip/beach/beach-1.avif')
    await a.engine.flush()
    await b.engine.pull()
    expect(b.library.get('trip/beach/beach-1.avif')).toMatchObject({
      state: 'live',
      originalAvailable: false,
      originalPath: '',
      bytesOriginal: 0,
      bytesOutput: 10,
    })
  })

  it('removals reach the other computer', async () => {
    const a = await computer('MacBook')
    const b = await computer('PC')
    await a.library.put(asset('trip/beach/beach-1.avif'))
    await a.engine.assetChanged('trip/beach/beach-1.avif')
    await a.engine.flush()
    await b.engine.pull()

    await a.library.remove('trip/beach/beach-1.avif')
    await a.engine.assetRemoved('trip/beach/beach-1.avif')
    await a.engine.flush()
    await b.engine.pull()
    expect(b.library.get('trip/beach/beach-1.avif')).toBeUndefined()
  })
})

describe('settings and presence', () => {
  it('reports a settings change once', async () => {
    const a = await computer('MacBook')
    await db.writeBlog({
      name: 'b',
      title: 't',
      author: 'a',
      siteUrl: 'https://b.x.workers.dev',
      bucket: 'b-media',
      r2AccessKeyId: 'k',
      r2Secret: 's',
    })
    expect((await a.engine.pull()).blog?.title).toBe('t')
    expect((await a.engine.pull()).blog).toBeUndefined()
  })

  it('lists the other computers active now', async () => {
    const a = await computer('MacBook')
    await computer('PC')
    expect(await a.engine.heartbeat({ platform: 'test', appVersion: '0' })).toEqual(['PC'])
  })

  it('names a computer from its host name', () => {
    expect(friendlyName('Alices-MacBook-Pro.local')).toBe('Alices MacBook Pro')
    expect(friendlyName('DESKTOP-4F2K')).toBe('DESKTOP 4F2K')
  })
})
