/**
 * Back to draft and delete, against a real scaffolded site and real Hugo
 * builds. Only Cloudflare is faked: the deploy records which post pages it
 * would have shipped, and the bucket records what was deleted, in order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const events = vi.hoisted(() => ({ log: [] as string[], deployOk: true }))
vi.mock('../cloudflare/deploy.js', async () => {
  const { readdir } = await import('node:fs/promises')
  return {
    deploySite: async (_cf: unknown, opts: { publicDir: string }) => {
      if (!events.deployOk) throw new Error('network down')
      const entries = await readdir(path.join(opts.publicDir, 'posts'), { withFileTypes: true })
      const posts = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      events.log.push(`deploy:${posts.sort().join(',')}`)
      return { uploaded: 0, skipped: 0, totalBytes: 0 }
    },
    waitForLive: async () => true,
  }
})

import { unpublishPost, removePost } from '../publish.js'
import { scaffold, writePost, readPost, checkHugo } from '../site/hugo.js'
import { Library } from '../db/library.js'
import type { BlogConfig, Post, Asset } from '../../shared/types.js'

const config: BlogConfig = {
  accountId: 'acct',
  name: 'alice-blog',
  bucket: 'alice-blog-media',
  siteUrl: 'https://alice-blog.alice.workers.dev',
  title: 'Alice',
  author: 'Alice',
}

const post = (slug: string, keys: string[], draft = false): Post => ({
  slug,
  frontMatter: { title: slug, date: '2026-10-01', draft },
  doc: { type: 'doc', content: keys.map((key) => ({ type: 'figure', attrs: { key, caption: null } })) },
})

const asset = (key: string): Asset => ({
  key,
  kind: 'image',
  postSlug: key.split('/')[0],
  group: 'g',
  state: 'live',
  originalPath: `/originals/${key}`,
  bytesOriginal: 1,
  createdAt: 0,
})

const r2 = {
  putText: async (key: string) => void events.log.push(`put:${key}`),
  delete: async (key: string) => void events.log.push(`delete:${key}`),
} as any
const cf = {} as any
const noProgress = () => {}

let dir: string
let library: Library
let hugoOk = false

beforeEach(async () => {
  hugoOk = (await checkHugo()).ok
  events.log = []
  events.deployOk = true
  dir = await mkdtemp(path.join(tmpdir(), 'blog-publish-'))
  await scaffold(path.join(dir, 'site'), config)
  library = await Library.open(path.join(dir, 'library.json'))
  for (const k of ['trip/g/g-1.avif', 'trip/g/g-2.avif', 'home/g/g-1.avif']) await library.put(asset(k))
  // `home` borrows one of trip's photos.
  await writePost(path.join(dir, 'site'), post('trip', ['trip/g/g-1.avif', 'trip/g/g-2.avif']))
  await writePost(path.join(dir, 'site'), post('home', ['home/g/g-1.avif', 'trip/g/g-2.avif']))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const deps = () => ({ config, cf, r2, library, siteDir: path.join(dir, 'site') })

describe('back to draft', () => {
  it('keeps the post as a draft and redeploys without it', async () => {
    if (!hugoOk) return
    const res = await unpublishPost(post('trip', ['trip/g/g-1.avif']), deps(), noProgress)
    expect(res.ok, res.log).toBe(true)
    expect((await readPost(deps().siteDir, 'trip'))?.frontMatter.draft).toBe(true)
    expect(events.log).toContain('put:_source/posts/trip.md')
    expect(events.log).toContain('deploy:home')
    // Media stays, so publishing again is instant.
    expect(events.log.some((e) => e.startsWith('delete:'))).toBe(false)
  })
})

describe('delete', () => {
  it('removes the file, the backup, and the page, then the media no other post shows', async () => {
    if (!hugoOk) return
    const res = await removePost('trip', { media: true }, deps(), noProgress)
    expect(res.ok, res.log).toBe(true)
    expect(existsSync(path.join(deps().siteDir, 'content', 'posts', 'trip.md'))).toBe(false)
    expect(events.log).toEqual([
      'delete:_source/posts/trip.md',
      'deploy:home',
      // Only after the deploy, and never the photo `home` still shows.
      'delete:trip/g/g-1.avif',
    ])
    expect(res.mediaDeleted).toBe(1)
    expect(library.get('trip/g/g-1.avif')).toBeUndefined()
    expect(library.get('trip/g/g-2.avif')).toBeDefined()
  })

  it('leaves the media alone when asked to', async () => {
    if (!hugoOk) return
    const res = await removePost('trip', { media: false }, deps(), noProgress)
    expect(res.ok).toBe(true)
    expect(events.log).toEqual(['delete:_source/posts/trip.md', 'deploy:home'])
    expect(library.get('trip/g/g-1.avif')).toBeDefined()
  })

  it('does not redeploy for a draft', async () => {
    await writePost(deps().siteDir, post('trip', ['trip/g/g-1.avif'], true))
    const res = await removePost('trip', { media: true }, deps(), noProgress)
    expect(res.ok).toBe(true)
    expect(events.log).toEqual(['delete:_source/posts/trip.md', 'delete:trip/g/g-1.avif'])
  })

  it('keeps the media when the redeploy fails, so no live page loses its photos', async () => {
    if (!hugoOk) return
    events.deployOk = false
    const res = await removePost('trip', { media: true }, deps(), noProgress)
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/next time you publish/)
    expect(events.log).toEqual(['delete:_source/posts/trip.md'])
    expect(library.get('trip/g/g-1.avif')).toBeDefined()
  })
})
