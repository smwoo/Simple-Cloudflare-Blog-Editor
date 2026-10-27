/**
 * Provisioning a blog in the owner's own Cloudflare account.
 *
 * Every step is idempotent: re-running adopts resources that already exist
 * rather than failing on a name collision. A helper who can re-run a step is
 * unblocked; a helper who has to clean up half-created resources by hand is not.
 *
 * Steps 7 and 8 are the ones that matter. Everything before them can succeed
 * while the site is still broken.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { CloudflareClient } from './cloudflare/api.js'
import { R2 } from './cloudflare/r2.js'
import { RestD1, listDatabases, ensureDatabase, databaseName } from './cloudflare/d1.js'
import { BlogDb } from './sync/remote.js'
import { deploySite, waitForLive } from './cloudflare/deploy.js'
import { scaffold, build, checkHugo, siteOverlay } from './site/hugo.js'
import { assertFfmpegVersion } from './media/ffmpeg.js'
import type { BlogConfig, Secrets } from '../shared/types.js'

export interface SetupInput {
  cloudflareToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  /** Worker and bucket name, e.g. `alice-blog`. Lowercase, dashes. */
  name: string
  title: string
  author: string
  /** Claimed if the account has no workers.dev subdomain yet. */
  preferredSubdomain?: string
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface Step {
  id: string
  label: string
  status: StepStatus
  detail?: string
  /** Plain-language cause and the exact remedy, when it fails. */
  remedy?: string
}

export type OnStep = (steps: Step[]) => void

/** Thrown when the name belongs to a blog that is already running. */
export const EXISTING_BLOG = 'existing-blog'

/**
 * Whether `name` is a blog someone already uses: a finished setup writes the
 * database row last, and any saved post leaves a backup in the bucket. An
 * interrupted setup leaves neither, so re-running one still adopts its
 * half-made resources as before.
 */
export async function existingBlog(
  cf: CloudflareClient,
  accountId: string,
  name: string,
  r2: R2 | null,
): Promise<'database' | 'backup' | null> {
  const found = (await listDatabases(cf, accountId)).find((d) => d.name === databaseName(name))
  if (found && (await new BlogDb(new RestD1(cf, accountId, found.uuid)).readBlog())) return 'database'
  if (r2 && (await r2.sample('_source/posts/', 1)).length) return 'backup'
  return null
}

export function welcomeMarkdown(date = new Date().toISOString().slice(0, 10)): string {
  return [
    '---',
    `date: '${date}'`,
    'draft: false',
    "title: 'Welcome'",
    "description: 'Your blog is ready'",
    '---',
    '',
    `## Your blog is live`,
    '',
    'This post was created automatically. Edit it or delete it — whatever you like.',
    '',
  ].join('\n')
}

const PROBE_KEY = '_setup-check/probe.avif'
// 1x1 AVIF, enough to prove PutObject, the Worker binding and the cache header.
const PROBE_AVIF = Buffer.from(
  'AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABcAAABDaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKCBgABogQEDQgMgkQAAAAFAAAAAAA',
  'base64',
)

function step(id: string, label: string): Step {
  return { id, label, status: 'pending' }
}

