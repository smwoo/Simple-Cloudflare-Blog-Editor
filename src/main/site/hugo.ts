/**
 * Scaffolding, building and previewing the Hugo site with the bundled binary.
 *
 * Hugo is not optional and not only for preview: the app builds locally and
 * uploads the result, which is what keeps build failures inside the app rather
 * than somewhere the owner cannot see them.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { run } from '../media/ffmpeg.js'
import { serializePost, parsePost } from '../../shared/markdown.js'
import type { Post, BlogConfig } from '../../shared/types.js'

function hugoBin(): string {
  const packaged = (process as any).resourcesPath
  const dir =
    packaged && existsSync(path.join(packaged, 'bin'))
      ? path.join(packaged, 'bin')
      : path.join(process.cwd(), 'resources', 'bin')
  const bundled = path.join(
    dir,
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'hugo.exe' : 'hugo',
  )
  return existsSync(bundled) ? bundled : 'hugo'
}

export function templateDir(): string {
  const packaged = (process as any).resourcesPath
  const packagedTemplate = packaged && path.join(packaged, 'site-template')
  if (packagedTemplate && existsSync(packagedTemplate)) return packagedTemplate
  return path.join(process.cwd(), 'resources', 'site-template')
}

/** Copy the template into `dir` and stamp the blog's own values into it. */
export async function scaffold(dir: string, config: BlogConfig): Promise<void> {
  await mkdir(dir, { recursive: true })
  await cp(templateDir(), dir, { recursive: true })

  const configPath = path.join(dir, 'hugo.yaml')
  const raw = await readFile(configPath, 'utf8')
  await writeFile(
    configPath,
    raw
      .replace('__BASE_URL__', config.customDomain ? `https://${config.customDomain}/` : `${config.siteUrl}/`)
      .replace('__TITLE__', config.title.replace(/"/g, '\\"'))
      .replace('__AUTHOR__', config.author.replace(/"/g, '\\"')),
  )
  await mkdir(path.join(dir, 'content', 'posts'), { recursive: true })
}

/**
 * Bring an existing blog's layouts up to the bundled template.
 *
 * `scaffold` copies the template once, so without this a blog set up on an
 * older version never sees a template fix. Layouts are the app's, never the
 * owner's, so replacing them wholesale is safe. hugo.yaml and content are
 * left alone.
 */
export async function syncTemplate(dir: string): Promise<void> {
  const layouts = path.join(dir, 'layouts')
  await rm(layouts, { recursive: true, force: true })
  await cp(path.join(templateDir(), 'layouts'), layouts, { recursive: true })
}

/** SHA-256 of the site password, salted with the blog name. The page script hashes the same way. */
export function passwordHash(salt: string, password: string): string {
  return createHash('sha256').update(`${salt}\n${password.trim()}`).digest('hex')
}

/**
 * Config overlay for published builds, generated from the blog config rather
 * than kept in hugo.yaml so that existing blogs get it without a migration.
 *
 * The password is a veil, not a lock: the page carries a hash and hides itself
 * until a matching password is typed. The HTML and media stay public to anyone
 * who looks, so the RSS feed, which would show the posts in full, goes too.
 */
export function siteOverlay(config: Pick<BlogConfig, 'name' | 'sitePassword'>): object {
  const password = config.sitePassword?.trim()
  if (!password) return { disableKinds: ['sitemap'] }
  return {
    disableKinds: ['sitemap', 'rss'],
    params: { veil: { salt: config.name, hash: passwordHash(config.name, password) } },
  }
}

/** Rewrite baseURL in place — all a custom domain change costs. */
export async function setBaseUrl(dir: string, baseUrl: string): Promise<void> {
  const configPath = path.join(dir, 'hugo.yaml')
  const raw = await readFile(configPath, 'utf8')
  await writeFile(
    configPath,
    raw.replace(/^baseURL:.*$/m, `baseURL: "${baseUrl.replace(/\/*$/, '/')}"`),
  )
}

export async function writePost(dir: string, post: Post): Promise<string> {
  const file = path.join(dir, 'content', 'posts', `${post.slug}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, serializePost(post), 'utf8')
  return file
}

export async function readPost(dir: string, slug: string): Promise<Post | null> {
  const file = path.join(dir, 'content', 'posts', `${slug}.md`)
  if (!existsSync(file)) return null
  return parsePost(slug, await readFile(file, 'utf8'))
}

export async function listPosts(dir: string): Promise<Post[]> {
  const postsDir = path.join(dir, 'content', 'posts')
  if (!existsSync(postsDir)) return []
  const names = (await readdir(postsDir)).filter((n) => n.endsWith('.md'))
  const posts: Post[] = []
  for (const name of names) {
    const slug = name.replace(/\.md$/, '')
    const post = await readPost(dir, slug)
    if (post) posts.push(post)
  }
  return posts.sort((a, b) => (a.frontMatter.date < b.frontMatter.date ? 1 : -1))
}

/** The post file exactly as stored, for sharing it without a parse round trip. */
export async function readPostMarkdown(dir: string, slug: string): Promise<string | null> {
  const file = path.join(dir, 'content', 'posts', `${slug}.md`)
  return existsSync(file) ? readFile(file, 'utf8') : null
}

export async function writePostMarkdown(dir: string, slug: string, markdown: string): Promise<void> {
  const file = path.join(dir, 'content', 'posts', `${slug}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, markdown, 'utf8')
}

export async function deletePost(dir: string, slug: string): Promise<void> {
  await rm(path.join(dir, 'content', 'posts', `${slug}.md`), { force: true })
}

export interface BuildResult {
  ok: boolean
  publicDir: string
  /** Hugo's own output, shown verbatim to the helper and never to the owner. */
  log: string
  durationMs: number
}

/**
 * Build the site.
 *
 * `--cleanDestinationDir` matters: Hugo does not clean its output directory by
 * default, which is how the reference site accumulated 12 hashed stylesheets
 * where a clean build produces 1.
 */
const PUBLISH_CONFIG = '.publish-config.json'

export async function build(
  dir: string,
  opts: { drafts?: boolean; overlay?: object } = {},
): Promise<BuildResult> {
  const publicDir = path.join(dir, 'public')
  const started = Date.now()
  // --cleanDestinationDir alone leaves stray files behind, and everything in
  // public/ is deployed, so start from an empty directory every time.
  await rm(publicDir, { recursive: true, force: true })
  const args = ['--minify', '--cleanDestinationDir', '-s', dir, '-d', publicDir]
  if (opts.drafts) args.push('-D')
  if (opts.overlay) {
    await writeFile(path.join(dir, PUBLISH_CONFIG), JSON.stringify(opts.overlay))
    args.push('--config', `hugo.yaml,${PUBLISH_CONFIG}`)
  }

  const { code, stdout, stderr } = await run(hugoBin(), args)
  return {
    ok: code === 0,
    publicDir,
    log: [stdout, stderr].filter(Boolean).join('\n').trim(),
    durationMs: Date.now() - started,
  }
}

export async function checkHugo(): Promise<{ ok: boolean; version: string }> {
  const { code, stdout } = await run(hugoBin(), ['version'])
  const m = /hugo v([\d.]+)/.exec(stdout)
  return { ok: code === 0 && !!m, version: m?.[1] ?? 'unknown' }
}

/**
 * `hugo server` for the preview pane, with drafts on so an unpublished post is
 * visible. Returns the origin to point an iframe at.
 */
const PREVIEW_CONFIG = '.preview-config.json'

export class PreviewServer {
  private child?: ReturnType<typeof spawn>
  private origin?: string

  /**
   * `mediaDir` is the app's local converted-media folder. On the live site the
   * Worker serves /media/* from R2; locally nothing would, so preview mounts the
   * folder at /media through a preview-only config overlay. Published builds
   * never see the overlay.
   */
  async start(dir: string, mediaDir: string, port = 1313): Promise<string> {
    if (this.origin) return this.origin
    await mkdir(mediaDir, { recursive: true })
    await writeFile(
      path.join(dir, PREVIEW_CONFIG),
      JSON.stringify({
        module: {
          mounts: [
            // Declaring any static mount drops Hugo's default one; restore it.
            { source: 'static', target: 'static' },
            { source: mediaDir, target: 'static/media' },
          ],
        },
      }),
    )
    this.child = spawn(
      hugoBin(),
      [
        'server',
        '-D',
        '-s', dir,
        '--config', `hugo.yaml,${PREVIEW_CONFIG}`,
        // Without this hugo server writes the site — static media included —
        // into public/, which is exactly the directory that gets deployed.
        '--renderToMemory',
        '-p', String(port),
        '--bind', '127.0.0.1',
        '--baseURL', `http://127.0.0.1:${port}/`,
        '--appendPort=false',
        '--disableFastRender',
        '--noHTTPCache',
      ],
      { windowsHide: true },
    )

    const child = this.child
    return new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('preview server did not start')), 20_000)
      const onData = (d: Buffer) => {
        output += d.toString()
        if (/Web Server is available|Press Ctrl\+C/.test(output)) {
          clearTimeout(timer)
          this.origin = `http://127.0.0.1:${port}`
          resolve(this.origin)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      // Surface Hugo's own error (a bad post, a port in use) instead of a timeout.
      child.on('exit', (code) => {
        if (this.child === child) this.child = undefined
        if (this.origin) return
        clearTimeout(timer)
        const error = /Error: .*/.exec(output)?.[0]
        reject(new Error(error ?? `preview server exited with code ${code}`))
      })
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
    this.origin = undefined
  }
}
