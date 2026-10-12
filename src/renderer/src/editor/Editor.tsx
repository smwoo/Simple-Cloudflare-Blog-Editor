import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor as TipTapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Gallery, Video, Figure } from './nodes.js'
import { insertAssets } from './insert.js'
import { assetStore } from './assetStore.js'
import type { Post, PMNode } from '../../../shared/types.js'

export interface EditorHandle {
  editor: TipTapEditor | null
}

interface Props {
  post: Post
  onChange: (doc: PMNode) => void
  onEditorReady: (editor: TipTapEditor) => void
  /** Called when files are dropped onto the document, with the drop position. */
  onFilesDropped: (files: string[], insertAt: number | null) => void
}

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    // The app's own nodes replace these entirely.
    codeBlock: {},
    link: { openOnClick: false, autolink: true },
  }),
  Gallery,
  Video,
  Figure,
]

export function Editor({ post, onChange, onEditorReady, onFilesDropped }: Props) {
  const slug = post.slug
  const editor = useEditor(
    {
      extensions: EXTENSIONS,
      content: post.doc,
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDrop: (view, event) => {
          const dt = (event as DragEvent).dataTransfer
          if (!dt) return false

          // Library tiles dragged into the document.
          const assetKeys = dt.getData('application/x-asset-keys')
          if (assetKeys) {
            event.preventDefault()
            const pos = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            })
            if (pos) view.dispatch(view.state.tr.setSelection(
              (view.state.selection.constructor as any).near(view.state.doc.resolve(pos.pos)),
            ))
            insertAssets(editorRef.current!, JSON.parse(assetKeys))
            return true
          }

          // Files from Finder/Explorer.
          if (dt.files?.length) {
            event.preventDefault()
            const paths = Array.from(dt.files)
              .map((f) => window.api.pathForFile(f))
              .filter(Boolean)
            const pos = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            })
            onFilesDropped(paths, pos?.pos ?? null)
            return true
          }
          return false
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? [])
          if (!files.length) return false
          const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean)
          if (!paths.length) return false
          event.preventDefault()
          onFilesDropped(paths, null)
          return true
        },
      },
      onUpdate: ({ editor }) => {
        const doc = editor.getJSON() as PMNode
        onChange(doc)
        // Keep the library's "placed" markers in step with the document.
        assetStore.setPlaced(collectKeys(doc))
      },
    },
    // Rebuild when switching posts, so content and history reset together.
    [slug],
  )

  const editorRef = useRef<TipTapEditor | null>(null)
  editorRef.current = editor

  useEffect(() => {
    if (editor) {
      onEditorReady(editor)
      assetStore.setPlaced(collectKeys(post.doc))
    }
  }, [editor])

  if (!editor) return <div className="editor-scroll" />

  return (
    <>
      <Toolbar editor={editor} />
      <div className="editor-scroll">
        <EditorContent editor={editor} />
      </div>
    </>
  )
}

function collectKeys(doc: PMNode): string[] {
  const keys: string[] = []
  const walk = (n: PMNode) => {
    if (n.type === 'gallery') keys.push(...(n.attrs?.keys ?? []))
    else if (n.type === 'video' || n.type === 'figure') {
      if (n.attrs?.key) keys.push(n.attrs.key)
    }
    n.content?.forEach(walk)
  }
  walk(doc)
  return keys
}

function Toolbar({ editor }: { editor: TipTapEditor }) {
  const [, force] = useState(0)
  useEffect(() => {
    const rerender = () => force((n) => n + 1)
    editor.on('selectionUpdate', rerender)
    editor.on('transaction', rerender)
    return () => {
      editor.off('selectionUpdate', rerender)
      editor.off('transaction', rerender)
    }
  }, [editor])

  const btn = (label: string, active: boolean, run: () => void, title: string) => (
    <button key={title} className={active ? 'on' : ''} onClick={run} title={title}>
      {label}
    </button>
  )

  const setLink = () => {
    const prev = editor.getAttributes('link').href ?? ''
    const href = window.prompt('Link address', prev)
    if (href === null) return
    if (href === '') editor.chain().focus().unsetLink().run()
    else editor.chain().focus().setLink({ href }).run()
  }

  return (
    <div className="toolbar">
      {btn('H2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'Heading')}
      {btn('H3', editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'Subheading')}
      <span className="sep" />
      {btn('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {btn('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic')}
      {btn('S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), 'Strikethrough')}
      {btn('Link', editor.isActive('link'), setLink, 'Link')}
      <span className="sep" />
      {btn('• List', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bullet list')}
      {btn('1. List', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {btn('Quote', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Quote')}
      <span className="sep" />
      {btn('—', false, () => editor.chain().focus().setHorizontalRule().run(), 'Divider')}
    </div>
  )
}
