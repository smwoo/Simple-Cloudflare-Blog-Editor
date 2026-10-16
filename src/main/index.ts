import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { Store } from './db/store.js'
import { Library } from './db/library.js'
import { MediaQueue } from './media/queue.js'
import { DEFAULT_SETTINGS, allocateKey, kindOf } from './media/pipeline.js'
import { assertFfmpegVersion } from './media/ffmpeg.js'
import { CloudflareClient } from './cloudflare/api.js'
import { R2 } from './cloudflare/r2.js'
import { createFetchHandler } from './cloudflare/fetchHandler.js'
import { provision, type SetupInput } from './setup.js'
import { publish, saveDraft, backupSource, restoreSource } from './publish.js'
import { attachDomain, registrarUrl } from './domain.js'
import { initUpdater, updateState } from './updater.js'
import {
  listPosts,
  readPost,
  deletePost as removePost,
  build,
  checkHugo,
  PreviewServer,
  scaffold,
  setBaseUrl,
} from './site/hugo.js'
import { referencedKeys } from '../shared/markdown.js'
import type { Post, BlogConfig, Asset } from '../shared/types.js'

// ---------------------------------------------------------------- state

let win: BrowserWindow | null = null
let store: Store
let library: Library
let queue: MediaQueue
let config: BlogConfig | null = null
let cf: CloudflareClient | null = null
let r2: R2 | null = null
const preview = new PreviewServer()

const dataDir = () => path.join(app.getPath('userData'), 'blog')

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload)
}

/** Rebuild the Cloudflare clients from stored config + secrets. */
async function connect(): Promise<void> {
  config = await store.readConfig()
  const secrets = await store.readSecrets()
  if (!config || !secrets) {
    cf = null
    r2 = null
    return
  }
  cf = new CloudflareClient(secrets.cloudflareToken)
  r2 = new R2(config.accountId, secrets, config.bucket)
}

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
  protocol.handle('blogmedia', async (request) => {
    const url = new URL(request.url)
    // blogmedia://output/<key>  |  blogmedia://cache/<file>
    const root = url.hostname === 'cache' ? paths.cache : paths.output
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const file = path.join(root, rel)
    // Never serve outside the roots we own.
    if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 })
    if (!existsSync(file)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
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
    }
  })

  ipcMain.handle('setup:checkToken', async (_e, token: string) => {
    return new CloudflareClient(token).checkToken()
  })

  ipcMain.handle('setup:provision', async (_e, input: SetupInput) => {
    try {
      const { config: cfg, secrets } = await provision(input, dataDir(), (steps) =>
        send('setup:progress', steps),
      )
      await store.writeSecrets(secrets)
      await store.writeConfig(cfg)
      await connect()
      return { ok: true, config: cfg }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
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

    const token = await cf.checkToken()
    add('token', 'Cloudflare permission', token.ok, token.missing.join(', ') || token.accountName)

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
  ipcMain.handle('posts:list', async () => (config ? listPosts(store.paths().site) : []))
  ipcMain.handle('posts:read', async (_e, slug: string) => readPost(store.paths().site, slug))
  ipcMain.handle('posts:saveDraft', async (_e, post: Post) => {
    await saveDraft(post, store.paths().site, r2)
    return { ok: true }
  })
  ipcMain.handle('posts:delete', async (_e, slug: string) => {
    await removePost(store.paths().site, slug)
    return { ok: true }
  })

  ipcMain.handle('posts:publish', async (_e, post: Post) => {
    if (!cf || !r2 || !config) return { ok: false, message: 'This blog is not set up yet.' }
    return publish(post, { config, cf, r2, library, queue, siteDir: store.paths().site }, (p) =>
      send('publish:progress', p),
    )
  })

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
      if (r2) await r2.delete(key).catch(() => {})
      await library.remove(key)
      deleted++
    }
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
    }
    return res
  })

  // ---- misc
  ipcMain.handle('update:state', async () => updateState())
  ipcMain.handle('shell:open', async (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:reveal', async (_e, which: 'originals' | 'site') => {
    shell.openPath(which === 'originals' ? store.paths().originals : store.paths().site)
  })
  ipcMain.handle('backup:now', async () => {
    if (!r2) return { ok: false }
    return { ok: true, files: await backupSource(store.paths().site, r2) }
  })
  ipcMain.handle('backup:restore', async () => {
    if (!r2) return { ok: false, posts: 0 }
    return { ok: true, ...(await restoreSource(r2, store.paths().site)) }
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
    } else {
      lines.push('Blog: not set up')
    }
    const stats = library.stats()
    lines.push(
      `Photos: ${stats.count} (${(stats.bytesOutput / 1e6).toFixed(0)} MB web, ${(stats.bytesOriginal / 1e6).toFixed(0)} MB originals)`,
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
  store = await Store.open(dataDir(), safeStorage)
  library = await Library.open(store.paths().library)
  const paths = store.paths()
  queue = new MediaQueue(
    library,
    { originalsDir: paths.originals, outputDir: paths.output, cacheDir: paths.cache },
    DEFAULT_SETTINGS,
    () => r2,
  )
  queue.onProgress((p) => send('media:progress', p))

  await connect()
  // A blog configured earlier but never scaffolded (interrupted setup) is
  // recoverable rather than fatal.
  if (config && !existsSync(paths.site)) await scaffold(paths.site, config)
  if (config?.customDomain) await setBaseUrl(paths.site, `https://${config.customDomain}`)

  registerMediaProtocol()
  registerIpc()
  createWindow()
  await initUpdater((s) => send('update:state', s))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  preview.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => preview.stop())
