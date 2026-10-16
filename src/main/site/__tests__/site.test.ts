/**
 * End-to-end: scaffold a site, write a post through the serializer, build it
 * with Hugo, and check the HTML that actually ships.
 *
 * This is the Phase 0 gate minus the upload — it proves the chain from the
 * editor's document model to the bytes a reader receives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  scaffold,
  writePost,
  readPost,
  listPosts,
  build,
  checkHugo,
  setBaseUrl,
  PreviewServer,
} from '../hugo.js'
import type { Post, BlogConfig, PMNode } from '../../../shared/types.js'

const config: BlogConfig = {
  accountId: 'acct',
  name: 'alice-blog',
  bucket: 'alice-blog-media',
  siteUrl: 'https://alice-blog.alice.workers.dev',
  title: "Alice's Trip Log",
  author: 'Alice',
}

const t = (text: string): PMNode => ({ type: 'text', text })
const p = (...c: PMNode[]): PMNode => ({ type: 'paragraph', content: c })

const post: Post = {
  slug: 'nov-2026',
  frontMatter: {
    title: 'Nov 2026',
    date: '2026-11-30',
    draft: false,
    description: 'Island Time',
    cover: 'nov-2026/tofino/tofino-1.avif',
  },
  doc: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [t('Surfs up')] },
      p(t('We woke at 6:30 to go surfing.')),
      {
        type: 'gallery',
        attrs: {
          keys: ['nov-2026/surf/surf-1.avif', 'nov-2026/surf/surf-2.avif'],
          caption: null,
        },
      },
      { type: 'video', attrs: { key: 'nov-2026/surf/surf-video-1.mp4', caption: null } },
      {
        type: 'figure',
        attrs: { key: 'nov-2026/tofino/tofino-1.avif', caption: 'Sunset', align: 'center' },
      },
    ],
  },
}

let dir: string
let hugoOk = false

beforeAll(async () => {
  hugoOk = (await checkHugo()).ok
  dir = await mkdtemp(path.join(tmpdir(), 'blog-site-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('site scaffold', () => {
  it('stamps the blog values into the config', async () => {
    await scaffold(dir, config)
    const cfg = await readFile(path.join(dir, 'hugo.yaml'), 'utf8')
    expect(cfg).toContain(`baseURL: "${config.siteUrl}/"`)
    expect(cfg).toContain(`title: "Alice's Trip Log"`)
    // The deprecated key warns on every build; the template must not use it.
    expect(cfg).not.toContain('languageCode')
    expect(cfg).toContain('locale:')
  })

  it('ships the three shortcodes the editor emits', () => {
    for (const name of ['gallery', 'video', 'figure']) {
      expect(existsSync(path.join(dir, 'layouts', 'shortcodes', `${name}.html`))).toBe(true)
    }
  })

  it('round-trips a post through disk', async () => {
    await writePost(dir, post)
    expect(await readPost(dir, 'nov-2026')).toEqual(post)
    expect((await listPosts(dir)).map((p) => p.slug)).toEqual(['nov-2026'])
  })
})

describe('hugo build', () => {
  it('builds without errors', async () => {
    if (!hugoOk) return
    const res = await build(dir)
    expect(res.ok, res.log).toBe(true)
    expect(existsSync(path.join(res.publicDir, 'index.html'))).toBe(true)
    console.log(`      built in ${res.durationMs}ms`)
  })

  it('produces exactly one stylesheet (--cleanDestinationDir)', async () => {
    if (!hugoOk) return
    await build(dir)
    await build(dir)
    await build(dir)
    const { readdir } = await import('node:fs/promises')
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = []
      for (const e of await readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) out.push(...(await walk(f)))
        else out.push(f)
      }
      return out
    }
    const files = await walk(path.join(dir, 'public'))
    // Styles are inlined in a partial, so repeated builds must not accumulate.
    expect(files.filter((f) => f.endsWith('.css')).length).toBe(0)
  })

  it('renders the gallery, video and figure shortcodes', async () => {
    if (!hugoOk) return
    await build(dir)
    const html = await readFile(
      path.join(dir, 'public', 'posts', 'nov-2026', 'index.html'),
      'utf8',
    )
    expect(html).toMatch(/class="?gallery"?/)
    expect(html).toContain('/media/nov-2026/surf/surf-1.avif')
    expect(html).toContain('/media/nov-2026/surf/surf-2.avif')
    expect(html).toContain('<video')
    expect(html).toContain('/media/nov-2026/surf/surf-video-1.mp4')
    expect(html).toContain('Sunset')
  })

  it('keeps media references root-relative, so a domain change rewrites nothing', async () => {
    if (!hugoOk) return
    await build(dir)
    const html = await readFile(
      path.join(dir, 'public', 'posts', 'nov-2026', 'index.html'),
      'utf8',
    )
    // No absolute media URLs in the post body. (The og:image meta tag is
    // deliberately absolute — social cards require it — so check the article.)
    const article = /<article[\s\S]*<\/article>/.exec(html)![0]
    expect(article).not.toMatch(/https?:\/\/[^\s"'>]*\/media\//)
    expect(article).toMatch(/src="?\/media\//)
  })

  it('a custom domain is one config value and a rebuild', async () => {
    if (!hugoOk) return
    await setBaseUrl(dir, 'https://alice.com')
    const res = await build(dir)
    expect(res.ok).toBe(true)
    const cfg = await readFile(path.join(dir, 'hugo.yaml'), 'utf8')
    expect(cfg).toContain('baseURL: "https://alice.com/"')
    // The post body still has no absolute media URLs: nothing was rewritten.
    const html = await readFile(
      path.join(dir, 'public', 'posts', 'nov-2026', 'index.html'),
      'utf8',
    )
    expect(html).toMatch(/src="?\/media\//)
    await setBaseUrl(dir, config.siteUrl)
  })

  it('renders the home page with the post listed', async () => {
    if (!hugoOk) return
    await build(dir)
    const html = await readFile(path.join(dir, 'public', 'index.html'), 'utf8')
    expect(html).toContain('Nov 2026')
    expect(html).toContain('Island Time')
    expect(html).toContain("Alice's Trip Log")
  })

  it('excludes drafts from a normal build but keeps them on disk', async () => {
    if (!hugoOk) return
    await writePost(dir, {
      ...post,
      slug: 'draft-post',
      frontMatter: { ...post.frontMatter, title: 'Secret Draft', draft: true, cover: undefined },
    })
    const res = await build(dir)
    expect(res.ok).toBe(true)
    expect(existsSync(path.join(dir, 'content', 'posts', 'draft-post.md'))).toBe(true)
    expect(existsSync(path.join(res.publicDir, 'posts', 'draft-post', 'index.html'))).toBe(false)

    const withDrafts = await build(dir, { drafts: true })
    expect(existsSync(path.join(withDrafts.publicDir, 'posts', 'draft-post', 'index.html'))).toBe(true)
  })
})

describe('preview server', () => {
  it('serves local media at /media so preview images are not broken', async () => {
    if (!hugoOk) return
    await writePost(dir, post)
    const media = await mkdtemp(path.join(tmpdir(), 'blog-media-'))
    const bytes = Buffer.from('fake-avif-bytes')
    await mkdir(path.join(media, 'nov-2026', 'surf'), { recursive: true })
    await writeFile(path.join(media, 'nov-2026', 'surf', 'surf-1.avif'), bytes)

    const preview = new PreviewServer()
    try {
      const origin = await preview.start(dir, media, 13917)
      const page = await fetch(`${origin}/posts/nov-2026/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toMatch(/src="?\/media\/nov-2026\/surf\/surf-1\.avif/)

      const img = await fetch(`${origin}/media/nov-2026/surf/surf-1.avif`)
      expect(img.status).toBe(200)
      expect(Buffer.from(await img.arrayBuffer()).equals(bytes)).toBe(true)
    } finally {
      preview.stop()
      await rm(media, { recursive: true, force: true })
    }

    // Preview must not write into public/: everything there is deployed.
    expect(existsSync(path.join(dir, 'public', 'media'))).toBe(false)

    // A publish build ignores the preview overlay and drops stray files.
    await mkdir(path.join(dir, 'public', 'media'), { recursive: true })
    await writeFile(path.join(dir, 'public', 'media', 'stray.mp4'), 'x')
    const res = await build(dir)
    expect(res.ok, res.log).toBe(true)
    expect(existsSync(path.join(res.publicDir, 'media'))).toBe(false)
  }, 30_000)
})
