/**
 * Moving a blog from before sharing into the shared database. Runs once, on
 * the computer that has the blog, the first time the token allows D1.
 *
 * The local files are the truth here, not the `_source/` backup: they include
 * drafts saved while offline and the settings the backup never held. Every
 * step can run again, so an interrupted migration finishes on the next launch.
 * `_source/` is only deleted once the database holds everything.
 */
import { existsSync } from 'node:fs'
import type { CloudflareClient } from '../cloudflare/api.js'
import { RestD1, ensureDatabase, databaseName } from '../cloudflare/d1.js'
import type { R2 } from '../cloudflare/r2.js'
import type { Library } from '../db/library.js'
import { listPosts, readPostMarkdown } from '../site/hugo.js'
import { parsePost } from '../../shared/markdown.js'
import type { BlogConfig, Secrets } from '../../shared/types.js'
import { BlogDb } from './remote.js'
import { SCHEMA_VERSION } from './schema.js'

export const posterKey = (key: string) => `${key}.poster.jpg`

export interface MigrateResult {
  databaseId: string
  db: BlogDb
  versions: Record<string, number>
  blogUpdatedAt: number
  at: number
  posts: number
  assets: number
}

export class NewerDatabaseError extends Error {
  constructor() {
    super('The blog was moved by a newer version of Blog Editor. Update this one first.')
  }
}

export async function migrate(deps: {
  cf: CloudflareClient
  config: BlogConfig
  secrets: Secrets
  library: Library
  siteDir: string
  r2: R2
  machineId: string
  /** Swap in a fake for tests. */
  openDb?: (databaseId: string) => BlogDb
  onProgress?: (detail: string) => void
}): Promise<MigrateResult> {
  const { cf, config, secrets, library, siteDir, r2, machineId } = deps
  const progress = deps.onProgress ?? (() => {})

  progress('Creating the database')
  const database = await ensureDatabase(cf, config.accountId, databaseName(config.name))
  const db = deps.openDb?.(database.uuid) ?? new BlogDb(new RestD1(cf, config.accountId, database.uuid))
  await db.applySchema()
  const before = await db.readBlog()
  if (before && before.schemaVersion > SCHEMA_VERSION) throw new NewerDatabaseError()

  await db.writeBlog({
    name: config.name,
    title: config.title,
    author: config.author,
    siteUrl: config.siteUrl,
    customDomain: config.customDomain,
    sitePassword: config.sitePassword,
    bucket: config.bucket,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2Secret: secrets.r2SecretAccessKey,
  })

  progress('Copying posts')
  const versions: Record<string, number> = {}
  const posts = await listPosts(siteDir)
  for (const post of posts) {
    const markdown = (await readPostMarkdown(siteDir, post.slug))!
    const { frontMatter } = parsePost(post.slug, markdown)
    versions[post.slug] = await db.forcePost(
      { slug: post.slug, title: frontMatter.title, date: frontMatter.date, draft: frontMatter.draft, markdown },
      machineId,
    )
  }

  // Only live assets are shared; the queue sends the rest as they go live.
  const live = library.all().filter((a) => a.state === 'live')
  let n = 0
  for (const asset of live) {
    progress(`Copying the photo list (${++n} of ${live.length})`)
    // Poster frames let other computers show a video without downloading it.
    if (asset.kind === 'video' && !asset.hasPoster && asset.posterPath && existsSync(asset.posterPath)) {
      await r2.putFile(posterKey(asset.key), asset.posterPath)
      await library.update(asset.key, { hasPoster: true })
    }
    await db.putAsset(library.get(asset.key)!, machineId)
  }

  progress('Checking everything arrived')
  const counts = await db.counts()
  if (counts.posts < posts.length || counts.assets < live.length) {
    throw new Error(
      `The database has ${counts.posts} of ${posts.length} posts and ${counts.assets} of ` +
        `${live.length} photos. Nothing was removed; it will try again.`,
    )
  }

  // The backup's job is done, and its dated copies are what grows the bucket.
  progress('Tidying up the old backup')
  for (const obj of await r2.list('_source/')) await r2.delete(obj.key)

  const blog = (await db.readBlog())!
  return {
    databaseId: database.uuid,
    db,
    versions,
    blogUpdatedAt: blog.updatedAt,
    at: await db.now(),
    posts: posts.length,
    assets: live.length,
  }
}
