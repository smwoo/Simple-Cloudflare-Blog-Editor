import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, net, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { Store } from './db/store.js'
import { Library } from './db/library.js'
import { MediaQueue } from './media/queue.js'
import { DEFAULT_SETTINGS, allocateKey, kindOf } from './media/pipeline.js'
import { assertFfmpegVersion } from './media/ffmpeg.js'
import { CloudflareClient, CloudflareError } from './cloudflare/api.js'
import { R2 } from './cloudflare/r2.js'
import { RestD1, listDatabases } from './cloudflare/d1.js'
import { createFetchHandler } from './cloudflare/fetchHandler.js'
import {
  findCommentsDatabase,
  ensureCommentsDatabase,
  listComments,
  deleteComment,
  deletePostComments,
} from './cloudflare/comments.js'
import {
  EMAIL,
  MAX_EMAIL,
  isOpen,
  setOpen,
  listSubscribers,
  countSubscribers,
  addSubscriber,
  removeSubscriber,
  listMailings,
  getMailing,
  announcedPosts,
  forgetPost,
  createMailing,
  type Mailing,
} from './cloudflare/newsletter.js'
import { ResendMailer, MailError, renderEmail, type Mailer } from './newsletter/mail.js'
import { sendMailing, type SendResult } from './newsletter/send.js'
import { readSender, writeSender, type SenderSettings } from './newsletter/settings.js'
import { provision, EXISTING_BLOG, type SetupInput } from './setup.js'
import {
  publish,
  republishSite,
  unpublishPost,
  removePost as removePostEverywhere,
  saveDraft,
  type PublishResult,
} from './publish.js'
import { BlogDb } from './sync/remote.js'
import { SyncEngine, ensureState, type Conflict } from './sync/engine.js'
import { migrate, NewerDatabaseError } from './sync/migrate.js'
import {
  findBlogs,
  connectBlog,
  recoverUnmoved,
  KeysRejectedError,
  BuildFailedError,
  type UnmovedBlog,
} from './sync/connect.js'
import { attachDomain, registrarUrl, listBlogDomains, removeDomain } from './domain.js'
import { initUpdater, updateState } from './updater.js'
import {
  listPosts,
  readPost,
  deletePost as removePost,
  build,
  checkHugo,
  PreviewServer,
  scaffold,
  syncTemplate,
  setBaseUrl,
} from './site/hugo.js'
import { referencedKeys } from '../shared/markdown.js'
import { requestDisconnect, applyPendingDisconnect } from './disconnect.js'
import { posterKey, type Post, type BlogConfig, type Asset, type Secrets } from '../shared/types.js'

// A separate data folder: a smoke run that must not touch the real blog, or
// a second "computer" on the same machine when trying out sharing.
if (process.env.BLOG_EDITOR_USER_DATA) app.setPath('userData', process.env.BLOG_EDITOR_USER_DATA)

// ---------------------------------------------------------------- state

let win: BrowserWindow | null = null
let store: Store
let library: Library
let queue: MediaQueue
let config: BlogConfig | null = null
let cf: CloudflareClient | null = null
let r2: R2 | null = null
const preview = new PreviewServer()

/** Sharing with other computers: null until the blog has a database. */
let sync: SyncEngine | null = null
/**
 * Moving a blog from before sharing into its database.
 * `needs-permission`: the token lacks D1; the owner adds it, then checks again.
 */
type MigrationState = 'not-needed' | 'needs-permission' | 'running' | 'failed' | 'done'
let migration: { state: MigrationState; message?: string } = { state: 'not-needed' }
let presence: string[] = []
/** The last pull failed: shown so "Saved" is not mistaken for "shared". */
let offline = false

const dataDir = () => path.join(app.getPath('userData'), 'blog')
const statePath = () => path.join(dataDir(), 'sync.json')

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload)
}

/** Rebuild the Cloudflare clients from stored config + secrets. */
async function connect(): Promise<void> {
  config = await store.readConfig()
  const secrets = await store.readSecrets()
  commentsDbId = null
  newsletterReady = false
  if (!config || !secrets) {
    cf = null
    r2 = null
    sync = null
    return
  }
  cf = new CloudflareClient(secrets.cloudflareToken)
  r2 = new R2(config.accountId, secrets, config.bucket)
  sync = config.databaseId
    ? await SyncEngine.open(new BlogDb(new RestD1(cf, config.accountId, config.databaseId)), {
        siteDir: store.paths().site,
        library,
        statePath: statePath(),
      })
    : null
}

/**
 * The comments database, or null before any deploy has made it. Looked up by
 * name rather than stored, so every computer finds it with no setup.
 */
let commentsDbId: string | null = null
async function commentsDb(): Promise<RestD1 | null> {
  if (!cf || !config) return null
  commentsDbId ??= await findCommentsDatabase(cf, config.accountId, config.name)
  return commentsDbId ? new RestD1(cf, config.accountId, commentsDbId) : null
}

/**
 * The same database for the newsletter, made now if no deploy has made it yet,
 * with its tables brought up to date once per session: the owner can set up
 * the newsletter on a blog that has not been published since it existed.
 */
let newsletterReady = false
async function newsletterDb(): Promise<RestD1> {
  if (!cf || !config) throw new Error('not set up')
  if (!newsletterReady || !commentsDbId) {
    commentsDbId = await ensureCommentsDatabase(cf, config.accountId, config.name)
    newsletterReady = true
  }
  return new RestD1(cf, config.accountId, commentsDbId)
}