export async function provision(
  input: SetupInput,
  dataDir: string,
  onStep: OnStep,
  machineId: string,
): Promise<{ config: BlogConfig; secrets: Secrets }> {
  const steps: Step[] = [
    step('tools', 'Checking the bundled tools'),
    step('token', 'Checking your Cloudflare permission'),
    step('subdomain', 'Finding your web address'),
    step('bucket', 'Creating photo storage'),
    step('scaffold', 'Creating your blog'),
    step('build', 'Building it'),
    step('deploy', 'Publishing it'),
    step('live', 'Waiting for it to go live'),
    step('media', 'Checking photos work'),
    step('db', 'Saving your blog so other computers can use it'),
  ]
  const emit = () => onStep(steps.map((s) => ({ ...s })))
  const set = (id: string, patch: Partial<Step>) => {
    const s = steps.find((x) => x.id === id)!
    Object.assign(s, patch)
    emit()
  }

  emit()
  const cf = new CloudflareClient(input.cloudflareToken)

  // ---- 1. bundled tools
  set('tools', { status: 'running' })
  const hugo = await checkHugo()
  const ffmpeg = await assertFfmpegVersion()
  if (!hugo.ok) {
    set('tools', {
      status: 'failed',
      remedy: 'The bundled site builder is missing. Reinstall the app.',
    })
    throw new Error('hugo missing')
  }
  if (!ffmpeg.ok) {
    set('tools', {
      status: 'failed',
      detail: `ffmpeg ${ffmpeg.version}`,
      remedy:
        'The bundled video tool is too old (version 8 or newer is required). ' +
        'This is a packaging fault, not a problem with your computer — reinstall the app.',
    })
    throw new Error('ffmpeg too old')
  }
  set('tools', { status: 'done', detail: `Hugo ${hugo.version}, ffmpeg ${ffmpeg.version}` })

  // ---- 2. token
  set('token', { status: 'running' })
  const check = await cf.checkToken()
  if (!check.ok) {
    set('token', {
      status: 'failed',
      detail: check.error,
      remedy: check.looksLikeGlobalKey
        ? 'Create a scoped API token instead of using the Global API Key.'
        : check.missing.length
          ? `The token is missing: ${check.missing.join(', ')}. Add these permissions and try again.`
          : 'Check the token was copied whole and has not expired.',
    })
    throw new Error(check.error ?? 'token rejected')
  }
  const accountId = check.accountId!
  set('token', { status: 'done', detail: check.accountName })

  // ---- 3. workers.dev subdomain
  set('subdomain', { status: 'running' })
  let subdomain = await cf.getWorkersSubdomain(accountId)
  if (!subdomain) {
    const wanted = (input.preferredSubdomain ?? input.name).toLowerCase()
    try {
      await cf.claimWorkersSubdomain(accountId, wanted)
      subdomain = wanted
    } catch (e) {
      set('subdomain', {
        status: 'failed',
        remedy: `The web address "${wanted}.workers.dev" is taken. Pick a different name.`,
      })
      throw e
    }
  }
  const siteUrl = `https://${input.name}.${subdomain}.workers.dev`
  set('subdomain', { status: 'done', detail: siteUrl })

  // ---- 4. bucket
  set('bucket', { status: 'running' })
  const bucket = `${input.name}-media`
  try {
    await cf.createBucket(accountId, bucket)
  } catch (e) {
    set('bucket', {
      status: 'failed',
      remedy:
        'The token could not create storage. Check it has the "Workers R2 Storage — Edit" permission.',
    })
    throw e
  }

  const r2 = new R2(accountId, input, bucket)
  try {
    await r2.putText('_setup-check/hello.txt', 'ok')
  } catch (e) {
    set('bucket', {
      status: 'failed',
      remedy:
        'The storage keys were not accepted. These are the Access Key ID and Secret ' +
        'shown once when you created the R2 API token — not the Cloudflare API token.',
    })
    throw e
  }

  // Deploying below replaces the whole site. Over a blog already in use, that
  // would leave its owner with one Welcome post, so stop and offer Connect.
  let inUse: Awaited<ReturnType<typeof existingBlog>> = null
  try {
    inUse = await existingBlog(cf, accountId, input.name, r2)
  } catch (e) {
    set('bucket', {
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
      remedy: 'Check the token has the "D1 — Edit" permission, then try again.',
    })
    throw e
  }
  if (inUse) {
    set('bucket', {
      status: 'failed',
      detail: `A blog called "${input.name}" already exists in this Cloudflare account.`,
      remedy:
        'To use it on this computer, go back and choose "I already have a blog". ' +
        'To make a separate blog, pick a different short name.',
    })
    throw new Error(EXISTING_BLOG)
  }
  set('bucket', { status: 'done', detail: bucket })

  const config: BlogConfig = {
    accountId,
    name: input.name,
    bucket,
    siteUrl,
    title: input.title,
    author: input.author,
  }

  // ---- 5. scaffold
  set('scaffold', { status: 'running' })
  const siteDir = path.join(dataDir, 'site')
  await scaffold(siteDir, config)
  await mkdir(path.join(siteDir, 'content', 'posts'), { recursive: true })
  const welcome = welcomeMarkdown()
  await writeFile(path.join(siteDir, 'content', 'posts', 'welcome.md'), welcome, 'utf8')
  set('scaffold', { status: 'done' })

  // ---- 6. build
  set('build', { status: 'running' })
  const built = await build(siteDir, { overlay: siteOverlay(config) })
  if (!built.ok) {
    set('build', { status: 'failed', detail: built.log, remedy: 'Send this report to whoever set up your blog.' })
    throw new Error('hugo build failed')
  }
  set('build', { status: 'done', detail: `${built.durationMs}ms` })

  // ---- 7. deploy
  set('deploy', { status: 'running' })
  try {
    const res = await deploySite(cf, {
      accountId,
      scriptName: input.name,
      bucket,
      publicDir: built.publicDir,
      onProgress: (done, total) => set('deploy', { detail: `${done}/${total} files` }),
    })
    set('deploy', { status: 'done', detail: `${res.uploaded} uploaded` })
  } catch (e) {
    set('deploy', {
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
      remedy:
        (e as { status?: number }).status === 401 || (e as { status?: number }).status === 403
          ? 'Check the token has the "Workers Scripts — Edit" permission.'
          : 'Publishing failed. Run setup again; if it keeps failing, send the detail above to whoever is maintaining the app.',
    })
    throw e
  }

  // ---- 8. live
  set('live', { status: 'running' })
  const live = await waitForLive(siteUrl, { timeoutMs: 120_000 })
  if (!live) {
    set('live', {
      status: 'failed',
      remedy:
        'The blog was published but is not answering yet. This is usually temporary — ' +
        'wait a minute and run the check again from Settings.',
    })
    throw new Error('site did not go live')
  }
  set('live', { status: 'done' })

  // ---- 9. media through the Worker
  // The step that proves the R2 binding, not just that the bucket exists.
  set('media', { status: 'running' })
  const probePath = path.join(dataDir, 'cache', 'probe.avif')
  await mkdir(path.dirname(probePath), { recursive: true })
  await writeFile(probePath, PROBE_AVIF)
  await r2.putFile(PROBE_KEY, probePath).catch(() => {})

  const probeUrl = `${siteUrl}/media/${PROBE_KEY}`
  let mediaOk = false
  for (let i = 0; i < 10 && !mediaOk; i++) {
    try {
      const res = await fetch(probeUrl)
      if (res.ok && /image\/avif/.test(res.headers.get('content-type') ?? '')) {
        mediaOk = /immutable/.test(res.headers.get('cache-control') ?? '')
      }
    } catch {
      /* not ready */
    }
    if (!mediaOk) await new Promise((r) => setTimeout(r, 2000))
  }
  if (!mediaOk) {
    set('media', {
      status: 'failed',
      remedy:
        'Photos are not being served. The blog is published but its storage is not ' +
        'connected — send this report to whoever set it up.',
    })
    throw new Error('media path not working')
  }
  await r2.delete(PROBE_KEY).catch(() => {})
  set('media', { status: 'done' })

  // ---- 10. the shared database. The blog row goes last: its presence is
  // what marks this name as a finished blog (see existingBlog).
  set('db', { status: 'running' })
  try {
    const database = await ensureDatabase(cf, accountId, databaseName(input.name))
    const db = new BlogDb(new RestD1(cf, accountId, database.uuid))
    await db.applySchema()
    await db.forcePost(
      { slug: 'welcome', title: 'Welcome', date: welcome.match(/date: '(.*)'/)![1], draft: false, markdown: welcome },
      machineId,
    )
    await db.writeBlog({
      name: input.name,
      title: input.title,
      author: input.author,
      siteUrl,
      bucket,
      r2AccessKeyId: input.r2AccessKeyId,
      r2Secret: input.r2SecretAccessKey,
    })
    config.databaseId = database.uuid
  } catch (e) {
    set('db', {
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
      remedy: 'Check the token has the "D1 — Edit" permission, then run setup again.',
    })
    throw e
  }
  set('db', { status: 'done' })

  return {
    config,
    secrets: {
      cloudflareToken: input.cloudflareToken,
      r2AccessKeyId: input.r2AccessKeyId,
      r2SecretAccessKey: input.r2SecretAccessKey,
    },
  }
}
