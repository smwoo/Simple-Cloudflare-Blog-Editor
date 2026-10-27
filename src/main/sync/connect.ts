/**
 * Pointing a new computer at a blog that already exists.
 *
 * The blog is found by what is in the owner's account — a database holding a
 * blog row — never by a name typed in, so a typo cannot create or overwrite
 * one. Connecting never deploys: the live site is untouched until the owner
 * publishes, by which time every post is here.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { CloudflareClient } from '../cloudflare/api.js'
import { RestD1, listDatabases, ensureDatabase, databaseName } from '../cloudflare/d1.js'
import { R2 } from '../cloudflare/r2.js'
import type { Library } from '../db/library.js'
import { scaffold, build, siteOverlay, writePostMarkdown } from '../site/hugo.js'
import { parsePost } from '../../shared/markdown.js'
import type { Asset, BlogConfig, Secrets } from '../../shared/types.js'
import { BlogDb } from './remote.js'
import { SCHEMA_VERSION } from './schema.js'
import { assetFromRemote } from './engine.js'
import { NewerDatabaseError, posterKey } from './migrate.js'

export interface FoundBlog {
  accountId: string
  accountName: string
  databaseId: string
  name: string
  title: string
  siteUrl: string
  customDomain?: string
  posts: number
  lastEditedAt?: number
  lastEditedOn?: string
  /** Made by a newer app; this one must be updated before it can connect. */
  needsUpdate: boolean
}

/** A blog from before sharing: its Worker and bucket exist, but no database yet. */
export interface UnmovedBlog {
  accountId: string
  accountName: string
  name: string
  bucket: string
}

export interface Factories {
  cf?: CloudflareClient
  openDb?: (accountId: string, databaseId: string) => BlogDb
  makeR2?: (accountId: string, keys: Pick<Secrets, 'r2AccessKeyId' | 'r2SecretAccessKey'>, bucket: string) => R2
}

const defaultDb = (cf: CloudflareClient) => (accountId: string, databaseId: string) =>
  new BlogDb(new RestD1(cf, accountId, databaseId))
const defaultR2: NonNullable<Factories['makeR2']> = (accountId, keys, bucket) => new R2(accountId, keys, bucket)

/** Every blog in every account the token can see. */
export async function findBlogs(
  cf: CloudflareClient,
  f: Factories = {},
): Promise<{ blogs: FoundBlog[]; unmoved: UnmovedBlog[] }> {
  const openDb = f.openDb ?? defaultDb(cf)
  const blogs: FoundBlog[] = []
  const unmoved: UnmovedBlog[] = []

  for (const account of await cf.listAccounts()) {
    const databases = await listDatabases(cf, account.id).catch(() => [])
    const found = await Promise.all(
      databases.map(async (d): Promise<FoundBlog | null> => {
        const db = openDb(account.id, d.uuid)
        const blog = await db.readBlog().catch(() => null)
        if (!blog) return null
        const [counts, last] = await Promise.all([
          db.counts().catch(() => ({ posts: 0, assets: 0 })),
          db.lastEdit().catch(() => null),
        ])
        return {
          accountId: account.id,
          accountName: account.name,
          databaseId: d.uuid,
          name: blog.name,
          title: blog.title,
          siteUrl: blog.siteUrl,
          customDomain: blog.customDomain,
          posts: counts.posts,
          lastEditedAt: last?.at,
          lastEditedOn: last?.machineName ?? undefined,
          needsUpdate: blog.schemaVersion > SCHEMA_VERSION,
        }
      }),
    )
    blogs.push(...found.filter((b): b is FoundBlog => b !== null))

    const buckets = await cf.listBuckets(account.id).catch(() => [])
    for (const { name: bucket } of buckets) {
      if (!bucket.endsWith('-media')) continue
      const name = bucket.slice(0, -'-media'.length)
      if (blogs.some((b) => b.accountId === account.id && b.name === name)) continue
      if (await cf.workerExists(account.id, name).catch(() => false)) {
        unmoved.push({ accountId: account.id, accountName: account.name, name, bucket })
      }
    }
  }
  return { blogs, unmoved }
}