/** The shared database, where the newsletter's sending settings live. */
function sharedDb(): RestD1 | null {
  return cf && config?.databaseId ? new RestD1(cf, config.accountId, config.databaseId) : null
}

function siteOrigin(): string | null {
  if (!config) return null
  return config.customDomain ? `https://${config.customDomain}` : config.siteUrl
}

async function newsletterMailer(): Promise<{ mailer: Mailer; sender: SenderSettings } | { message: string }> {
  const shared = sharedDb()
  if (!cf || !config || !shared) return { message: 'This blog is not set up yet.' }
  const sender = await readSender(shared).catch(() => null)
  if (!sender) return { message: 'Set up sending with Resend first.' }
  return { mailer: new ResendMailer(sender.resendKey, sender), sender }
}

/** Whether the Worker online is new enough to take subscriptions. */
async function workerHasSubscribe(): Promise<boolean> {
  try {
    const res = await fetch(`${siteOrigin()}/api/subscribe`, { headers: { accept: 'application/json' } })
    return res.ok && typeof ((await res.json()) as any)?.open === 'boolean'
  } catch {
    return false
  }
}

/** One mailing at a time: two at once would race for the same subscribers. */
let sendingId: number | null = null

async function runMailing(make: (db: RestD1) => Promise<Mailing>): Promise<SendResult | { ok: false; message: string; log?: string }> {
  if (sendingId !== null) return { ok: false, message: 'An email is already being sent. Wait for it to finish.' }
  const m = await newsletterMailer()
  if ('message' in m) return { ok: false, message: m.message }
  const origin = siteOrigin()!
  const blogTitle = config!.title
  let db: RestD1
  let mailing: Mailing
  try {
    db = await newsletterDb()
    mailing = await make(db)
  } catch (e) {
    return { ok: false, message: 'The newsletter could not be reached just now.', log: String(e) }
  }
  sendingId = mailing.id
  try {
    const content = {
      blogTitle,
      subject: mailing.subject,
      body: mailing.body,
      link: mailing.link,
      linkLabel: mailing.post ? 'Read the post' : undefined,
    }
    return await sendMailing(
      db,
      m.mailer,
      mailing.id,
      (s) => renderEmail(content, s.email, `${origin}/api/unsubscribe?t=${s.token}`),
      (p) => send('newsletter:progress', p),
    )
  } catch (e) {
    return { ok: false, message: 'Sending stopped: the newsletter could not be reached.', log: String(e) }
  } finally {
    sendingId = null
  }
}

function syncStatus() {
  return {
    shared: !!sync,
    migration,
    machineName: sync?.machineName,
    others: presence,
    pending: sync?.pending ?? 0,
    offline,
  }
}

const pushStatus = () => send('sync:status', syncStatus())

// ---------------------------------------------------------------- sync

/**
 * Send unsent work. Never throws: offline is normal, and the work waits in
 * sync.json. Conflicts are told to the writer, who now has both versions.
 */
async function flushSync(): Promise<Conflict[]> {
  if (!sync) return []
  try {
    const conflicts = await sync.flush()
    offline = false
    if (conflicts.length) send('sync:conflict', conflicts)
    return conflicts
  } catch {
    offline = true
    return []
  } finally {
    pushStatus()
  }
}

/** Bring in other computers' changes and tell the editor which posts moved. */
async function pullSync(): Promise<boolean> {
  if (!sync) return false
  try {
    const res = await sync.pull()
    offline = false
    if (res.blog) await applyBlogSettings(res.blog)
    if (res.posts.length || res.assets) send('sync:changed', { posts: res.posts, assets: res.assets })
    return true
  } catch {
    offline = true
    return false
  } finally {
    pushStatus()
  }
}

/** Settings changed on another computer: the address, password or storage keys. */
async function applyBlogSettings(blog: Awaited<ReturnType<BlogDb['readBlog']>> & object) {
  if (!config) return
  const next: BlogConfig = { ...config }
  delete next.customDomain
  delete next.sitePassword
  if (blog.customDomain) next.customDomain = blog.customDomain
  if (blog.sitePassword) next.sitePassword = blog.sitePassword
  const domainChanged = next.customDomain !== config.customDomain
  config = next
  await store.writeConfig(config)
  if (domainChanged) await setBaseUrl(store.paths().site, siteOrigin()!)

  const secrets = await store.readSecrets()
  if (
    secrets &&
    (secrets.r2AccessKeyId !== blog.r2AccessKeyId || secrets.r2SecretAccessKey !== blog.r2Secret)
  ) {
    const updated: Secrets = { ...secrets, r2AccessKeyId: blog.r2AccessKeyId, r2SecretAccessKey: blog.r2Secret }
    await store.writeSecrets(updated)
    r2 = new R2(config.accountId, updated, config.bucket)
  }
}

/** Share a site-wide setting; the next pull elsewhere applies it. */
async function shareSettings(patch: Parameters<BlogDb['updateBlog']>[0]) {
  if (!sync) return
  await sync.db.updateBlog(patch).catch(() => {
    /* the next change sends the whole state again; not worth failing the action */
  })
}

async function heartbeat() {
  if (!sync) return
  try {
    presence = await sync.heartbeat({ platform: process.platform, appVersion: app.getVersion() })
  } catch {
    /* offline: keep the last answer */
  }
  pushStatus()
}

