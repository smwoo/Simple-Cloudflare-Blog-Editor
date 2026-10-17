import React, { useState } from 'react'

/**
 * Confirm deleting a post. Deleting is the one action in the app that cannot
 * be undone from inside it, so it always asks, and says what goes where.
 */
export function DeleteDialog({
  title,
  published,
  mediaCount,
  onConfirm,
  onCancel,
}: {
  title: string
  published: boolean
  mediaCount: number
  onConfirm: (media: boolean) => void
  onCancel: () => void
}) {
  const [media, setMedia] = useState(true)

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="modal">
        <h3>Delete “{title || 'Untitled'}”?</h3>
        <p className="hint">
          {published
            ? 'It comes off your blog and out of this app. This cannot be undone.'
            : 'It goes out of this app. This cannot be undone.'}
        </p>
        {mediaCount > 0 && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14 }}>
            <input
              type="checkbox"
              checked={media}
              onChange={(e) => setMedia(e.target.checked)}
              style={{ width: 'auto', marginTop: 3 }}
            />
            <span>
              Also delete its {mediaCount} {mediaCount === 1 ? 'photo or video' : 'photos and videos'}{' '}
              from your blog
              <span className="hint" style={{ display: 'block' }}>
                Any that another post shows are kept. The originals stay on this computer.
              </span>
            </span>
          </label>
        )}
        <div className="actions">
          <button onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="danger" onClick={() => onConfirm(media && mediaCount > 0)}>
            Delete post
          </button>
        </div>
      </div>
    </div>
  )
}
