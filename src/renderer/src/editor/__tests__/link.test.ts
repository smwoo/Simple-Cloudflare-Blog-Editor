// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { normalizeHref, startLink, applyLink, removeLink } from '../link.js'
import { serializeDoc } from '../../../../shared/markdown.js'

let editor: Editor
afterEach(() => editor?.destroy())

function make(text: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  })
  return editor
}

const md = () => serializeDoc(editor.getJSON() as any).trim()

/** Select `word` inside the first paragraph (positions are 1-based inside it). */
function select(word: string) {
  const i = editor.state.doc.textContent.indexOf(word)
  editor.commands.setTextSelection({ from: i + 1, to: i + 1 + word.length })
}

describe('normalizeHref', () => {
  it('adds https to bare domains', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com')
    expect(normalizeHref('  www.example.com/a  ')).toBe('https://www.example.com/a')
  })
  it('leaves explicit schemes, paths and anchors alone', () => {
    expect(normalizeHref('http://x.com')).toBe('http://x.com')
    expect(normalizeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(normalizeHref('/posts/nov-2026/')).toBe('/posts/nov-2026/')
    expect(normalizeHref('#top')).toBe('#top')
  })
  it('turns a bare email into mailto', () => {
    expect(normalizeHref('a@b.co')).toBe('mailto:a@b.co')
  })
  it('treats whitespace as empty', () => {
    expect(normalizeHref('   ')).toBe('')
  })
})

describe('link editing', () => {
  it('links the selected text', () => {
    make('Read the surf report today')
    select('surf report')
    applyLink(editor, { ...startLink(editor), href: 'surfline.com' })
    expect(md()).toBe('Read the [surf report](https://surfline.com) today')
  })

  it('survives the editor losing its selection while the address is typed', () => {
    make('Read the surf report today')
    select('surf report')
    const draft = startLink(editor)
    editor.commands.setTextSelection(1) // clicking into the address field moves focus away
    applyLink(editor, { ...draft, href: 'https://surfline.com' })
    expect(md()).toBe('Read the [surf report](https://surfline.com) today')
  })

  it('pre-fills and replaces an existing address from a cursor inside the link', () => {
    make('Read the surf report today')
    select('surf report')
    applyLink(editor, { ...startLink(editor), href: 'https://old.com' })
    const i = editor.state.doc.textContent.indexOf('report')
    editor.commands.setTextSelection(i + 2)
    const draft = startLink(editor)
    expect(draft.href).toBe('https://old.com')
    applyLink(editor, { ...draft, href: 'https://new.com' })
    expect(md()).toBe('Read the [surf report](https://new.com) today')
  })

  it('removes the whole link from a cursor inside it', () => {
    make('Read the surf report today')
    select('surf report')
    applyLink(editor, { ...startLink(editor), href: 'https://x.com' })
    editor.commands.setTextSelection(editor.state.doc.textContent.indexOf('report') + 2)
    removeLink(editor, startLink(editor))
    expect(md()).toBe('Read the surf report today')
  })

  it('clearing the address removes the link', () => {
    make('Read the surf report today')
    select('surf report')
    applyLink(editor, { ...startLink(editor), href: 'https://x.com' })
    select('surf report')
    applyLink(editor, { ...startLink(editor), href: '' })
    expect(md()).toBe('Read the surf report today')
  })

  it('with nothing selected, inserts the address as linked text', () => {
    make('See ')
    editor.commands.setTextSelection(5)
    applyLink(editor, { ...startLink(editor), href: 'example.com' })
    expect(md()).toBe('See [https://example.com](https://example.com)')
  })
})