/**
 * A blog from before sharing moves into its database here, once the token
 * allows D1. Until then everything works as before, on this computer only.
 */
async function tryMigrate(): Promise<void> {
  if (!config || config.databaseId || !cf || !r2 || migration.state === 'running') return
  const secrets = await store.readSecrets()
  if (!secrets) return
  try {
    await listDatabases(cf, config.accountId)
  } catch (e) {
    const status = (e as CloudflareError).status
    migration =
      status === 401 || status === 403
        ? { state: 'needs-permission' }
        : { state: 'failed', message: 'Could not reach Cloudflare. It will try again next time.' }
    pushStatus()
    return
  }

  migration = { state: 'running', message: 'Getting your blog ready for other computers…' }
  pushStatus()
  try {
    const identity = await ensureState(statePath())
    const res = await migrate({
      cf,
      config,
      secrets,
      library,
      siteDir: store.paths().site,
      r2,
      machineId: identity.machineId,
      onProgress: (detail) => {
        migration = { state: 'running', message: detail }
        pushStatus()
      },
    })
    config = { ...config, databaseId: res.databaseId }
    await store.writeConfig(config)
    await connect()
    await sync!.adopt(res.versions, res.blogUpdatedAt, res.at)
    migration = { state: 'done' }
    await heartbeat()
  } catch (e) {
    migration = {
      state: 'failed',
      message:
        e instanceof NewerDatabaseError
          ? e.message
          : `Could not finish getting your blog ready for other computers: ${e instanceof Error ? e.message : String(e)}. Nothing was lost; it will try again next time.`,
    }
  }
  pushStatus()
}

/**
 * Before anything that redeploys: send this computer's work and bring in
 * everyone else's. A deploy replaces the whole site, so it must be built from
 * every post, not just the ones this computer has.
 */
async function readyToDeploy(post?: Post): Promise<PublishResult | null> {
  if (!sync) return null
  const url = siteOrigin() ?? ''
  if (post) {
    await writePostLocal(post)
    await sync.postSaved(post.slug, post.syncVersion)
  }
  let conflicts: Conflict[]
  try {
    conflicts = await sync.flush()
    await sync.pull()
    offline = false
  } catch (e) {
    offline = true
    pushStatus()
    return {
      ok: false,
      url,
      message:
        "Couldn't reach your blog just now, so nothing was published. Your work is saved. Try again in a minute.",
      log: e instanceof Error ? e.message : String(e),
    }
  }
  pushStatus()
  const mine = conflicts.find((c) => c.slug === post?.slug)
  if (conflicts.length) send('sync:conflict', conflicts)
  if (mine) {
    return {
      ok: false,
      url,
      message: `This post was also changed on ${mine.machineName}. Both versions are kept — check them, then publish again.`,
    }
  }
  return null
}

async function writePostLocal(post: Post) {
  await saveDraft(post, store.paths().site)
}

/** The editor's copy of a post, with the shared version it was loaded at. */
const withVersion = (post: Post): Post => ({ ...post, syncVersion: sync?.versionOf(post.slug) })

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#fdfdfc',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win?.show())

  // Smoke mode: render once, save a screenshot, exit. Used by `npm run smoke`
  // and in CI, so a renderer that throws on boot fails the build rather than
  // shipping a blank window.
  if (process.env.BLOG_EDITOR_SMOKE) {
    const errors: string[] = []
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push(message)
    })
    win.webContents.on('did-fail-load', (_e, code, desc) =>
      errors.push(`did-fail-load ${code} ${desc}`),
    )
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500))
      // BLOG_EDITOR_SMOKE_CLICK="[aria-label=Settings]" opens a screen before the shot.
      if (process.env.BLOG_EDITOR_SMOKE_CLICK) {
        await win!.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(process.env.BLOG_EDITOR_SMOKE_CLICK)})?.click()`,
        )
        await new Promise((r) => setTimeout(r, 2500))
      }
      const image = await win!.webContents.capturePage()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(process.env.BLOG_EDITOR_SMOKE!, image.toPNG())
      if (errors.length) {
        console.error('RENDERER ERRORS:\n' + errors.join('\n'))
        app.exit(1)
      } else {
        console.log('SMOKE OK')
        app.exit(0)
      }
    })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
}

/**
 * `blogmedia://` serves converted output, thumbnails, poster frames and the
 * H.264 preview proxies straight from disk, so the library grid and the
 * editor's video node work before anything is uploaded.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'blogmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function registerMediaProtocol() {
  const paths = store.paths()
  const inside = (root: string, file: string) => path.resolve(file).startsWith(path.resolve(root) + path.sep)

  /**
   * Media this computer did not make is shown from the blog itself, never
   * downloaded on purpose. net.fetch goes through Chromium's HTTP cache, and
   * media is served immutable, so each file crosses the network once.
   */
  const fromBlog = (key: string, request: Request) => {
    const origin = siteOrigin()
    if (!origin) return new Response('Not found', { status: 404 })
    const range = request.headers.get('range')
    return net.fetch(`${origin}/media/${key.split('/').map(encodeURIComponent).join('/')}`, {
      headers: range ? { range } : {},
    })
  }
  const fromDisk = (file: string) => net.fetch(pathToFileURL(file).toString())

  // blogmedia://output/<key>   the web file
  // blogmedia://poster/<key>   thumbnail (image) or poster frame (video)
  // blogmedia://play/<key>     what the editor plays: the H.264 proxy where there is one
  // blogmedia://cache/<file>   thumbnails by file name, as before
  protocol.handle('blogmedia', async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))

    if (url.hostname === 'cache') {
      const file = path.join(paths.cache, rel)
      if (!inside(paths.cache, file)) return new Response('Forbidden', { status: 403 })
      if (!existsSync(file)) return new Response('Not found', { status: 404 })
      return fromDisk(file)
    }

    const key = rel
    const output = path.join(paths.output, key)
    if (!inside(paths.output, output)) return new Response('Forbidden', { status: 403 })
    const asset = library.get(key)
    const local = (file?: string) => !!file && existsSync(file)

    switch (url.hostname) {
      case 'output':
        return local(output) ? fromDisk(output) : fromBlog(key, request)
      case 'poster':
        if (local(asset?.posterPath)) return fromDisk(asset!.posterPath!)
        if (asset?.kind === 'image') return local(output) ? fromDisk(output) : fromBlog(key, request)
        return asset?.hasPoster ? fromBlog(posterKey(key), request) : new Response('Not found', { status: 404 })
      case 'play':
        if (local(asset?.proxyPath)) return fromDisk(asset!.proxyPath!)
        return local(output) ? fromDisk(output) : fromBlog(key, request)
      default:
        return new Response('Not found', { status: 404 })
    }
  })

  // The preview server mounts this computer's media folder at /media. What is
  // not there was made elsewhere and comes from the blog instead.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*'] }, (details, done) => {
    const m = /^http:\/\/127\.0\.0\.1:\d+\/media\/([^?#]+)/.exec(details.url)
    const origin = siteOrigin()
    if (!m || !origin) return done({})
    const file = path.join(paths.output, decodeURIComponent(m[1]))
    if (!inside(paths.output, file) || existsSync(file)) return done({})
    done({ redirectURL: `${origin}/media/${m[1]}` })
  })
}

