/**
 * The three media shortcodes as atomic TipTap nodes.
 *
 * `atom: true` plus a node view is the whole reason TipTap was chosen: each
 * renders as the real thing, and the cursor can never get inside one, so the
 * shortcode syntax cannot be broken by clicking in the wrong place — there is
 * no text there to edit.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useAsset, outputUrl, posterUrl, playbackUrl } from './assetStore.js'

// ---------------------------------------------------------------- shared bits

/** Placeholder for an asset that is still converting or uploading. */
function Pending({ keyName }: { keyName: string }) {
  const { asset, fraction } = useAsset(keyName)
  const label =
    asset?.state === 'failed'
      ? 'failed'
      : asset?.state === 'uploading'
        ? 'uploading'
        : 'preparing'
  return (
    <div className="ph" title={asset?.error ?? label}>
      {label}
      {fraction !== undefined && <div className="bar" style={{ width: `${fraction * 100}%` }} />}
    </div>
  )
}

/** A thumbnail that falls back to a placeholder until the derivative exists. */
function Thumb({ keyName }: { keyName: string }) {
  const { asset } = useAsset(keyName)
  const [broken, setBroken] = useState(false)
  const ready = asset && asset.state !== 'converting' && !broken
  if (!ready) return <Pending keyName={keyName} />
  return (
    <img
      src={asset!.kind === 'video' ? posterUrl(keyName) : outputUrl(keyName)}
      alt=""
      onError={() => setBroken(true)}
      draggable={false}
    />
  )
}

function CaptionField({
  value,
  placeholder,
  onChange,
}: {
  value: string | null
  placeholder: string
  onChange: (v: string | null) => void
}) {
  // The attribute round-trips through ProseMirror and comes back a render
  // late, so binding the input to it straight would reset the text and throw
  // the cursor to the end. Hold the text here and take outside changes (undo,
  // sync) only while the field isn't being typed in.
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value ?? '')
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(value ?? '')
  }, [value])
  return (
    <input
      ref={ref}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value || null)
      }}
      // Keep keystrokes out of ProseMirror's handler.
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}

// ---------------------------------------------------------------- gallery

function GalleryView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const keys: string[] = node.attrs.keys ?? []
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const move = (from: number, to: number) => {
    if (from === to) return
    const next = [...keys]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    updateAttributes({ keys: next })
  }

  const remove = (i: number) => {
    const next = keys.filter((_, n) => n !== i)
    // An empty gallery is meaningless; drop the node rather than leave a husk.
    if (!next.length) deleteNode()
    else updateAttributes({ keys: next })
  }

  /** Dropping library tiles onto a gallery appends rather than making a second one. */
  const onDropKeys = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-asset-keys')
    if (!raw) return false
    e.preventDefault()
    const incoming: string[] = JSON.parse(raw)
    updateAttributes({ keys: [...keys, ...incoming.filter((k) => !keys.includes(k))] })
    return true
  }

  return (
    <NodeViewWrapper className={`node ${selected ? 'sel' : ''}`}>
      <div
        className="gal"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-asset-keys')) e.preventDefault()
        }}
        onDrop={onDropKeys}
      >
        {keys.map((key, i) => (
          <figure
            key={key}
            className={over === i ? 'dragover' : ''}
            draggable
            onDragStart={(e) => {
              setDragFrom(i)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', key)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(i)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              if (onDropKeys(e)) return
              e.preventDefault()
              if (dragFrom !== null) move(dragFrom, i)
              setDragFrom(null)
              setOver(null)
            }}
          >
            <Thumb keyName={key} />
            <button className="x" onClick={() => remove(i)} title="Remove">
              ✕
            </button>
          </figure>
        ))}
        <div
          className="drop"
          onClick={() => editor.commands.requestMedia?.({ target: 'gallery' })}
          title="Add more photos"
        >
          + add
        </div>
      </div>
      <div className="node-bar">
        <CaptionField
          value={node.attrs.caption}
          placeholder="Caption (optional)"
          onChange={(caption) => updateAttributes({ caption })}
        />
        <button className="ghost" onClick={deleteNode} title="Delete gallery">
          ✕
        </button>
      </div>
    </NodeViewWrapper>
  )
}

export const Gallery = Node.create({
  name: 'gallery',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      keys: { default: [] as string[] },
      caption: { default: null as string | null },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-gallery]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-gallery': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(GalleryView)
  },
})

// ---------------------------------------------------------------- video

function VideoView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const key: string = node.attrs.key
  const { asset } = useAsset(key)
  const ready = asset && asset.state !== 'converting'
  // A video from another computer has no H.264 copy here, and Windows often
  // cannot decode the HEVC web file itself. It still plays on the blog.
  const [unplayable, setUnplayable] = useState(false)

  return (
    <NodeViewWrapper className={`node ${selected ? 'sel' : ''}`}>
      {ready && unplayable ? (
        <div className="ph" style={{ aspectRatio: '16/9', flexDirection: 'column', gap: 8 }}>
          <span>This video can't play on this computer. It plays on your blog.</span>
          <button className="ghost" onClick={() => window.api.openPostOnBlog(asset!.postSlug)}>
            Open on the blog ↗
          </button>
        </div>
      ) : ready ? (
        <video
          controls
          preload="metadata"
          poster={posterUrl(key)}
          src={playbackUrl(key)}
          onError={() => asset?.originalAvailable === false && setUnplayable(true)}
        />
      ) : (
        <div className="ph" style={{ aspectRatio: '16/9' }}>
          <Pending keyName={key} />
        </div>
      )}
      <div className="node-bar">
        <CaptionField
          value={node.attrs.caption}
          placeholder="Caption (optional)"
          onChange={(caption) => updateAttributes({ caption })}
        />
        <button className="ghost" onClick={deleteNode} title="Delete video">
          ✕
        </button>
      </div>
    </NodeViewWrapper>
  )
}

export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { key: { default: '' }, caption: { default: null as string | null } }
  },
  parseHTML() {
    return [{ tag: 'div[data-video]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-video': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(VideoView)
  },
})

// ---------------------------------------------------------------- figure

function FigureView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const key: string = node.attrs.key
  const { asset } = useAsset(key)
  const align: string = node.attrs.align ?? 'center'
  const ready = asset && asset.state !== 'converting'

  return (
    <NodeViewWrapper className={`node ${selected ? 'sel' : ''}`}>
      <div style={{ textAlign: align as any }}>
        {ready ? (
          <img className="single" src={outputUrl(key)} alt={node.attrs.caption ?? ''} />
        ) : (
          <div className="ph" style={{ aspectRatio: '3/2' }}>
            <Pending keyName={key} />
          </div>
        )}
      </div>
      <div className="node-bar">
        <CaptionField
          value={node.attrs.caption}
          placeholder="Caption (doubles as alt text)"
          onChange={(caption) => updateAttributes({ caption })}
        />
        <span className="align">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              className={align === a ? 'on' : 'ghost'}
              onClick={() => updateAttributes({ align: a })}
              title={`Align ${a}`}
            >
              {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
            </button>
          ))}
        </span>
        <button className="ghost" onClick={deleteNode} title="Delete image">
          ✕
        </button>
      </div>
    </NodeViewWrapper>
  )
}

export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      key: { default: '' },
      caption: { default: null as string | null },
      align: { default: 'center' },
    }
  },
  parseHTML() {
    return [{ tag: 'figure[data-figure]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-figure': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureView)
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mediaRequest: {
      requestMedia: (opts: { target: 'gallery' | 'cursor' }) => ReturnType
    }
  }
}