export class KeysRejectedError extends Error {
  constructor() {
    super("Your blog's storage keys no longer work.")
  }
}

export class BuildFailedError extends Error {
  constructor(readonly log: string) {
    super('The blog could not be built on this computer.')
  }
}

export interface Connected {
  config: BlogConfig
  secrets: Secrets
  db: BlogDb
  versions: Record<string, number>
  blogUpdatedAt: number
  at: number
  posts: number
  assets: number
}

/**
 * Bring a blog to this computer: settings and keys from the database, every
 * post into the site folder, and the photo list. Media stays where it is and
 * is shown from the blog. Safe to run again after an interruption.
 */
export async function connectBlog(
  args: {
    token: string
    accountId: string
    databaseId: string
    siteDir: string
    library: Library
    /** Storage keys typed in because the saved ones were rejected. */
    keys?: Pick<Secrets, 'r2AccessKeyId' | 'r2SecretAccessKey'>
    onProgress?: (detail: string) => void
    /** Replaced in tests, where there may be no Hugo. */
    check?: (siteDir: string, config: BlogConfig) => Promise<void>
  },
  f: Factories = {},
): Promise<Connected> {
  const cf = f.cf ?? new CloudflareClient(args.token)
  const progress = args.onProgress ?? (() => {})
  const db = (f.openDb ?? defaultDb(cf))(args.accountId, args.databaseId)
  const makeR2 = f.makeR2 ?? defaultR2

  progress('Reading your blog')
  const blog = await db.readBlog()
  if (!blog) throw new Error('That database is not a blog.')
  if (blog.schemaVersion > SCHEMA_VERSION) throw new NewerDatabaseError()

  const keys = args.keys ?? { r2AccessKeyId: blog.r2AccessKeyId, r2SecretAccessKey: blog.r2Secret }
  try {
    await makeR2(args.accountId, keys, blog.bucket).sample('', 1)
  } catch {
    throw new KeysRejectedError()
  }
  // New keys typed here fix the blog for every computer.
  if (args.keys) await db.updateBlog({ r2AccessKeyId: keys.r2AccessKeyId, r2Secret: keys.r2SecretAccessKey })

  const config: BlogConfig = {
    accountId: args.accountId,
    name: blog.name,
    bucket: blog.bucket,
    siteUrl: blog.siteUrl,
    title: blog.title,
    author: blog.author,
    databaseId: args.databaseId,
    ...(blog.customDomain ? { customDomain: blog.customDomain } : {}),
    ...(blog.sitePassword ? { sitePassword: blog.sitePassword } : {}),
  }

  progress('Setting up the blog on this computer')
  // Whatever an earlier attempt left is replaced, never mixed in.
  await rm(path.join(args.siteDir, 'content', 'posts'), { recursive: true, force: true })
  await scaffold(args.siteDir, config)

  progress('Copying posts')
  const versions: Record<string, number> = {}
  let posts = 0
  for (const p of await db.postsSince(0)) {
    if (p.deletedAt) continue
    await writePostMarkdown(args.siteDir, p.slug, p.markdown)
    versions[p.slug] = p.version
    posts++
  }

  progress('Copying the photo list')
  const assets = (await db.assetsSince(0)).filter((a) => !a.deletedAt).map((a) => assetFromRemote(a))
  await args.library.replaceAll(assets)

  progress('Checking the blog builds')
  await (args.check ?? checkBuild)(args.siteDir, config)

  const at = await db.now()
  return {
    config,
    secrets: { cloudflareToken: args.token, ...keys },
    db,
    versions,
    blogUpdatedAt: blog.updatedAt,
    at,
    posts,
    assets: assets.length,
  }
}

async function checkBuild(siteDir: string, config: BlogConfig): Promise<void> {
  const built = await build(siteDir, { overlay: siteOverlay(config) })
  if (!built.ok) throw new BuildFailedError(built.log)
}

