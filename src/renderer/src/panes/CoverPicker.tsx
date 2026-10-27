import React, { useEffect, useRef, useState } from 'react'
import { outputUrl } from '../editor/assetStore.js'
import type { Asset } from '../../../shared/types.js'

/**
 * Cover photo: pick from this post's photos by sight. The button shows the
 * current cover; clicking it opens a grid of the post's photos.
 */
export function CoverPicker({
  cover,
  postSlug,
  assets,
  onPick,
}: {
  cover?: string
  postSlug: string
  assets: Asset[]
  onPick: (key: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const options = assets.filter((a) => a.postSlug === postSlug && a.kind === 'image')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (key: string | undefined) => {
    onPick(key)
    setOpen(false)
  }

  return (
    <div className="cover-picker" ref={ref}>
      <button className="cover-current" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {cover ? <CoverThumb keyName={cover} /> : <span className="cover-none" />}
        <span>{cover ? 'Change cover' : 'Choose a cover'}</span>
      </button>
      {open && (
        <div className="cover-pop">
          {options.length ? (
            <div className="cover-grid">
              <button className={!cover ? 'on' : ''} onClick={() => pick(undefined)} title="No cover">
                None
              </button>
              {options.map((a) => (
                <button
                  key={a.key}
                  className={a.key === cover ? 'on' : ''}
                  onClick={() => pick(a.key)}
                  title={`${a.group} · ${a.key.split('/').pop()}`}
                >
                  <CoverThumb keyName={a.key} state={a.state} />
                </button>
              ))}
            </div>
          ) : (
            <div className="cover-empty">Add photos to this post to choose a cover.</div>
          )}
        </div>
      )}
    </div>
  )
}

/** A photo, or a word while it is still being prepared. */
function CoverThumb({ keyName, state }: { keyName: string; state?: Asset['state'] }) {
  const [broken, setBroken] = useState(false)
  if (broken || state === 'local' || state === 'converting') {
    return <span className="cover-ph">{state === 'failed' ? 'failed' : 'preparing'}</span>
  }
  return <img src={outputUrl(keyName)} alt="" onError={() => setBroken(true)} draggable={false} />
}
