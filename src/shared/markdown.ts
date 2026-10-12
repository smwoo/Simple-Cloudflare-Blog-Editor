/**
 * Hugo markdown <-> ProseMirror JSON.
 *
 * The app authors every post it can edit, so serialization is canonical: one
 * style, one attribute order, no attempt to preserve hand-written formatting.
 * That makes the correctness bar `parse(serialize(doc)) === doc`, which the
 * tests assert over a corpus of documents.
 *
 * Media is referenced by asset key and written as a root-relative `/media/...`
 * path, never an absolute URL, so moving to a custom domain rewrites no content.
 */
import type { PMNode, PMMark, FrontMatter, Post } from './types.js'
import { mediaPath, keyFromMediaPath } from './types.js'

// ---------------------------------------------------------------- inline

/** Characters that would otherwise start inline markup. */
const ESCAPE_RE = /([\\*_`\[\]~])/g

function escapeText(s: string): string {
  return s
    .replace(ESCAPE_RE, '\\$1')
    // Never let prose open a shortcode or a Hugo action.
    .replace(/\{\{/g, '\\{\\{')
}

function unescapeText(s: string): string {
  return s.replace(/\\([\\*_`\[\]~{}])/g, '$1')
}

/** Escape a value going into a shortcode attribute (Hugo params are quoted). */
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;')
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"')
}

const MARK_WRAP: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

/** Marks are emitted outermost-first in this order, so nesting is deterministic. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code']

function sortMarks(marks: PMMark[] = []): PMMark[] {
  return [...marks].sort(
    (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
  )
}

function serializeInline(nodes: PMNode[] = []): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '\\\n'
      continue
    }
    if (n.type !== 'text' || n.text === undefined) continue

    // `code` takes raw text: markdown does not process escapes inside backticks.
    const hasCode = (n.marks ?? []).some((m) => m.type === 'code')
    let s = hasCode ? n.text : escapeText(n.text)

    for (const mark of sortMarks(n.marks).reverse()) {
      if (mark.type === 'link') {
        const href = String(mark.attrs?.href ?? '')
        s = `[${s}](${href})`
      } else {
        const w = MARK_WRAP[mark.type]
        if (w) s = `${w}${s}${w}`
      }
    }
    out += s
  }
  return out
}

interface InlineToken {
  text: string
  marks: PMMark[]
}

/** Tokenise inline markdown back into text runs carrying marks. */
function parseInline(src: string): PMNode[] {
  const out: PMNode[] = []
  const push = (text: string, marks: PMMark[]) => {
    if (!text) return
    const last = out[out.length - 1]
    const sameMarks =
      last?.type === 'text' &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(marks)
    if (sameMarks) last.text += text
    else out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text })
  }

  let i = 0
  let buf = ''
  const marks: PMMark[] = []
  const flush = () => {
    push(unescapeText(buf), [...marks])
    buf = ''
  }

  const openMark = (type: string, attrs?: Record<string, unknown>) => {
    flush()
    marks.push(attrs ? ({ type, attrs } as PMMark) : ({ type } as PMMark))
  }
  const closeMark = (type: string) => {
    flush()
    const idx = marks.map((m) => m.type).lastIndexOf(type as PMMark['type'])
    if (idx >= 0) marks.splice(idx, 1)
  }
  const has = (type: string) => marks.some((m) => m.type === type)

  while (i < src.length) {
    const rest = src.slice(i)

    // escape
    if (src[i] === '\\') {
      if (src[i + 1] === '\n') {
        flush()
        out.push({ type: 'hardBreak' })
        i += 2
        continue
      }
      buf += src.slice(i, i + 2)
      i += 2
      continue
    }

    // inline code takes precedence and is literal inside
    if (src[i] === '`' && !has('code')) {
      const end = src.indexOf('`', i + 1)
      if (end > i) {
        flush()
        push(src.slice(i + 1, end), [...marks, { type: 'code' }])
        i = end + 1
        continue
      }
    }

    // link
    if (src[i] === '[') {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)/.exec(rest)
      if (m) {
        flush()
        const inner = parseInline(m[1])
        for (const node of inner) {
          const nodeMarks = [...marks, { type: 'link' as const, attrs: { href: m[2] } }, ...(node.marks ?? [])]
          push(node.text ?? '', dedupeMarks(nodeMarks))
        }
        i += m[0].length
        continue
      }
    }

    if (rest.startsWith('**')) {
      has('bold') ? closeMark('bold') : openMark('bold')
      i += 2
      continue
    }
    if (rest.startsWith('~~')) {
      has('strike') ? closeMark('strike') : openMark('strike')
      i += 2
      continue
    }
    if (src[i] === '*') {
      has('italic') ? closeMark('italic') : openMark('italic')
      i += 1
      continue
    }

    buf += src[i]
    i += 1
  }
  flush()
  return out
}

function dedupeMarks(marks: PMMark[]): PMMark[] {
  const seen = new Set<string>()
  const out: PMMark[] = []
  for (const m of marks) {
    const k = m.type + JSON.stringify(m.attrs ?? {})
    if (seen.has(k)) continue
    seen.add(k)
    out.push(m)
  }
  return sortMarks(out)
}

