import React, { useEffect, useState } from 'react'

interface Comment {
  id: number
  parent: number | null
  name: string
  body: string
  at: number
}

const when = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * The comments visitors left on one post, so the owner can remove any they do
 * not want there. Deleting asks once more on the same button, since it cannot
 * be undone, and a top comment takes its replies with it.
 */
export function CommentsDialog({ slug, title, onClose }: { slug: string; title: string; onClose: () => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.listComments(slug).then((res: any) => {
      if (res.ok) setComments(res.comments)
      else setError(res.message)
    })
  }, [slug])

  const remove = async (c: Comment) => {
    if (confirming !== c.id) return setConfirming(c.id)
    setBusy(true)
    const res = await window.api.deleteComment(c.id)
    setBusy(false)
    setConfirming(null)
    if (!res.ok) return setError(res.message)
    setError(null)
    setComments((all) => all?.filter((x) => x.id !== c.id && x.parent !== c.id) ?? null)
  }

  const tops = comments?.filter((c) => c.parent == null) ?? []
  const repliesTo = (id: number) => comments?.filter((c) => c.parent === id) ?? []

  const item = (c: Comment, replies = 0) => (
    <div key={c.id} className="comment-item">
      <div className="comment-meta">
        <strong>{c.name}</strong> · {when(c.at)}
        <span className="grow" />
        <button className="ghost danger" disabled={busy} onClick={() => remove(c)}>
          {confirming === c.id
            ? replies
              ? `Delete with ${replies} ${replies === 1 ? 'reply' : 'replies'}?`
              : 'Delete?'
            : 'Delete'}
        </button>
      </div>
      <p>{c.body}</p>
    </div>
  )

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="modal comments-modal">
        <h3>Comments on “{title || 'Untitled'}”</h3>
        {error && <div className="banner err">{error}</div>}
        {comments === null && !error && (
          <p className="hint">
            <span className="spinner" style={{ verticalAlign: -2, marginRight: 6 }} />
            Loading
          </p>
        )}
        {comments && !tops.length && <p className="hint">No one has commented on this post yet.</p>}
        {tops.map((c) => {
          const replies = repliesTo(c.id)
          return (
            <div key={c.id} className="comment-thread">
              {item(c, replies.length)}
              {replies.length > 0 && <div className="comment-replies">{replies.map((r) => item(r))}</div>}
            </div>
          )
        })}
        <div className="actions">
          <button onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
