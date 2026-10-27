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

/**
 * Append images to the gallery at `pos`; videos go in just after it, since a
 * gallery only holds photos. Falls back to a normal insert if the gallery has
 * gone. Galleries are atoms, so the cursor is never inside one — the position
 * has to come from the gallery itself.
 */
export function appendToGallery(editor: Editor, pos: number, keys: string[]): void {
  const node = editor.state.doc.nodeAt(pos)
  if (node?.type.name !== 'gallery') return insertAssets(editor, keys)

  const existing: string[] = node.attrs.keys ?? []
  const videos = keys.filter((k) => assetStore.get(k)?.kind === 'video')
  const images = keys.filter((k) => !videos.includes(k) && !existing.includes(k))

  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, keys: [...existing, ...images] })
      return true
    })
  if (videos.length) {
    chain.insertContentAt(
      pos + node.nodeSize,
      videos.map((key) => ({ type: 'video', attrs: { key, caption: null } })),
    )
  }
  chain.run()
}