// ---------------------------------------------------------------- shortcodes

/**
 * The three media nodes. Rendered atomically in the editor and emitted in one
 * canonical style: `{{<name ...>}}` with no space after the delimiter, which is
 * the dominant form in the reference corpus.
 */
export function serializeShortcode(node: PMNode): string | null {
  switch (node.type) {
    case 'gallery': {
      const keys: string[] = node.attrs?.keys ?? []
      if (!keys.length) return null
      const srcs = keys.map(mediaPath).join(', ')
      const caption = node.attrs?.caption
      return caption
        ? `{{<gallery srcs="${escapeAttr(srcs)}" caption="${escapeAttr(caption)}">}}`
        : `{{<gallery srcs="${escapeAttr(srcs)}">}}`
    }
    case 'video': {
      const key = node.attrs?.key
      if (!key) return null
      const caption = node.attrs?.caption
      return caption
        ? `{{<video src="${mediaPath(key)}" caption="${escapeAttr(caption)}">}}`
        : `{{<video src="${mediaPath(key)}">}}`
    }
    case 'figure': {
      const key = node.attrs?.key
      if (!key) return null
      const parts = [`src="${mediaPath(key)}"`]
      if (node.attrs?.caption) parts.push(`caption="${escapeAttr(node.attrs.caption)}"`)
      parts.push(`align="${node.attrs?.align ?? 'center'}"`)
      return `{{<figure ${parts.join(' ')}>}}`
    }
    default:
      return null
  }
}

const SHORTCODE_RE = /^\{\{[<%]-?\s*(\w+)\s*([\s\S]*?)\s*-?[>%]\}\}$/

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) attrs[m[1]] = unescapeAttr(m[2])
  return attrs
}

/** Returns a media node, or null when the line is not a shortcode we own. */
export function parseShortcode(line: string): PMNode | null {
  const m = SHORTCODE_RE.exec(line.trim())
  if (!m) return null
  const [, name, rawAttrs] = m
  const attrs = parseAttrs(rawAttrs)

  if (name === 'gallery') {
    const keys = (attrs.srcs ?? '')
      .split(',')
      .map((s) => keyFromMediaPath(s))
      .filter((k): k is string => !!k)
    if (!keys.length) return null
    return { type: 'gallery', attrs: { keys, caption: attrs.caption ?? null } }
  }
  if (name === 'video') {
    const key = keyFromMediaPath(attrs.src ?? '')
    if (!key) return null
    return { type: 'video', attrs: { key, caption: attrs.caption ?? null } }
  }
  if (name === 'figure') {
    const key = keyFromMediaPath(attrs.src ?? '')
    if (!key) return null
    return {
      type: 'figure',
      attrs: { key, caption: attrs.caption ?? null, align: attrs.align ?? 'center' },
    }
  }
  return null
}

// ---------------------------------------------------------------- blocks

function serializeListItem(item: PMNode, bullet: string, indent: string): string {
  const lines: string[] = []
  const blocks = item.content ?? []
  blocks.forEach((b, idx) => {
    if (b.type === 'paragraph') {
      const text = serializeInline(b.content)
      lines.push(idx === 0 ? `${indent}${bullet} ${text}` : `${indent}  ${text}`)
    } else if (b.type === 'bulletList' || b.type === 'orderedList') {
      lines.push(serializeList(b, indent + '  '))
    }
  })
  return lines.join('\n')
}

function serializeList(node: PMNode, indent = ''): string {
  const ordered = node.type === 'orderedList'
  return (node.content ?? [])
    .map((item, i) => serializeListItem(item, ordered ? `${i + 1}.` : '-', indent))
    .join('\n')
}

export function serializeDoc(doc: PMNode): string {
  const blocks: string[] = []

  for (const node of doc.content ?? []) {
    const shortcode = serializeShortcode(node)
    if (shortcode) {
      blocks.push(shortcode)
      continue
    }
    switch (node.type) {
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 2), 4)
        blocks.push(`${'#'.repeat(level)} ${serializeInline(node.content)}`)
        break
      }
      case 'paragraph': {
        const text = serializeInline(node.content)
        // A genuinely empty paragraph carries no meaning in markdown; drop it.
        if (text.trim()) blocks.push(text)
        break
      }
      case 'bulletList':
      case 'orderedList':
        blocks.push(serializeList(node))
        break
      case 'blockquote':
        blocks.push(
          (node.content ?? [])
            .map((p) => `> ${serializeInline(p.content)}`)
            .join('\n>\n'),
        )
        break
      case 'horizontalRule':
        // `***` rather than `---`, which would be ambiguous with front matter.
        blocks.push('***')
        break
      case 'codeBlock':
        blocks.push('```' + (node.attrs?.language ?? '') + '\n' + (node.content?.[0]?.text ?? '') + '\n```')
        break
      default:
        break
    }
  }
  return blocks.join('\n\n')
}

