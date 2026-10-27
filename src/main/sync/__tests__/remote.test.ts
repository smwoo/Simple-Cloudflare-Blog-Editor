import { describe, it, expect, beforeEach } from 'vitest'
import { FakeD1 } from './fakeD1.js'
import { BlogDb } from '../remote.js'
import type { Asset } from '../../../shared/types.js'

const post = (slug: string, markdown = `# ${slug}`) => ({
  slug,
  title: slug,
  date: '2026-10-27',
  draft: true,
  markdown,
})

let db: BlogDb
beforeEach(async () => {
  db = new BlogDb(new FakeD1())
  await db.applySchema()
})

describe('blog row', () => {
  it('is null on a database that is not a blog', async () => {
    expect(await new BlogDb(new FakeD1()).readBlog()).toBeNull()
    expect(await db.readBlog()).toBeNull()
  })

  it('round-trips, and updates settings in place', async () => {
    await db.writeBlog({
      name: 'alice-blog',
      title: 'Trips',
      author: 'Alice',
      siteUrl: 'https://alice-blog.alice.workers.dev',
      bucket: 'alice-blog-media',
      r2AccessKeyId: 'AK',
      r2Secret: 'SK',
    })
    await db.updateBlog({ customDomain: 'alice.com', sitePassword: 'pw' })
    const b = await db.readBlog()
    expect(b).toMatchObject({ schemaVersion: 1, customDomain: 'alice.com', sitePassword: 'pw', r2Secret: 'SK' })
    await db.updateBlog({ sitePassword: undefined })
    expect((await db.readBlog())!.sitePassword).toBeUndefined()
  })
})

describe('posts', () => {
  it('creates at version 1 and refuses a second create of the same slug', async () => {
    expect(await db.putPost(post('a'), null, 'm1')).toEqual({ ok: true, version: 1 })
    const again = await db.putPost(post('a', 'other'), null, 'm2')
    expect(again.ok).toBe(false)
    expect(!again.ok && again.remote?.markdown).toBe('# a')
  })

  it('updates only from the version it last saw', async () => {
    await db.putPost(post('a'), null, 'm1')
    expect(await db.putPost(post('a', 'v2'), 1, 'm1')).toEqual({ ok: true, version: 2 })
    const stale = await db.putPost(post('a', 'from m2'), 1, 'm2')
    expect(stale.ok).toBe(false)
    expect((await db.getPost('a'))!.markdown).toBe('v2')
  })

  it('keeps a deleted post deleted, and brings it back when written again', async () => {
    await db.putPost(post('a'), null, 'm1')
    await db.deletePost('a', 'm1')
    const gone = await db.getPost('a')
    expect(gone!.deletedAt).not.toBeNull()
    expect(gone!.version).toBe(2)
    expect((await db.putPost(post('a', 'back'), null, 'm2')).ok).toBe(true)
    expect((await db.getPost('a'))!.deletedAt).toBeNull()
  })

  it('reports changes since a time, deletions included', async () => {
    const t0 = await db.now()
    await db.putPost(post('a'), null, 'm1')
    await db.putPost(post('b'), null, 'm1')
    await db.deletePost('b', 'm1')
    const changed = await db.postsSince(t0)
    expect(changed.map((p) => [p.slug, !!p.deletedAt]).sort()).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('snapshots at most once per ten minutes, so autosave does not flood history', async () => {
    await db.putPost(post('a', 'one'), null, 'm1')
    await db.putPost(post('a', 'two'), 1, 'm1')
    await db.putPost(post('a', 'three'), 2, 'm1')
    expect((await db.versions('a')).map((v) => v.markdown)).toEqual(['one'])
  })

  it('force-writes over any version', async () => {
    await db.putPost(post('a'), null, 'm1')
    await db.putPost(post('a', 'v2'), 1, 'm1')
    expect(await db.forcePost(post('a', 'forced'), 'm2')).toBe(3)
  })
})

describe('assets', () => {
  const asset: Asset = {
    key: 'trip/beach/beach-1.avif',
    kind: 'image',
    postSlug: 'trip',
    group: 'beach',
    state: 'live',
    originalPath: '/x',
    bytesOriginal: 10,
    bytesOutput: 5,
    width: 800,
    height: 600,
    createdAt: 1,
  }

  it('upserts, deletes, and counts only what is left', async () => {
    const t0 = await db.now()
    await db.putAsset(asset, 'm1')
    await db.putAsset({ ...asset, key: 'trip/beach/beach-2.mp4', kind: 'video', hasPoster: true }, 'm1')
    await db.deleteAsset(asset.key)
    const rows = await db.assetsSince(t0)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.key === asset.key)!.deletedAt).not.toBeNull()
    expect(rows.find((r) => r.kind === 'video')).toMatchObject({ hasPoster: true, originMachine: 'm1' })
    expect(await db.counts()).toEqual({ posts: 0, assets: 1 })
  })
})

describe('machines', () => {
  it('records each computer once and refreshes last seen', async () => {
    await db.touchMachine({ id: 'm1', name: 'MacBook', platform: 'darwin', appVersion: '0.2.0' })
    await db.touchMachine({ id: 'm1', name: 'MacBook', platform: 'darwin', appVersion: '0.2.1' })
    const ms = await db.machines()
    expect(ms).toHaveLength(1)
    expect(ms[0].appVersion).toBe('0.2.1')
  })
})
