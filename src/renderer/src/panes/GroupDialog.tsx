import React, { useEffect, useRef, useState } from 'react'

/**
 * The single question ingest asks.
 *
 * Everything else is derived — the key, the folder, the filenames, the shape of
 * the insert — because asking would be friction with an obvious answer.
 */
export function GroupDialog({
  count,
  suggestions,
  onConfirm,
  onCancel,
}: {
  count: number
  suggestions: string[]
  onConfirm: (group: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const confirm = () => {
    const group = value.trim()
    if (group) onConfirm(group)
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>
          {count} {count === 1 ? 'item' : 'items'}
        </h3>
        <p className="hint" style={{ marginBottom: 16 }}>
          What should we call this group? It keeps photos from the same outing together.
        </p>
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="Tofino surf"
          list="group-suggestions"
        />
        <datalist id="group-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {suggestions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {suggestions.slice(0, 6).map((s) => (
              <button key={s} className="ghost" style={{ fontSize: 12 }} onClick={() => onConfirm(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!value.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