export function parseDoc(body: string): PMNode {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const content: PMNode[] = []
  let i = 0

  const isBlank = (s: string) => s.trim() === ''

  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    // shortcode — always a whole line of its own
    const sc = parseShortcode(line)
    if (sc) {
      content.push(sc)
      i++
      continue
    }

    // heading
    const h = /^(#{2,4})\s+(.*)$/.exec(line)
    if (h) {
      content.push({
        type: 'heading',
        attrs: { level: h[1].length },
        content: parseInline(h[2]),
      })
      i++
      continue
    }

    // horizontal rule
    if (/^(\*\*\*|___)\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' })
      i++
      continue
    }

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence
      content.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text: buf.join('\n') }],
      })
      continue
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const paras: PMNode[] = []
      while (i < lines.length && /^>/.test(lines[i])) {
        const text = lines[i].replace(/^>\s?/, '')
        if (text.trim()) paras.push({ type: 'paragraph', content: parseInline(text) })
        i++
      }
      content.push({ type: 'blockquote', content: paras })
      continue
    }

    // lists
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const { node, next } = parseList(lines, i, 0)
      content.push(node)
      i = next
      continue
    }

    // paragraph — runs until a blank line or a block that starts something else
    const buf: string[] = []
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i]
      if (parseShortcode(l) || /^(#{2,4})\s/.test(l) || /^>/.test(l) || /^```/.test(l)) break
      buf.push(l)
      i++
    }
    if (buf.length) {
      content.push({ type: 'paragraph', content: parseInline(buf.join('\n')) })
    }
  }

  return { type: 'doc', content }
}

function indentOf(line: string): number {
  return /^(\s*)/.exec(line)![1].length
}

function parseList(lines: string[], start: number, depth: number): { node: PMNode; next: number } {
  const first = lines[start]
  const baseIndent = indentOf(first)
  const ordered = /^\s*\d+\.\s/.test(first)
  const items: PMNode[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') break
    const ind = indentOf(line)
    if (ind < baseIndent) break
    const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (!m) break
    const thisOrdered = /\d+\./.test(m[1])
    if (ind === baseIndent && thisOrdered !== ordered) break

    if (ind > baseIndent) {
      // nested list belongs to the previous item
      const { node, next } = parseList(lines, i, depth + 1)
      const prev = items[items.length - 1]
      if (prev) prev.content!.push(node)
      i = next
      continue
    }

    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInline(m[2]) }],
    })
    i++
  }

  return { node: { type: ordered ? 'orderedList' : 'bulletList', content: items }, next: i }
}

// ---------------------------------------------------------------- front matter

export function serializeFrontMatter(fm: FrontMatter): string {
  const lines = ['---']
  lines.push(`date: '${fm.date}'`)
  lines.push(`draft: ${fm.draft}`)
  lines.push(`title: '${fm.title.replace(/'/g, "''")}'`)
  if (fm.description) lines.push(`description: '${fm.description.replace(/'/g, "''")}'`)
  if (fm.cover) {
    lines.push('cover:')
    lines.push(`  image: "${mediaPath(fm.cover)}"`)
    // Always false, never surfaced in the UI: the field that silently breaks
    // cover images when it is wrong.
    lines.push('  relative: false')
  }
  lines.push('---')
  return lines.join('\n')
}

export function parseFrontMatter(raw: string): FrontMatter {
  const fm: FrontMatter = { title: '', date: '', draft: true }
  let inCover = false
  for (const line of raw.split('\n')) {
    const cover = /^\s{2}image:\s*"(.*?)"/.exec(line)
    if (inCover && cover) {
      const key = keyFromMediaPath(cover[1])
      if (key) fm.cover = key
      continue
    }
    if (/^cover:/.test(line)) {
      inCover = true
      continue
    }
    if (!/^\s/.test(line)) inCover = false

    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.replace(/^['"]|['"]$/g, '').replace(/''/g, "'")
    if (key === 'title') fm.title = val
    else if (key === 'date') fm.date = val
    else if (key === 'draft') fm.draft = rawVal.trim() === 'true'
    else if (key === 'description') fm.description = val
  }
  return fm
}

// ---------------------------------------------------------------- post

export function serializePost(post: Post): string {
  const body = serializeDoc(post.doc)
  return `${serializeFrontMatter(post.frontMatter)}\n\n${body}\n`
}

export function parsePost(slug: string, markdown: string): Post {
  const text = markdown.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const frontMatter = m ? parseFrontMatter(m[1]) : { title: slug, date: '', draft: true }
  const body = m ? text.slice(m[0].length) : text
  return { slug, frontMatter, doc: parseDoc(body) }
}

/** Every asset key referenced by a document, in order of appearance. */
export function referencedKeys(doc: PMNode): string[] {
  const keys: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type === 'gallery') keys.push(...(node.attrs?.keys ?? []))
    else if (node.type === 'video' || node.type === 'figure') {
      if (node.attrs?.key) keys.push(node.attrs.key)
    }
  }
  return keys
}
