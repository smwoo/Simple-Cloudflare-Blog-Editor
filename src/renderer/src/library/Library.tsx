import React, { useMemo, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/react'
import { useAssets, assetStore, posterUrl, outputUrl } from '../editor/assetStore.js'
import { insertAssets } from '../editor/insert.js'
import type { Asset } from '../../../shared/types.js'

interface Props {
  postSlug: string
  editor: TipTapEditor | null
  /** Ask for a group name, then ingest. */
  onAddFiles: (files: string[]) => void
  pendingCount: number
}

type Scope = 'post' | 'all'

const COLLAPSED_KEY = 'library.collapsed'

/** Group labels the user has folded away, kept across restarts. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(label)) next.add(label)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  return [collapsed, toggle] as const
}

export function Library({ postSlug, editor, onAddFiles, pendingCount }: Props) {
  const assets = useAssets()
  const [scope, setScope] = useState<Scope>('post')
  const [selected, setSelected] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const [collapsed, toggleGroup] = useCollapsed()

  const visible = useMemo(
    () => (scope === 'post' ? assets.filter((a) => a.postSlug === postSlug) : assets),
    [assets, scope, postSlug],
  )

  const groups = useMemo(() => {
    const map = new Map<string, Asset[]>()
    for (const a of visible) {
      const label = scope === 'post' ? a.group : `${a.postSlug} · ${a.group}`
      const list = map.get(label) ?? []
      list.push(a)
      map.set(label, list)
    }
    return [...map.entries()]
  }, [visible, scope])

  const unplaced = visible.filter((a) => !assetStore.isPlaced(a.key)).length

  const toggle = (key: string, additive: boolean) =>
    setSelected((prev) =>
      additive
        ? prev.includes(key)
          ? prev.filter((k) => k !== key)
          : [...prev, key]
        : prev.length === 1 && prev[0] === key
          ? []
          : [key],
    )

  const insert = () => {
    if (editor && selected.length) {
      insertAssets(editor, selected)
      setSelected([])
    }
  }

  const pickFiles = async () => {
    const files = await window.api.pickFiles()
    if (files.length) onAddFiles(files)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const paths = Array.from(e.dataTransfer.files ?? [])
      .map((f) => window.api.pathForFile(f))
      .filter(Boolean)
    if (paths.length) onAddFiles(paths)
  }

  return (
    <div className="pane media">
      <div className="titlebar-pad" />
      <div className="pane-head">
        <h2>Photos</h2>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
          style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
        >
          <option value="post">This post</option>
          <option value="all">All photos</option>
        </select>
      </div>

      <div className="pane-body">
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={pickFiles}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          Drop photos or video here
          <br />
          <span style={{ fontSize: 11.5 }}>or click to choose</span>
        </div>

        {!visible.length && (
          <div className="empty">
            No photos yet.
            <br />
            Drag some in and they will be prepared for the web automatically.
          </div>
        )}

        {groups.map(([label, items]) => {
          const open = !collapsed.has(label)
          return (
            <div key={label}>
              <button className="group-head" aria-expanded={open} onClick={() => toggleGroup(label)}>
                <span className="chev">{open ? '▾' : '▸'}</span>
                {label || 'photos'}
                <span className="count">{items.length}</span>
              </button>
              {open && (
                <div className="lib-grid">
                  {items.map((a) => (
                    <Tile
                      key={a.key}
                      asset={a}
                      selected={selected.includes(a.key)}
                      onToggle={(additive) => toggle(a.key, additive)}
                      selection={selected.includes(a.key) ? selected : [a.key]}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="insert-bar">
        {selected.length > 0 ? (
          <>
            <button className="primary" onClick={insert} style={{ flex: 1 }}>
              Insert {selected.length === 1 ? 'photo' : `${selected.length} as gallery`}
            </button>
            <button className="ghost" onClick={() => setSelected([])}>
              Clear
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            {pendingCount > 0 && (
              <div>
                <span className="spinner" style={{ marginRight: 6, verticalAlign: -2 }} />
                Preparing {pendingCount} item{pendingCount > 1 ? 's' : ''}…
              </div>
            )}
            {unplaced > 0 && (
              <div title="Uploaded but not used in this post">
                {unplaced} not used in this post
              </div>
            )}
            {pendingCount === 0 && unplaced === 0 && visible.length > 0 && (
              <div>Click a photo to insert it. Shift-click for several.</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({
  asset,
  selected,
  onToggle,
  selection,
}: {
  asset: Asset
  selected: boolean
  onToggle: (additive: boolean) => void
  selection: string[]
}) {
  const [broken, setBroken] = useState(false)
  const ready = asset.state !== 'converting' && !broken
  const placed = assetStore.isPlaced(asset.key)
  const fraction = assetStore.fraction(asset.key)

  return (
    <div
      className={`tile ${selected ? 'on' : ''}`}
      draggable={ready}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-asset-keys', JSON.stringify(selection))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={(e) => onToggle(e.shiftKey || e.metaKey || e.ctrlKey)}
      title={asset.error ?? asset.key}
    >
      {ready ? (
        <img
          src={asset.kind === 'video' ? posterUrl(asset.key) : outputUrl(asset.key)}
          alt=""
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        <div className="ph">
          {asset.state === 'failed' ? 'failed' : 'preparing'}
          {fraction !== undefined && <div className="bar" style={{ width: `${fraction * 100}%` }} />}
        </div>
      )}
      {placed && <span className="used" title="Used in this post" />}
      {asset.state === 'failed' && (
        <button
          className="state retry"
          onClick={(e) => {
            e.stopPropagation()
            window.api.retryMedia(asset.key)
          }}
        >
          failed · retry
        </button>
      )}
      {asset.state !== 'live' && asset.state !== 'failed' && (
        <div className="state">{asset.state === 'uploading' ? 'uploading' : 'preparing'}</div>
      )}
      {asset.kind === 'video' && asset.state === 'live' && <div className="state">video</div>}
    </div>
  )
}
