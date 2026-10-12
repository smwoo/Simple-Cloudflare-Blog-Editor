/**
 * The one insert path that all four ways of adding media converge on.
 *
 * Shape is chosen, not asked: 2+ images become a gallery, a single image a
 * figure, a video a video. Asking would be a question with an obvious answer,
 * which is friction for the sake of configurability nobody wants.
 */
import type { Editor } from '@tiptap/react'
import { assetStore } from './assetStore.js'

export function insertAssets(editor: Editor, keys: string[]): void {
  if (!keys.length) return

  const images: string[] = []
  const videos: string[] = []
  for (const key of keys) {
    const asset = assetStore.get(key)
    // An unknown key is almost certainly a just-dropped image; images are the
    // overwhelming majority and a wrong guess is visible and fixable.
    if (asset?.kind === 'video') videos.push(key)
    else images.push(key)
  }

  const chain = editor.chain().focus()

  if (images.length === 1) {
    chain.insertContent({ type: 'figure', attrs: { key: images[0], caption: null, align: 'center' } })
  } else if (images.length > 1) {
    chain.insertContent({ type: 'gallery', attrs: { keys: images, caption: null } })
  }
  for (const key of videos) {
    chain.insertContent({ type: 'video', attrs: { key, caption: null } })
  }
  chain.run()
}

/** Append to the gallery the cursor is in, else insert normally. */
export function appendToGalleryOrInsert(editor: Editor, keys: string[]): void {
  const { state } = editor
  const { $from } = state.selection
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'gallery') {
      const existing: string[] = node.attrs.keys ?? []
      editor
        .chain()
        .focus()
        .updateAttributes('gallery', {
          keys: [...existing, ...keys.filter((k) => !existing.includes(k))],
        })
        .run()
      return
    }
  }
  insertAssets(editor, keys)
}