// ---------------------------------------------------------------- recovery

const MEDIA_KIND: Record<string, Asset['kind']> = { '.avif': 'image', '.mp4': 'video' }

/**
 * Rebuild the database for a blog that was never moved, from what the bucket
 * holds: the `_source/` copies of posts and the media itself. For when the
 * original computer is gone. The site password was never backed up, so a
 * blog that had one needs it set again.
 */
export async function recoverUnmoved(
  args: {
    token: string
    blog: UnmovedBlog
    keys: Pick<Secrets, 'r2AccessKeyId' | 'r2SecretAccessKey'>
    machineId: string
    onProgress?: (detail: string) => void
  },
  f: Factories = {},
): Promise<{ databaseId: string }> {
  const cf = f.cf ?? new CloudflareClient(args.token)
  const { accountId, name, bucket } = args.blog
  const progress = args.onProgress ?? (() => {})
  const r2 = (f.makeR2 ?? defaultR2)(accountId, args.keys, bucket)
  try {
    await r2.sample('', 1)
  } catch {
    throw new KeysRejectedError()
  }

  progress('Reading the backup')
  const hugoYaml = (await r2.getText('_source/hugo.yaml')) ?? ''
  const yamlValue = (re: RegExp) => re.exec(hugoYaml)?.[1]?.replace(/\\"/g, '"')
  const title = yamlValue(/^title:\s*"(.*)"\s*$/m) ?? name
  const author = yamlValue(/^\s+author:\s*"(.*)"\s*$/m) ?? title
  const baseHost = /^baseURL:\s*"https?:\/\/([^/"]+)/m.exec(hugoYaml)?.[1]

  const subdomain = await cf.getWorkersSubdomain(accountId)
  const siteUrl = `https://${name}.${subdomain}.workers.dev`
  const attached = (await cf.listCustomDomains(accountId).catch(() => []))
    .filter((d) => d.service === name)
    .map((d) => d.hostname)
  const customDomain =
    baseHost && attached.includes(baseHost) ? baseHost : attached.find((h) => !h.startsWith('www.'))

  const database = await ensureDatabase(cf, accountId, databaseName(name))
  const db = (f.openDb ?? defaultDb(cf))(accountId, database.uuid)
  await db.applySchema()
  // Someone recovered it already: connect to what is there.
  if (await db.readBlog()) return { databaseId: database.uuid }

  const objects = await r2.list('')
  progress('Copying posts')
  for (const obj of objects.filter((o) => /^_source\/posts\/[^/]+\.md$/.test(o.key))) {
    const markdown = await r2.getText(obj.key)
    if (markdown === null) continue
    const slug = path.basename(obj.key, '.md')
    const { frontMatter } = parsePost(slug, markdown)
    await db.forcePost(
      { slug, title: frontMatter.title, date: frontMatter.date, draft: frontMatter.draft, markdown },
      args.machineId,
    )
  }

  progress('Listing photos')
  const keys = new Set(objects.map((o) => o.key))
  for (const obj of objects) {
    const kind = MEDIA_KIND[path.extname(obj.key).toLowerCase()]
    const [postSlug, group] = obj.key.split('/')
    if (!kind || obj.key.startsWith('_') || !group) continue
    await db.putAsset(
      {
        key: obj.key,
        kind,
        postSlug,
        group,
        state: 'live',
        originalPath: '',
        bytesOriginal: 0,
        bytesOutput: obj.size,
        createdAt: Date.now(),
        originalAvailable: false,
        hasPoster: keys.has(posterKey(obj.key)),
      },
      args.machineId,
    )
  }

  // Written last, as in setup: its presence marks the recovery finished.
  await db.writeBlog({
    name,
    title,
    author,
    siteUrl,
    customDomain,
    bucket,
    r2AccessKeyId: args.keys.r2AccessKeyId,
    r2Secret: args.keys.r2SecretAccessKey,
  })
  return { databaseId: database.uuid }
}
