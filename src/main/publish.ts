/**
 * Publishing, and the source backup that replaces version control.
 *
 * There is no repository, so the markdown has no history and the owner's
 * machine is the only place a draft exists. `_source/` in their own bucket
 * fixes both: it is kilobytes, it lives in an account they own, and it makes
 * recovery on a new machine a matter of installing the app and signing in.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { CloudflareClient } from './cloudflare/api.js'
import { R2 } from './cloudflare/r2.js'
import { deploySite, waitForLive } from './cloudflare/deploy.js'
import { build, writePost, readPost, deletePost, listPosts, siteOverlay } from './site/hugo.js'
import { serializePost, referencedKeys } from '../shared/markdown.js'
import type { BlogConfig, Post } from '../shared/types.js'
import type { Library } from './db/library.js'
import type { MediaQueue } from './media/queue.js'

export interface PublishProgress {
  phase: 'waiting-for-photos' | 'building' | 'uploading' | 'deploying' | 'verifying' | 'done'
  detail?: string
  fraction?: number
}

export interface PublishResult {
  ok: boolean
  url: string
  /** Plain-language failure, safe to show the owner. */
  message?: string
  /** Verbose detail for the Copy report button. */
  log?: string
}

export async function publish(
  post: Post,
  deps: {
    config: BlogConfig
    cf: CloudflareClient
    r2: R2
    library: Library
    queue: MediaQueue
    siteDir: string
  },
  onProgress: (p: PublishProgress) => void,
): Promise<PublishResult> {
  const { config, cf, r2, library, queue, siteDir } = deps
  const postUrl = `${config.customDomain ? `https://${config.customDomain}` : config.siteUrl}/posts/${post.slug}/`

  // ---- 1. a post referencing media that has not landed would publish broken
  // images, so wait for the queue rather than racing it.
  const keys = new Set(referencedKeys(post.doc))
  if (post.frontMatter.cover) keys.add(post.frontMatter.cover)

  if (queue.pendingCount > 0) {
    onProgress({ phase: 'waiting-for-photos', detail: `${queue.pendingCount} still preparing` })
    await queue.idle()
  }
  await queue.flushUploads()

  const stuck = library.pending(keys)
  if (stuck.length) {
    const failed = stuck.filter((a) => a.state === 'failed')
    return {
      ok: false,
      url: postUrl,
      message: failed.length
        ? `${failed.length} photo${failed.length > 1 ? 's' : ''} could not be prepared, so this post is not published yet.`
        : `${stuck.length} photo${stuck.length > 1 ? 's' : ''} are still uploading. Try again in a moment.`,
      log: stuck.map((a) => `${a.key}: ${a.state}${a.error ? ` — ${a.error}` : ''}`).join('\n'),
    }
  }

  // ---- 2. write and build
  onProgress({ phase: 'building' })
  await writePost(siteDir, post)
  const built = await build(siteDir, { overlay: siteOverlay(config) })
  if (!built.ok) {
    return {
      ok: false,
      url: postUrl,
      message: "Something's wrong with this post and it can't be published yet.",
      log: built.log,
    }
  }

  // ---- 3. back up the source before deploying, so a failure later still
  // leaves the writing safe off-machine.
  onProgress({ phase: 'uploading', detail: 'backing up' })
  await backupSource(siteDir, r2).catch(() => {
    /* backup is best-effort; never block publishing on it */
  })

  // ---- 4. deploy, and 5. verify against the real URL
  return deployAndVerify(
    built.publicDir,
    { config, cf },
    postUrl,
    post.frontMatter.draft ? config.siteUrl : postUrl,
    onProgress,
  )
}

/**
 * Rebuild and redeploy the whole site with no post changed: what a site-wide
 * setting such as the password needs to take effect.
 */
export async function republishSite(
  deps: { config: BlogConfig; cf: CloudflareClient; siteDir: string },
  onProgress: (p: PublishProgress) => void,
): Promise<PublishResult> {
  const { config, siteDir } = deps
  const url = config.customDomain ? `https://${config.customDomain}/` : `${config.siteUrl}/`
  onProgress({ phase: 'building' })
  const built = await build(siteDir, { overlay: siteOverlay(config) })
  if (!built.ok) {
    return { ok: false, url, message: 'Your blog could not be rebuilt.', log: built.log }
  }
  return deployAndVerify(built.publicDir, deps, url, config.siteUrl, onProgress)
}

/**
 * Take a published post off the blog and keep it as a draft. Its media stays
 * in the bucket, so publishing it again is instant.
 */
export async function unpublishPost(
  post: Post,
  deps: { config: BlogConfig; cf: CloudflareClient; r2: R2; siteDir: string },
  onProgress: (p: PublishProgress) => void,
): Promise<PublishResult> {
  const draft: Post = { ...post, frontMatter: { ...post.frontMatter, draft: true } }
  await saveDraft(draft, deps.siteDir, deps.r2)
  const res = await republishSite(deps, onProgress)
  return res.ok
    ? res
    : {
        ...res,
        message:
          'The post is a draft again here, but your blog could not be updated just now. ' +
          'It will come off the next time you publish.',
      }
}