// ---------------------------------------------------------------- ipc

function registerIpc() {
  // ---- status / setup
  ipcMain.handle('app:status', async () => {
    const configured = await store.isConfigured()
    const hugo = await checkHugo()
    const ffmpeg = await assertFfmpegVersion()
    return {
      configured,
      config,
      tools: { hugo, ffmpeg },
      platform: process.platform,
      version: app.getVersion(),
      sync: syncStatus(),
    }
  })

  /**
   * Disconnect this computer and restart on setup. Unsent changes and
   * unfinished uploads are reported first unless `force`; either way nothing
   * is deleted — the folder is set aside at the restart.
   */
  ipcMain.handle('app:disconnect', async (_e, force: boolean) => {
    await flushSync()
    const unsent = sync?.pending ?? 0
    const uploading = queue.pendingCount
    if (!force && (unsent || uploading)) return { ok: false, unsent, uploading }
    await requestDisconnect(app.getPath('userData'))
    // exit() skips before-quit, which is where the preview server stops.
    preview.stop()
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  ipcMain.handle('setup:checkToken', async (_e, token: string, accountId?: string) => {
    return new CloudflareClient(token).checkToken(accountId)
  })

  ipcMain.handle('setup:provision', async (_e, input: SetupInput) => {
    try {
      const identity = await ensureState(statePath())
      const { config: cfg, secrets } = await provision(
        input,
        dataDir(),
        (steps) => send('setup:progress', steps),
        identity.machineId,
      )
      await store.writeSecrets(secrets)
      await store.writeConfig(cfg)
      await connect()
      await heartbeat()
      return { ok: true, config: cfg }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, error: message, existingBlog: message === EXISTING_BLOG }
    }
  })

  // ---- connecting this computer to a blog that already exists
  ipcMain.handle('connect:find', async (_e, token: string) => {
    try {
      const client = new CloudflareClient(token)
      const found = await findBlogs(client)
      // Permissions are checked in the account the blog is in, not just the first one.
      const accountIds = [...new Set([...found.blogs, ...found.unmoved].map((b) => b.accountId))]
      const checks = Object.fromEntries(
        await Promise.all(accountIds.map(async (id) => [id, await client.checkToken(id)] as const)),
      )
      return { ok: true, ...found, checks }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  const connectError = (e: unknown) => ({
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    keysRejected: e instanceof KeysRejectedError,
    needsUpdate: e instanceof NewerDatabaseError,
    log: e instanceof BuildFailedError ? e.log : undefined,
  })

  ipcMain.handle(
    'connect:run',
    async (
      _e,
      args: { token: string; accountId: string; databaseId: string; keys?: { r2AccessKeyId: string; r2SecretAccessKey: string } },
    ) => {
      try {
        const res = await connectBlog({
          ...args,
          siteDir: store.paths().site,
          library,
          onProgress: (detail) => send('connect:progress', detail),
        })
        await store.writeSecrets(res.secrets)
        await store.writeConfig(res.config)
        await connect()
        await sync!.adopt(res.versions, res.blogUpdatedAt, res.at)
        migration = { state: 'not-needed' }
        await heartbeat()
        return { ok: true, posts: res.posts, assets: res.assets }
      } catch (e) {
        return connectError(e)
      }
    },
  )

  ipcMain.handle(
    'connect:recover',
    async (
      _e,
      args: { token: string; blog: UnmovedBlog; keys: { r2AccessKeyId: string; r2SecretAccessKey: string } },
    ) => {
      try {
        const identity = await ensureState(statePath())
        const { databaseId } = await recoverUnmoved({
          ...args,
          machineId: identity.machineId,
          onProgress: (detail) => send('connect:progress', detail),
        })
        return { ok: true, databaseId }
      } catch (e) {
        return connectError(e)
      }
    },
  )

  // ---- sharing
  ipcMain.handle('sync:status', async () => syncStatus())
  ipcMain.handle('sync:migrate', async () => {
    await tryMigrate()
    return syncStatus()
  })
  ipcMain.handle('sync:pull', async () => {
    await flushSync()
    await pullSync()
    return syncStatus()
  })

  /** Connection health: the same checks, re-runnable forever. */
  ipcMain.handle('setup:health', async () => {
    const out: { id: string; label: string; ok: boolean; detail?: string }[] = []
    const add = (id: string, label: string, ok: boolean, detail?: string) =>
      out.push({ id, label, ok, detail })

    const hugo = await checkHugo()
    add('hugo', 'Site builder', hugo.ok, hugo.version)
    const ffmpeg = await assertFfmpegVersion()
    add('ffmpeg', 'Video tool', ffmpeg.ok, ffmpeg.version)

    if (!cf || !config || !r2) {
      add('config', 'Blog set up', false, 'not set up yet')
      return out
    }

    const token = await cf.checkToken(config.accountId)
    add('token', 'Cloudflare permission', token.ok, token.missing.join(', ') || token.accountName)

    if (sync) {
      try {
        const counts = await sync.db.counts()
        add('shared', 'Shared with your other computers', true, `${counts.posts} posts`)
      } catch (e) {
        add('shared', 'Shared with your other computers', false, e instanceof Error ? e.message : 'unreachable')
      }
    } else {
      add('shared', 'Shared with your other computers', false, migration.message ?? 'not yet')
    }

    try {
      await r2.list('_setup-check/')
      add('storage', 'Photo storage', true, config.bucket)
    } catch (e) {
      add('storage', 'Photo storage', false, e instanceof Error ? e.message : 'unreachable')
    }

    try {
      const res = await fetch(config.customDomain ? `https://${config.customDomain}/` : config.siteUrl)
      add('site', 'Blog online', res.ok, String(res.status))
    } catch {
      add('site', 'Blog online', false, 'no answer')
    }
    return out
  })

  // ---- posts
  ipcMain.handle('posts:list', async () =>
    config ? (await listPosts(store.paths().site)).map(withVersion) : [],
  )
  ipcMain.handle('posts:read', async (_e, slug: string) => {
    const post = await readPost(store.paths().site, slug)
    return post ? withVersion(post) : null
  })
  /** Saved here at once; shared when the database answers, which may be later. */
  ipcMain.handle('posts:saveDraft', async (_e, post: Post) => {
    await saveDraft(post, store.paths().site)
    if (sync) {
      await sync.postSaved(post.slug, post.syncVersion)
      void flushSync()
    }
    return { ok: true }
  })
  /** Local delete, used when a post is renamed: the old name goes from every computer. */
  ipcMain.handle('posts:delete', async (_e, slug: string) => {
    await removePost(store.paths().site, slug)
    if (sync) {
      await sync.postDeleted(slug)
      void flushSync()
    }
    return { ok: true }
  })

  ipcMain.handle('posts:publish', async (_e, post: Post) => {
    if (!cf || !r2 || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const blocked = await readyToDeploy(post)
    if (blocked) return blocked
    return publish(post, { config, cf, r2, library, queue, siteDir: store.paths().site }, (p) =>
      send('publish:progress', p),
    )
  })

  /** Set or clear (empty string) the visitor password, then republish so it takes effect. */
  ipcMain.handle('site:setPassword', async (_e, password: string) => {
    if (!cf || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const blocked = await readyToDeploy()
    if (blocked) return blocked
    const { sitePassword: _old, ...rest } = config
    config = password.trim() ? { ...rest, sitePassword: password.trim() } : rest
    await store.writeConfig(config)
    await shareSettings({ sitePassword: config.sitePassword })
    return republishSite({ config, cf, siteDir: store.paths().site }, (p) =>
      send('publish:progress', p),
    )
  })

  ipcMain.handle('posts:unpublish', async (_e, post: Post) => {
    if (!cf || !r2 || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const draft: Post = { ...post, frontMatter: { ...post.frontMatter, draft: true } }
    const blocked = await readyToDeploy(draft)
    if (blocked) return blocked
    return unpublishPost(draft, { config, cf, siteDir: store.paths().site }, (p) =>
      send('publish:progress', p),
    )
  })

  /** Delete a post from this computer, its backup and the blog; unlike posts:delete, which is local only. */
  ipcMain.handle('posts:remove', async (_e, args: { slug: string; media: boolean }) => {
    if (!cf || !r2 || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const blocked = await readyToDeploy()
    if (blocked) return blocked
    const res = await removePostEverywhere(
      args.slug,
      { media: args.media },
      { config, cf, r2, library, siteDir: store.paths().site },
      (p) => send('publish:progress', p),
    )
    if (sync) {
      await sync.postDeleted(args.slug)
      for (const key of res.removedKeys) await sync.assetRemoved(key)
      await flushSync()
    }
    // A later post with the same name must not inherit these.
    if (res.ok) {
      const db = await commentsDb().catch(() => null)
      if (db) await deletePostComments(db, args.slug).catch(() => {})
      if (db) await forgetPost(db, args.slug).catch(() => {})
    }
    return res
  })

  // ---- comments
  ipcMain.handle('comments:list', async (_e, slug: string) => {
    try {
      const db = await commentsDb()
      return { ok: true, comments: db ? await listComments(db, slug) : [] }
    } catch (e) {
      return { ok: false, message: 'Comments could not be loaded just now.', log: String(e) }
    }
  })
  ipcMain.handle('comments:delete', async (_e, id: number) => {
    try {
      const db = await commentsDb()
      if (!db) return { ok: false, message: 'Comments could not be reached just now.' }
      return { ok: true, removed: await deleteComment(db, id) }
    } catch (e) {
      return { ok: false, message: 'The comment could not be deleted just now.', log: String(e) }
    }
  })

  // ---- newsletter
  /** Everything the newsletter screens show. The Resend key itself never leaves this process. */
  ipcMain.handle('newsletter:status', async () => {
    const shared = sharedDb()
    if (!shared) {
      return {
        ok: false,
        message:
          'The newsletter needs your blog to be ready for other computers first. See "Other computers" in Settings.',
      }
    }
    try {
      const db = await newsletterDb()
      const sender = await readSender(shared)
      const [open, subscribers, announced, mailings] = await Promise.all([
        isOpen(db),
        countSubscribers(db),
        announcedPosts(db),
        listMailings(db, 10),
      ])
      return {
        ok: true,
        sender: sender && {
          fromEmail: sender.fromEmail,
          fromName: sender.fromName ?? '',
          hasResendKey: !!sender.resendKey,
        },
        open,
        subscribers,
        announced,
        mailings,
        sending: sendingId,
        customDomain: config?.customDomain ?? null,
      }
    } catch (e) {
      return { ok: false, message: 'The newsletter could not be reached just now.', log: String(e) }
    }
  })

  ipcMain.handle(
    'newsletter:saveSender',
    async (_e, s: { fromEmail: string; fromName?: string; resendKey?: string }) => {
      const shared = sharedDb()
      if (!shared) return { ok: false, message: 'This blog is not ready for that yet.' }
      const fromEmail = s.fromEmail.trim()
      if (!EMAIL.test(fromEmail)) return { ok: false, message: 'Enter the address the emails should come from.' }
      if (/\.workers\.dev$/i.test(fromEmail)) {
        return { ok: false, message: 'Emails cannot come from a workers.dev address. Use an address on your own domain.' }
      }
      try {
        if (!(await writeSender(shared, { ...s, fromEmail }))) {
          return { ok: false, message: 'Paste your Resend API key.' }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, message: 'The settings could not be saved just now.', log: String(e) }
      }
    },
  )

  /** One email to the owner, to prove the sending address works before anyone else gets one. */
  ipcMain.handle('newsletter:test', async (_e, to: string) => {
    const m = await newsletterMailer()
    if ('message' in m) return { ok: false, message: m.message }
    if (!EMAIL.test(to.trim())) return { ok: false, message: 'Enter the address to send the test to.' }
    const email = renderEmail(
      {
        blogTitle: config!.title,
        subject: `A test from ${config!.title}`,
        body: 'This is how emails to your subscribers will look.\n\nIf you can read this, sending works.',
        link: siteOrigin(),
      },
      to.trim(),
      `${siteOrigin()}/api/unsubscribe?t=${'0'.repeat(32)}`,
    )
    try {
      await m.mailer.send([email], `test-${Date.now()}`)
      return { ok: true }
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError('The test email could not be sent.', 'failed', String(e))
      return { ok: false, message: err.message, log: err.log }
    }
  })

  /**
   * Show or hide the box under posts. Showing it republishes the blog if the
   * one online is from before subscriptions, so the box appears right away
   * rather than at the next publish.
   */
  ipcMain.handle('newsletter:setOpen', async (_e, open: boolean) => {
    if (!cf || !config) return { ok: false, message: 'This blog is not set up yet.' }
    try {
      await setOpen(await newsletterDb(), open)
    } catch (e) {
      return { ok: false, message: 'That could not be changed just now.', log: String(e) }
    }
    if (!open || (await workerHasSubscribe())) return { ok: true }
    const blocked = await readyToDeploy()
    if (blocked) return blocked
    return republishSite({ config, cf, siteDir: store.paths().site }, (p) => send('publish:progress', p))
  })

  ipcMain.handle('newsletter:subscribers', async () => {
    try {
      const list = await listSubscribers(await newsletterDb())
      return { ok: true, subscribers: list.map(({ id, email, at }) => ({ id, email, at })) }
    } catch (e) {
      return { ok: false, message: 'Subscribers could not be loaded just now.', log: String(e) }
    }
  })
  ipcMain.handle('newsletter:add', async (_e, email: string) => {
    const address = email.trim()
    if (!EMAIL.test(address) || address.length > MAX_EMAIL) {
      return { ok: false, message: `"${address}" does not look like an email address.` }
    }
    try {
      const added = await addSubscriber(await newsletterDb(), address)
      return added ? { ok: true } : { ok: false, message: `${address} is already subscribed.` }
    } catch (e) {
      return { ok: false, message: 'That address could not be added just now.', log: String(e) }
    }
  })
  ipcMain.handle('newsletter:remove', async (_e, id: number) => {
    try {
      await removeSubscriber(await newsletterDb(), id)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: 'That address could not be removed just now.', log: String(e) }
    }
  })

  /** An email the owner wrote, to everyone. */
  ipcMain.handle('newsletter:send', async (_e, msg: { subject: string; body: string }) => {
    const subject = msg.subject.trim()
    const body = msg.body.trim()
    if (!subject || !body) return { ok: false, message: 'Write a subject and a message first.' }
    return runMailing(async (db) => createMailing(db, { subject, body }))
  })

  /** "There is a new post": once per post, however many times it is asked for. */
  ipcMain.handle('newsletter:announce', async (_e, slug: string) => {
    const post = await readPost(store.paths().site, slug)
    if (!post || post.frontMatter.draft) return { ok: false, message: 'Publish the post first.' }
    const title = post.frontMatter.title.trim()
    return runMailing(async (db) =>
      createMailing(db, {
        post: slug,
        subject: title,
        body: post.frontMatter.description?.trim() || `There is a new post on ${config!.title}.`,
        link: `${siteOrigin()}/posts/${slug}/`,
      }),
    )
  })

  /** Carry on with a mailing that stopped at a limit. */
  ipcMain.handle('newsletter:resume', async (_e, mailingId: number) =>
    runMailing(async (db) => {
      const m = await getMailing(db, mailingId)
      if (!m) throw new Error(`no mailing ${mailingId}`)
      return m
    }),
  )

  // ---- media
  ipcMain.handle('media:pick', async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Photos and video', extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm'] },
      ],
    } as any)
    return res.canceled ? [] : res.filePaths
  })

  /**
   * Enqueue dropped files. Returns the keys immediately so the editor can
   * insert the node before any conversion has happened — this is what keeps the
   * document stable rather than rewriting it underneath the writer.
   */
  ipcMain.handle(
    'media:add',
    async (_e, args: { files: string[]; postSlug: string; group: string }) => {
      const taken = library.takenKeys()
      const jobs: { srcFile: string; key: string; postSlug: string; group: string }[] = []
      const keys: string[] = []
      const rejected: string[] = []

      for (const file of args.files) {
        const kind = kindOf(file)
        if (!kind) {
          rejected.push(path.basename(file))
          continue
        }
        const key = allocateKey(args.postSlug, args.group, kind, taken)
        taken.add(key)
        keys.push(key)
        jobs.push({ srcFile: file, key, postSlug: args.postSlug, group: args.group })

        // A placeholder row so the grid can render immediately.
        await library.put({
          key,
          kind,
          postSlug: args.postSlug,
          group: args.group,
          state: 'converting',
          originalPath: file,
          bytesOriginal: 0,
          createdAt: Date.now(),
        })
      }

      queue.add(jobs)
      return { keys, rejected }
    },
  )

  ipcMain.handle('media:list', async (_e, postSlug?: string) =>
    postSlug ? library.forPost(postSlug) : library.all(),
  )
  ipcMain.handle('media:retry', async (_e, key: string) => queue.retry(key))
  ipcMain.handle('media:stats', async () => library.stats())

  ipcMain.handle('media:unplaced', async () => {
    const posts = await listPosts(store.paths().site)
    const referenced = new Set<string>()
    for (const post of posts) {
      for (const k of referencedKeys(post.doc)) referenced.add(k)
      if (post.frontMatter.cover) referenced.add(post.frontMatter.cover)
    }
    return library.unplaced(referenced)
  })

  ipcMain.handle('media:delete', async (_e, keys: string[]) => {
    let deleted = 0
    for (const key of keys) {
      const asset = library.get(key)
      if (r2) await r2.delete(key).catch(() => {})
      if (r2 && asset?.hasPoster) await r2.delete(posterKey(key)).catch(() => {})
      await library.remove(key)
      await sync?.assetRemoved(key)
      deleted++
    }
    void flushSync()
    return { deleted }
  })

  // ---- preview
  ipcMain.handle('preview:start', async () => {
    try {
      return { ok: true, origin: await preview.start(store.paths().site, store.paths().output) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('preview:stop', async () => {
    preview.stop()
    return { ok: true }
  })

  // ---- domain
  ipcMain.handle('domain:registrarUrl', async (_e, domain?: string) =>
    config ? registrarUrl(config.accountId, domain) : null,
  )
  ipcMain.handle('domain:attach', async (_e, domain: string) => {
    if (!cf || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const res = await attachDomain(domain, { cf, config, siteDir: store.paths().site }, (p) =>
      send('domain:progress', p),
    )
    // Save as soon as Cloudflare has the hostname, even while it is still being
    // secured: the attachment is real, and builds must keep using the address.
    if (res.attached && res.domain) {
      config = { ...config, customDomain: res.domain }
      await store.writeConfig(config)
      await shareSettings({ customDomain: res.domain })
    }
    return res
  })

  ipcMain.handle('domain:list', async () => {
    if (!cf || !config) return []
    let domains: Awaited<ReturnType<typeof listBlogDomains>>
    try {
      domains = await listBlogDomains(cf, config)
    } catch {
      return []
    }
    // The saved address was detached elsewhere (e.g. the Cloudflare dashboard):
    // stop building links to it. Only reached when the listing succeeded.
    if (config.customDomain && !domains.some((d) => d.hostname === config!.customDomain)) {
      const next = domains[0]?.hostname
      const { customDomain: _gone, ...rest } = config
      config = next ? { ...rest, customDomain: next } : rest
      await store.writeConfig(config)
      await shareSettings({ customDomain: next })
      await setBaseUrl(store.paths().site, next ? `https://${next}` : config.siteUrl)
      domains = domains.map((d) => ({ ...d, primary: d.hostname === next }))
    }
    return domains
  })
  ipcMain.handle('domain:remove', async (_e, hostname: string) => {
    if (!cf || !config) return { ok: false, message: 'This blog is not set up yet.' }
    const res = await removeDomain(hostname, { cf, config, siteDir: store.paths().site })
    if (res.customDomain !== config.customDomain) {
      const { customDomain: _old, ...rest } = config
      config = res.customDomain ? { ...rest, customDomain: res.customDomain } : rest
      await store.writeConfig(config)
      await shareSettings({ customDomain: res.customDomain })
    }
    return res
  })

  // ---- misc
  ipcMain.handle('update:state', async () => updateState())
  ipcMain.handle('shell:open', async (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:openPost', async (_e, slug: string) => {
    const origin = siteOrigin()
    if (origin) await shell.openExternal(`${origin}/posts/${encodeURIComponent(slug)}/`)
  })
  ipcMain.handle('shell:reveal', async (_e, which: 'originals' | 'site') => {
    shell.openPath(which === 'originals' ? store.paths().originals : store.paths().site)
  })

  /** Copy report: everything a helper needs, with credentials scrubbed. */
  ipcMain.handle('report:build', async () => {
    const lines = [
      `Blog Editor ${app.getVersion()}`,
      `${process.platform} ${process.arch} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
      '',
    ]
    const hugo = await checkHugo()
    const ffmpeg = await assertFfmpegVersion()
    lines.push(`Hugo: ${hugo.version} (ok=${hugo.ok})`)
    lines.push(`ffmpeg: ${ffmpeg.version} (ok=${ffmpeg.ok})`)
    if (config) {
      lines.push(`Blog: ${config.name}`)
      lines.push(`Site: ${config.customDomain ?? config.siteUrl}`)
      lines.push(`Bucket: ${config.bucket}`)
      lines.push(`Account: ${config.accountId.slice(0, 6)}… (truncated)`)
      const st = syncStatus()
      lines.push(
        `Sharing: ${st.shared ? 'on' : `off (${migration.state}${migration.message ? `: ${migration.message}` : ''})`}` +
          ` · this computer: ${st.machineName ?? '?'} · unsent: ${st.pending}${st.offline ? ' · offline' : ''}`,
      )
      if (st.others.length) lines.push(`Also open on: ${st.others.join(', ')}`)
    } else {
      lines.push('Blog: not set up')
    }
    const stats = library.stats()
    lines.push(
      `Photos: ${stats.count} (${(stats.bytesOutput / 1e6).toFixed(0)} MB web, ${(stats.bytesOriginal / 1e6).toFixed(0)} MB originals, ${stats.remote} from other computers)`,
    )
    const failed = library.all().filter((a) => a.state === 'failed')
    if (failed.length) {
      lines.push('', 'Failed items:')
      for (const a of failed.slice(0, 20)) lines.push(`  ${a.key}: ${a.error}`)
    }
    return lines.join('\n')
  })
}

// ---------------------------------------------------------------- boot

app.whenReady().then(async () => {
  R2.requestHandler = createFetchHandler((url, init) => net.fetch(url, init))
  // Before anything opens the blog folder: a disconnect sets it aside.
  await applyPendingDisconnect(app.getPath('userData'), dataDir())
  store = await Store.open(dataDir(), safeStorage)
  library = await Library.open(store.paths().library)
  const paths = store.paths()
  queue = new MediaQueue(
    library,
    { originalsDir: paths.originals, outputDir: paths.output, cacheDir: paths.cache },
    DEFAULT_SETTINGS,
    () => r2,
  )
  queue.onProgress((p) => {
    send('media:progress', p)
    // Other computers learn of a photo once it is in the bucket, not before.
    if (p.state === 'live' && sync) void sync.assetChanged(p.key).then(flushSync)
  })

  await connect()
  // A blog configured earlier but never scaffolded (interrupted setup) is
  // recoverable rather than fatal.
  if (config && !existsSync(paths.site)) await scaffold(paths.site, config)
  else if (config) await syncTemplate(paths.site)
  if (config?.customDomain) await setBaseUrl(paths.site, `https://${config.customDomain}`)

  registerMediaProtocol()
  registerIpc()
  createWindow()
  await initUpdater((s) => send('update:state', s))

  // Sharing. None of this blocks the window: writing works offline, and
  // anything unsent waits in sync.json.
  if (sync) {
    void flushSync().then(pullSync).then(heartbeat)
  } else if (config) {
    void tryMigrate()
  }
  // Coming back to the window is when another computer's work matters.
  app.on('browser-window-focus', () => {
    if (sync) void flushSync().then(pullSync)
  })
  setInterval(() => void heartbeat(), 60_000)
  setInterval(() => {
    if (sync?.pending) void flushSync()
  }, 30_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  preview.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => preview.stop())
