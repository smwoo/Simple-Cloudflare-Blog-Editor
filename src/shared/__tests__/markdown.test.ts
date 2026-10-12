import { describe, it, expect } from 'vitest'
import {
  serializeDoc,
  parseDoc,
  serializePost,
  parsePost,
  serializeShortcode,
  parseShortcode,
  referencedKeys,
} from '../markdown.js'
import type { PMNode, Post } from '../types.js'

const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content })
const t = (text: string, marks?: any): PMNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text }
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content })

/** The property that matters: our own output parses back to the same document. */
function roundTrips(d: PMNode) {
  const once = serializeDoc(d)
  const twice = serializeDoc(parseDoc(once))
  expect(twice).toBe(once)
  return once
}

describe('inline marks', () => {
  it('serializes bold, italic, strike and code', () => {
    const d = doc(
      p(
        t('plain '),
        t('bold', [{ type: 'bold' }]),
        t(' '),
        t('italic', [{ type: 'italic' }]),
        t(' '),
        t('struck', [{ type: 'strike' }]),
        t(' '),
        t('code', [{ type: 'code' }]),
      ),
    )
    expect(serializeDoc(d)).toBe('plain **bold** *italic* ~~struck~~ `code`')
    roundTrips(d)
  })

  it('serializes links', () => {
    const d = doc(
      p(t('see '), t('the site', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
    )
    expect(serializeDoc(d)).toBe('see [the site](https://example.com)')
    roundTrips(d)
  })

  it('nests marks deterministically', () => {
    const d = doc(p(t('both', [{ type: 'italic' }, { type: 'bold' }])))
    // bold outside italic, per MARK_ORDER, regardless of input order
    expect(serializeDoc(d)).toBe('***both***')
    roundTrips(d)
  })

  it('escapes characters that would otherwise start markup', () => {
    const d = doc(p(t('a * b _ c [d] `e` ~f~')))
    const md = serializeDoc(d)
    expect(md).toBe('a \\* b \\_ c \\[d\\] \\`e\\` \\~f\\~')
    expect(parseDoc(md).content![0].content![0].text).toBe('a * b _ c [d] `e` ~f~')
  })

  it('never lets prose open a shortcode', () => {
    const d = doc(p(t('use {{<video>}} like this')))
    const md = serializeDoc(d)
    expect(md).not.toMatch(/\{\{</)
    expect(parseDoc(md).content![0].content![0].text).toBe('use {{<video>}} like this')
  })
})

describe('blocks', () => {
  it('handles headings', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('The daylight dims')] },
      { type: 'heading', attrs: { level: 3 }, content: [t('Surfs up')] },
    )
    expect(serializeDoc(d)).toBe('## The daylight dims\n\n### Surfs up')
    roundTrips(d)
  })

  it('handles bullet and ordered lists', () => {
    const d = doc(
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(t('one'))] },
          { type: 'listItem', content: [p(t('two'))] },
        ],
      },
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [p(t('first'))] },
          { type: 'listItem', content: [p(t('second'))] },
        ],
      },
    )
    expect(serializeDoc(d)).toBe('- one\n- two\n\n1. first\n2. second')
    roundTrips(d)
  })

  it('handles blockquotes and rules', () => {
    const d = doc(
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'horizontalRule' },
      p(t('after')),
    )
    expect(serializeDoc(d)).toBe('> quoted\n\n***\n\nafter')
    roundTrips(d)
  })

  it('uses *** for rules so it cannot be confused with front matter', () => {
    expect(serializeDoc(doc({ type: 'horizontalRule' }))).not.toContain('---')
  })

  it('drops empty paragraphs', () => {
    const d = doc(p(t('a')), { type: 'paragraph', content: [] }, p(t('b')))
    expect(serializeDoc(d)).toBe('a\n\nb')
  })
})

