// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { appendToGallery } from '../insert.js'
import { assetStore } from '../assetStore.js'
import type { Asset } from '../../../../shared/types.js'

// Stand-ins for the real nodes, without their React views.
const atom = (name: string, attrs: Record<string, unknown>) =>
  Node.create({
    name,
    group: 'block',
    atom: true,
    addAttributes: () => Object.fromEntries(Object.entries(attrs).map(([k, d]) => [k, { default: d }])),
    parseHTML: () => [{ tag: `div[data-${name}]` }],
    renderHTML: () => ['div', { [`data-${name}`]: '' }],
  })
const Gallery = atom('gallery', { keys: [], caption: null })
const Video = atom('video', { key: '', caption: null })
const Figure = atom('figure', { key: '', caption: null, align: 'center' })

let editor: Editor
afterEach(() => editor?.destroy())

function make(galleryKeys: string[]) {
  editor = new Editor({
    extensions: [StarterKit, Gallery, Video, Figure],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'gallery', attrs: { keys: galleryKeys, caption: 'trip' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    },
  })
  // The gallery sits right after the first paragraph.
  return editor.state.doc.child(0).nodeSize
}

const kinds = (assets: [string, 'image' | 'video'][]) =>
  assetStore.replaceAll(assets.map(([key, kind]) => ({ key, kind }) as Asset))

const types = () => (editor.getJSON().content ?? []).map((n) => n.type)

describe('appendToGallery', () => {
  it('appends new images to the gallery at the position, keeping its caption', () => {
    kinds([['a', 'image'], ['b', 'image'], ['c', 'image']])
    const pos = make(['a'])
    appendToGallery(editor, pos, ['b', 'a', 'c'])
    const gallery = editor.state.doc.nodeAt(pos)!
    expect(gallery.attrs.keys).toEqual(['a', 'b', 'c'])
    expect(gallery.attrs.caption).toBe('trip')
    expect(types()).toEqual(['paragraph', 'gallery', 'paragraph'])
  })

  it('puts videos just after the gallery', () => {
    kinds([['a', 'image'], ['b', 'image'], ['v', 'video']])
    const pos = make(['a'])
    appendToGallery(editor, pos, ['b', 'v'])
    expect(editor.state.doc.nodeAt(pos)!.attrs.keys).toEqual(['a', 'b'])
    expect(types()).toEqual(['paragraph', 'gallery', 'video', 'paragraph'])
  })

  it('falls back to a normal insert when there is no gallery there', () => {
    kinds([['b', 'image']])
    make(['a'])
    appendToGallery(editor, 1, ['b'])
    expect(types()).toContain('figure')
  })
})
