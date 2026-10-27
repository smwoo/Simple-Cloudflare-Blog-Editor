/**
 * The whole journey for an existing user: migrate on the old computer, find
 * and connect the blog on a new one, and recover a blog whose computer is gone.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeAccount, FakeR2 } from './fakes.js'
import { migrate, NewerDatabaseError } from '../migrate.js'
import { findBlogs, connectBlog, recoverUnmoved, KeysRejectedError } from '../connect.js'
import { existingBlog } from '../../setup.js'
import { RestD1 } from '../../cloudflare/d1.js'
import { BlogDb } from '../remote.js'
import { Library } from '../../db/library.js'
import { writePost, readPost, listPosts } from '../../site/hugo.js'
import { serializePost } from '../../../shared/markdown.js'
import type { Asset, BlogConfig, Post } from '../../../shared/types.js'

const config: BlogConfig = {
  accountId: 'acct1',
  name: 'alice-blog',
  bucket: 'alice-blog-media',
  siteUrl: 'https://alice-blog.alice.workers.dev',
  customDomain: 'alice.com',
  title: 'Trips',
  author: 'Alice',
  sitePassword: 'sesame',
}
const secrets = { cloudflareToken: 'tok', r2AccessKeyId: 'AK', r2SecretAccessKey: 'SK' }

const post = (slug: string, text: string, draft = false): Post => ({
  slug,
  frontMatter: { title: slug, date: '2026-10-01', draft },
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
})

let account: FakeAccount
let r2: FakeR2

async function oldComputer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'old-'))
  const siteDir = path.join(dir, 'site')
  const library = await Library.open(path.join(dir, 'library.json'))
  await writePost(siteDir, post('rome', 'Day one'))
  await writePost(siteDir, post('draft-only-here', 'never backed up', true))

  const poster = path.join(dir, 'cache', 'clip-1.mp4.poster.jpg')
  await mkdir(path.dirname(poster), { recursive: true })
  await writeFile(poster, 'jpeg bytes')
  const base = { postSlug: 'rome', group: 'day', originalPath: path.join(dir, 'originals', 'x'), bytesOriginal: 9, createdAt: 1 }
  const assets: Asset[] = [
    { ...base, key: 'rome/day/day-1.avif', kind: 'image', state: 'live', bytesOutput: 5 },
    { ...base, key: 'rome/day/clip-1.mp4', kind: 'video', state: 'live', bytesOutput: 50, posterPath: poster },
    { ...base, key: 'rome/day/day-2.avif', kind: 'image', state: 'failed' },
  ]
  for (const a of assets) await library.put(a)

  // What the old backup left in the bucket.
  r2.objects.set('_source/posts/rome.md', Buffer.from(serializePost(post('rome', 'Day one'))))
  r2.objects.set('_source/history/2026-10-01/rome.md', Buffer.from('old'))
  r2.objects.set('rome/day/day-1.avif', Buffer.from('avif'))
  return { dir, siteDir, library }
}

async function newComputer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'new-'))
  return { dir, siteDir: path.join(dir, 'site'), library: await Library.open(path.join(dir, 'library.json')) }
}

const runMigrate = async (old: Awaited<ReturnType<typeof oldComputer>>) =>
  migrate({
    cf: account.cf(),
    config,
    secrets,
    library: old.library,
    siteDir: old.siteDir,
    r2: r2.asR2(),
    machineId: 'old-mac',
  })

beforeEach(() => {
  account = new FakeAccount()
  r2 = new FakeR2()
  account.buckets.add('alice-blog-media')
  account.workers.add('alice-blog')
})

describe('migrating an existing blog', () => {
  it('copies settings, every local post and the live photos, then removes the old backup', async () => {
    const old = await oldComputer()
    const res = await runMigrate(old)
    const db = account.db(res.databaseId)

    expect(await db.readBlog()).toMatchObject({
      name: 'alice-blog',
      customDomain: 'alice.com',
      sitePassword: 'sesame',
      r2AccessKeyId: 'AK',
      r2Secret: 'SK',
    })
    expect((await db.postsSince(0)).map((p) => p.slug).sort()).toEqual(['draft-only-here', 'rome'])
    expect((await db.assetsSince(0)).map((a) => a.key).sort()).toEqual(['rome/day/clip-1.mp4', 'rome/day/day-1.avif'])

    // The video's poster went up beside it; nothing else media-wise was uploaded.
    expect(r2.objects.get('rome/day/clip-1.mp4.poster.jpg')?.toString()).toBe('jpeg bytes')
    expect(old.library.get('rome/day/clip-1.mp4')!.hasPoster).toBe(true)
    expect([...r2.objects.keys()].filter((k) => k.startsWith('_source/'))).toEqual([])
    expect(r2.objects.has('rome/day/day-1.avif')).toBe(true)
    expect(Object.keys(res.versions).sort()).toEqual(['draft-only-here', 'rome'])
  })

  it('can run again after an interruption', async () => {
    const old = await oldComputer()
    const first = await runMigrate(old)
    const second = await runMigrate(old)
    expect(second.databaseId).toBe(first.databaseId)
    expect(account.databases.size).toBe(1)
    expect((await account.db(first.databaseId).counts()).posts).toBe(2)
  })

  it('refuses a database a newer app has already written', async () => {
    const old = await oldComputer()
    const { databaseId } = await runMigrate(old)
    account.databases.get(databaseId)!.d1.db.exec('UPDATE blog SET schema_version = 99')
    await expect(runMigrate(old)).rejects.toBeInstanceOf(NewerDatabaseError)
  })
})

describe('connecting a new computer', () => {
  it('finds the blog by what is in the account, with what the owner needs to recognise it', async () => {
    const old = await oldComputer()
    const { db } = await runMigrate(old)
    await db.touchMachine({ id: 'old-mac', name: "Alice's MacBook", platform: 'darwin', appVersion: '0.2.0' })

    const { blogs, unmoved } = await findBlogs(account.cf())
    expect(unmoved).toEqual([])
    expect(blogs).toHaveLength(1)
    expect(blogs[0]).toMatchObject({
      accountName: "Alice's Account",
      title: 'Trips',
      customDomain: 'alice.com',
      posts: 2,
      lastEditedOn: "Alice's MacBook",
      needsUpdate: false,
    })
  })

  it('brings posts, settings and the photo list down, and never deploys', async () => {
    const old = await oldComputer()
    const { databaseId } = await runMigrate(old)
    const fresh = await newComputer()
    const before = account.requests.length

    const res = await connectBlog(
      { token: 'tok2', accountId: 'acct1', databaseId, siteDir: fresh.siteDir, library: fresh.library, check: async () => {} },
      account.factories(r2),
    )

    expect(res.config).toMatchObject({ customDomain: 'alice.com', sitePassword: 'sesame', databaseId })
    // The R2 keys come from the database; only the token was typed in.
    expect(res.secrets).toEqual({ cloudflareToken: 'tok2', r2AccessKeyId: 'AK', r2SecretAccessKey: 'SK' })
    expect((await listPosts(fresh.siteDir)).map((p) => p.slug).sort()).toEqual(['draft-only-here', 'rome'])
    expect((await readPost(fresh.siteDir, 'draft-only-here'))!.frontMatter.draft).toBe(true)
    expect(existsSync(path.join(fresh.siteDir, 'hugo.yaml'))).toBe(true)
    expect(existsSync(path.join(fresh.siteDir, 'content', 'posts', 'welcome.md'))).toBe(false)

    expect(fresh.library.get('rome/day/clip-1.mp4')).toMatchObject({
      originalAvailable: false,
      hasPoster: true,
      state: 'live',
    })
    expect(account.requests.slice(before).some((r) => /workers\/scripts|assets-upload/.test(r))).toBe(false)
  })

  it('takes new storage keys when the saved ones are rejected, and saves them for everyone', async () => {
    const old = await oldComputer()
    const { databaseId } = await runMigrate(old)
    const fresh = await newComputer()
    r2.rejectKeys = true
    const args = { token: 't', accountId: 'acct1', databaseId, siteDir: fresh.siteDir, library: fresh.library, check: async () => {} }
    await expect(connectBlog(args, account.factories(r2))).rejects.toBeInstanceOf(KeysRejectedError)

    r2.rejectKeys = false
    await connectBlog({ ...args, keys: { r2AccessKeyId: 'AK2', r2SecretAccessKey: 'SK2' } }, account.factories(r2))
    expect(await account.db(databaseId).readBlog()).toMatchObject({ r2AccessKeyId: 'AK2', r2Secret: 'SK2' })
  })
})

describe('a blog that was never moved', () => {
  it('shows up as not moved yet', async () => {
    const { blogs, unmoved } = await findBlogs(account.cf())
    expect(blogs).toEqual([])
    expect(unmoved).toEqual([{ accountId: 'acct1', accountName: "Alice's Account", name: 'alice-blog', bucket: 'alice-blog-media' }])
  })

  it('can be rebuilt from the bucket when its computer is gone', async () => {
    r2.objects.set('_source/hugo.yaml', Buffer.from('baseURL: "https://alice.com/"\ntitle: "Trips"\nparams:\n  author: "Alice"\n'))
    r2.objects.set('_source/posts/rome.md', Buffer.from(serializePost(post('rome', 'Day one'))))
    r2.objects.set('_source/history/x/rome.md', Buffer.from('old'))
    r2.objects.set('rome/day/day-1.avif', Buffer.from('avif'))
    r2.objects.set('rome/day/clip-1.mp4', Buffer.from('mp4'))
    r2.objects.set('rome/day/clip-1.mp4.poster.jpg', Buffer.from('jpg'))
    account.domains = [
      { id: 'd1', hostname: 'alice.com', service: 'alice-blog' },
      { id: 'd2', hostname: 'www.alice.com', service: 'alice-blog' },
    ]

    const { unmoved } = await findBlogs(account.cf())
    const { databaseId } = await recoverUnmoved(
      { token: 't', blog: unmoved[0], keys: { r2AccessKeyId: 'AK', r2SecretAccessKey: 'SK' }, machineId: 'new-pc' },
      account.factories(r2),
    )
    const db = account.db(databaseId)
    expect(await db.readBlog()).toMatchObject({
      title: 'Trips',
      author: 'Alice',
      siteUrl: 'https://alice-blog.alice.workers.dev',
      customDomain: 'alice.com',
      sitePassword: undefined,
    })
    expect((await db.postsSince(0)).map((p) => p.slug)).toEqual(['rome'])
    const assets = await db.assetsSince(0)
    expect(assets.map((a) => [a.key, a.kind, a.hasPoster]).sort()).toEqual([
      ['rome/day/clip-1.mp4', 'video', true],
      ['rome/day/day-1.avif', 'image', false],
    ])
    expect((await findBlogs(account.cf())).blogs).toHaveLength(1)
  })
})

describe('setup on a name already in use', () => {
  it('sees a migrated blog through the real D1 client', async () => {
    const old = await oldComputer()
    await runMigrate(old)
    expect(await existingBlog(account.cf(), 'acct1', 'alice-blog', null)).toBe('database')
    expect(await existingBlog(account.cf(), 'acct1', 'other-blog', null)).toBeNull()
  })

  it('sees a blog from before sharing by its backup', async () => {
    r2.objects.set('_source/posts/rome.md', Buffer.from('x'))
    expect(await existingBlog(account.cf(), 'acct1', 'alice-blog', r2.asR2())).toBe('backup')
  })

  it('lets an interrupted setup run again', async () => {
    r2.objects.set('_setup-check/hello.txt', Buffer.from('ok'))
    expect(await existingBlog(account.cf(), 'acct1', 'alice-blog', r2.asR2())).toBeNull()
  })

  it('the REST client reads what the fake account stores', async () => {
    const old = await oldComputer()
    const { databaseId } = await runMigrate(old)
    const rest = new BlogDb(new RestD1(account.cf(), 'acct1', databaseId))
    expect((await rest.readBlog())!.title).toBe('Trips')
  })
})