/**
 * Delete a post: the local file, its backup, and the page on the blog.
 *
 * With `media`, its photos and videos go from the bucket too, except any that
 * another post still shows. That happens only after the redeploy succeeds, so
 * a failed deploy never leaves a live page with broken images. The originals
 * stay on this computer either way. Dated backups in `_source/history/` are
 * kept, so a deleted post is still recoverable by hand.
 */
export async function removePost(
  slug: string,
  opts: { media: boolean },
  deps: { config: BlogConfig; cf: CloudflareClient; r2: R2; library: Library; siteDir: string },
  onProgress: (p: PublishProgress) => void,
): Promise<PublishResult & { mediaDeleted: number }> {
  const { r2, library, siteDir } = deps
  const post = await readPost(siteDir, slug)
  await deletePost(siteDir, slug)
  await r2.delete(`_source/posts/${slug}.md`).catch(() => {})

  if (post && !post.frontMatter.draft) {
    const res = await republishSite(deps, onProgress)
    if (!res.ok) {
      return {
        ...res,
        mediaDeleted: 0,
        message:
          'The post is deleted here, but your blog could not be updated just now. ' +
          'It will come off the next time you publish.',
      }
    }
  }

  let mediaDeleted = 0
  if (opts.media) {
    const stillShown = new Set<string>()
    for (const other of await listPosts(siteDir)) {
      for (const k of referencedKeys(other.doc)) stillShown.add(k)
      if (other.frontMatter.cover) stillShown.add(other.frontMatter.cover)
    }
    for (const asset of library.forPost(slug)) {
      if (stillShown.has(asset.key)) continue
      await r2.delete(asset.key).catch(() => {})
      await library.remove(asset.key)
      mediaDeleted++
    }
  }

  const config = deps.config
  return {
    ok: true,
    url: config.customDomain ? `https://${config.customDomain}/` : `${config.siteUrl}/`,
    mediaDeleted,
  }
}

async function deployAndVerify(
  publicDir: string,
  deps: { config: BlogConfig; cf: CloudflareClient },
  url: string,
  verifyUrl: string,
  onProgress: (p: PublishProgress) => void,
): Promise<PublishResult> {
  const { config, cf } = deps
  onProgress({ phase: 'deploying' })
  try {
    await deploySite(cf, {
      accountId: config.accountId,
      scriptName: config.name,
      bucket: config.bucket,
      publicDir,
      onProgress: (done, total) =>
        onProgress({ phase: 'deploying', fraction: total ? done / total : undefined }),
    })
  } catch (e) {
    const err = e as { status?: number; message?: string }
    return {
      ok: false,
      url,
      message:
        err.status === 403 || err.status === 401
          ? 'The app lost permission to your Cloudflare account.'
          : 'Your blog could not be published just now. Your work is saved.',
      log: err.message,
    }
  }

  // The real URL needs no extra credential to check.
  onProgress({ phase: 'verifying' })
  const live = await waitForLive(verifyUrl, { timeoutMs: 90_000 })

  onProgress({ phase: 'done' })
  return live
    ? { ok: true, url }
    : {
        ok: false,
        url,
        message:
          'Published, but the page is not answering yet. It usually appears within a minute.',
      }
}

/**
 * Mirror the markdown and config into the bucket.
 *
 * Also called on a timer for drafts: an unpublished post otherwise exists in
 * exactly one place, and a dead laptop takes it along.
 */
export async function backupSource(siteDir: string, r2: R2): Promise<number> {
  let count = 0
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  const config = await readFile(path.join(siteDir, 'hugo.yaml'), 'utf8')
  await r2.putText('_source/hugo.yaml', config)
  count++

  const postsDir = path.join(siteDir, 'content', 'posts')
  const names = (await readdir(postsDir).catch(() => [])).filter((n) => n.endsWith('.md'))
  for (const name of names) {
    const body = await readFile(path.join(postsDir, name), 'utf8')
    await r2.putText(`_source/posts/${name}`, body)
    // Keep a dated copy as well, so an accidental overwrite is recoverable.
    await r2.putText(`_source/history/${stamp}/${name}`, body)
    count += 2
  }
  return count
}

/** Pull the source back down — recovery on a new machine. */
export async function restoreSource(
  r2: R2,
  siteDir: string,
): Promise<{ posts: number }> {
  const objects = await r2.list('_source/posts/')
  let posts = 0
  for (const obj of objects) {
    const body = await r2.getText(obj.key)
    if (body === null) continue
    const name = path.basename(obj.key)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(path.join(siteDir, 'content', 'posts'), { recursive: true })
    await writeFile(path.join(siteDir, 'content', 'posts', name), body, 'utf8')
    posts++
  }
  return { posts }
}

/** Save a draft without publishing: local file plus the off-machine mirror. */
export async function saveDraft(
  post: Post,
  siteDir: string,
  r2: R2 | null,
): Promise<void> {
  await writePost(siteDir, post)
  if (!r2) return
  await r2.putText(`_source/posts/${post.slug}.md`, serializePost(post)).catch(() => {})
}

export async function allPosts(siteDir: string): Promise<Post[]> {
  return listPosts(siteDir)
}