describe('shortcodes', () => {
  it('writes a gallery as root-relative media paths', () => {
    const node: PMNode = {
      type: 'gallery',
      attrs: { keys: ['nov-2026/surf/surf-1.avif', 'nov-2026/surf/surf-2.avif'] },
    }
    expect(serializeShortcode(node)).toBe(
      '{{<gallery srcs="/media/nov-2026/surf/surf-1.avif, /media/nov-2026/surf/surf-2.avif">}}',
    )
  })

  it('writes video and figure', () => {
    expect(serializeShortcode({ type: 'video', attrs: { key: 'a/b/c-video-1.mp4' } })).toBe(
      '{{<video src="/media/a/b/c-video-1.mp4">}}',
    )
    expect(
      serializeShortcode({
        type: 'figure',
        attrs: { key: 'a/b/c-1.avif', caption: 'Sunsets hit different', align: 'center' },
      }),
    ).toBe('{{<figure src="/media/a/b/c-1.avif" caption="Sunsets hit different" align="center">}}')
  })

  it('round-trips every media node', () => {
    const d = doc(
      { type: 'gallery', attrs: { keys: ['a/g/g-1.avif', 'a/g/g-2.avif'], caption: null } },
      { type: 'video', attrs: { key: 'a/g/g-video-1.mp4', caption: null } },
      { type: 'figure', attrs: { key: 'a/g/g-3.avif', caption: 'hi', align: 'center' } },
    )
    const md = roundTrips(d)
    expect(parseDoc(md)).toEqual(d)
  })

  it('escapes quotes in captions', () => {
    const node: PMNode = {
      type: 'figure',
      attrs: { key: 'a/b/c.avif', caption: 'she said "hello"', align: 'center' },
    }
    const md = serializeShortcode(node)!
    expect(md).toContain('&quot;hello&quot;')
    expect(parseShortcode(md)!.attrs!.caption).toBe('she said "hello"')
  })

  it('reads the looser hand-written delimiter styles too', () => {
    // The reference corpus mixes `{{<gallery` and `{{< figure`.
    expect(parseShortcode('{{< figure src="/media/a.avif" align="center" >}}')).toEqual({
      type: 'figure',
      attrs: { key: 'a.avif', caption: null, align: 'center' },
    })
  })

  it('ignores shortcodes it does not own', () => {
    expect(parseShortcode('{{<unknownthing foo="bar">}}')).toBeNull()
  })

  it('ignores media URLs that are not ours', () => {
    expect(parseShortcode('{{<video src="https://example.com/x.mp4">}}')).toBeNull()
  })
})

describe('front matter', () => {
  it('always writes cover.relative: false', () => {
    const post: Post = {
      slug: 'nov-2026',
      frontMatter: {
        title: 'Nov 2026',
        date: '2026-11-30',
        draft: false,
        description: 'Island time',
        cover: 'nov-2026/surf/surf-1.avif',
      },
      doc: doc(p(t('Hello.'))),
    }
    const md = serializePost(post)
    expect(md).toContain('relative: false')
    expect(md).toContain('image: "/media/nov-2026/surf/surf-1.avif"')
    expect(parsePost('nov-2026', md)).toEqual(post)
  })

  it('round-trips a post with no cover or description', () => {
    const post: Post = {
      slug: 'x',
      frontMatter: { title: 'X', date: '2026-01-01', draft: true },
      doc: doc(p(t('body'))),
    }
    expect(parsePost('x', serializePost(post))).toEqual(post)
  })

  it('survives apostrophes in the title', () => {
    const post: Post = {
      slug: 'x',
      frontMatter: { title: "Michael's Trip", date: '2026-01-01', draft: false },
      doc: doc(p(t('body'))),
    }
    expect(parsePost('x', serializePost(post)).frontMatter.title).toBe("Michael's Trip")
  })
})

describe('idempotency over a realistic post', () => {
  const post: Post = {
    slug: 'nov-2026',
    frontMatter: {
      title: 'Nov 2026',
      date: '2026-11-30',
      draft: false,
      description: 'Island Time',
      cover: 'nov-2026/tofino/tofino-22.avif',
    },
    doc: doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('The daylight dims')] },
      p(
        t('Hello everyone. We are a third of the way through '),
        t('September', [{ type: 'bold' }]),
        t(' as I try to get better about posting — see '),
        t('the archive', [{ type: 'link', attrs: { href: 'https://example.com/posts' } }]),
        t('.'),
      ),
      { type: 'video', attrs: { key: 'nov-2026/monastery/monastery-video-1.mp4', caption: null } },
      { type: 'heading', attrs: { level: 3 }, content: [t('Getting back into it')] },
      {
        type: 'gallery',
        attrs: {
          keys: [
            'nov-2026/ledge/ledge-1.avif',
            'nov-2026/ledge/ledge-2.avif',
            'nov-2026/ledge/ledge-3.avif',
          ],
          caption: null,
        },
      },
      p(t('A little exposed up on the ledge, we had a lot of fun.')),
      {
        type: 'figure',
        attrs: {
          key: 'nov-2026/tofino/tofino-1.avif',
          caption: 'Sunsets hit different in Tofino',
          align: 'center',
        },
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(t('surfed'))] },
          { type: 'listItem', content: [p(t('biked'))] },
        ],
      },
    ),
  }

  it('parse(serialize(x)) === x', () => {
    expect(parsePost('nov-2026', serializePost(post))).toEqual(post)
  })

  it('serialize is stable across repeated round-trips', () => {
    const a = serializePost(post)
    const b = serializePost(parsePost('nov-2026', a))
    const c = serializePost(parsePost('nov-2026', b))
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('lists every referenced asset in order', () => {
    expect(referencedKeys(post.doc)).toEqual([
      'nov-2026/monastery/monastery-video-1.mp4',
      'nov-2026/ledge/ledge-1.avif',
      'nov-2026/ledge/ledge-2.avif',
      'nov-2026/ledge/ledge-3.avif',
      'nov-2026/tofino/tofino-1.avif',
    ])
  })

  it('produces the shortcode style the theme expects', () => {
    const md = serializePost(post)
    expect(md).toMatch(/\{\{<gallery srcs="/)
    expect(md).toMatch(/\{\{<video src="/)
    expect(md).toMatch(/\{\{<figure src="/)
  })
})
