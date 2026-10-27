import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/react'
import { Editor } from './editor/Editor.js'
import { Library } from './library/Library.js'
import { Setup } from './setup/Setup.js'
import { GroupDialog } from './panes/GroupDialog.js'
import { Settings } from './panes/Settings.js'
import { DeleteDialog } from './panes/DeleteDialog.js'
import { assetStore, useAssets } from './editor/assetStore.js'
import { appendToGalleryOrInsert, insertAssets } from './editor/insert.js'
import type { Post, PMNode, BlogConfig, Asset } from '../../shared/types.js'

const EMPTY_DOC: PMNode = { type: 'doc', content: [{ type: 'paragraph' }] }

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function slugFor(title: string, date: string) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || `post-${date}`
}

export function App() {
  const [status, setStatus] = useState<any>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [current, setCurrent] = useState<Post | null>(null)
  const [editor, setEditor] = useState<TipTapEditor | null>(null)
  const [pendingFiles, setPendingFiles] = useState<{ files: string[]; place: boolean } | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [publishing, setPublishing] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string; log?: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null)
  const [sync, setSync] = useState<any>(null)
  /** Bumped when another computer's version replaces the open post, to reload the editor. */
  const [reloads, setReloads] = useState(0)
  const assets = useAssets()

  // ---------------------------------------------------------------- boot

  const refresh = useCallback(async () => {
    const list = await window.api.listPosts()
    setPosts(list)
    assetStore.replaceAll(await window.api.listMedia())
    return list
  }, [])

  useEffect(() => {
    ;(async () => {
      const s = await window.api.status()
      setStatus(s)
      if (s.configured) {
        const list = await refresh()
        if (list.length) setCurrent(list[0])
      }
    })()
  }, [refresh])

  useEffect(
    () =>
      window.api.onMediaProgress((p) => {
        assetStore.applyProgress(p)
        setPendingCount((n) => (p.state === 'live' || p.state === 'failed' ? Math.max(0, n - 1) : n))
      }),
    [],
  )

  useEffect(() => window.api.onPublishProgress((p) => setPublishing(publishLabel(p))), [])

  // ---------------------------------------------------------------- sharing

  useEffect(() => {
    window.api.syncStatus().then(setSync)
    return window.api.onSyncStatus(setSync)
  }, [])

  useEffect(
    () =>
      window.api.onSyncConflict((conflicts) => {
        const c = conflicts[0]
        setBanner({
          kind: 'warn',
          text:
            `A post was also changed on ${c.machineName}. Both versions are kept: the one from ` +
            `${c.machineName} is the draft "(from ${c.machineName})" in your list.`,
        })
        refresh()
      }),
    [refresh],
  )

  // ---------------------------------------------------------------- autosave

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<Post | null>(null)
  latest.current = current

  const scheduleSave = useCallback(() => {
    setSaveState('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const post = latest.current
      if (!post) return
      // Drafts are mirrored off-machine too: an unpublished post otherwise
      // exists in exactly one place, and a dead laptop takes it along.
      await window.api.saveDraft(post)
      saveTimer.current = null
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1600)
    }, 1200)
  }, [])

  useEffect(
    () =>
      window.api.onSyncChanged(async ({ posts: changed }) => {
        const list = await refresh()
        const open = latest.current
        if (!open || !changed.includes(open.slug)) return
        // Mid-edit: keep the writer's text. Their save is checked against the
        // version they started from, so the other version is kept as a copy.
        if (saveTimer.current) return
        const fresh = list.find((p) => p.slug === open.slug)
        if (!fresh) {
          setCurrent(list[0] ?? null)
          setBanner({ kind: 'warn', text: 'The post you had open was deleted on another computer.' })
          return
        }
        setCurrent(await window.api.readPost(open.slug))
        setReloads((n) => n + 1)
      }),
    [refresh],
  )

  const patchPost = (patch: Partial<Post> | ((p: Post) => Partial<Post>)) => {
    setCurrent((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      latest.current = next
      return next
    })
    scheduleSave()
  }

  // ---------------------------------------------------------------- actions

  const newPost = async () => {
    const date = todayISO()
    const post: Post = {
      slug: `untitled-${date}`,
      frontMatter: { title: '', date, draft: true },
      doc: EMPTY_DOC,
    }
    setCurrent(post)
    setPosts((p) => [post, ...p])
  }

  /**
   * Files arrived — ask the one question, then ingest. `place` puts them in the
   * post too; files added through the library stay there until inserted.
   */
  const onAddFiles = (files: string[], place = false) => setPendingFiles({ files, place })

  const ingest = async (group: string) => {
    const { files, place } = pendingFiles ?? { files: [], place: false }
    setPendingFiles(null)
    if (!current || !files.length) return

    // Give the post a real slug before keys are allocated against it.
    let post = current
    if (post.slug.startsWith('untitled-') && post.frontMatter.title.trim()) {
      post = await renameSlug(post)
    }

    const { keys, rejected } = await window.api.addMedia(files, post.slug, group)
    setPendingCount((n) => n + keys.length)
    assetStore.replaceAll(await window.api.listMedia())

    if (place && keys.length && editor) appendToGalleryOrInsert(editor, keys)
    if (rejected.length) {
      setBanner({
        kind: 'warn',
        text: `${rejected.length} file${rejected.length > 1 ? 's were' : ' was'} not a photo or video and ${rejected.length > 1 ? 'were' : 'was'} skipped.`,
      })
    }
  }

  const renameSlug = async (post: Post): Promise<Post> => {
    const slug = slugFor(post.frontMatter.title, post.frontMatter.date)
    if (slug === post.slug) return post
    await window.api.deletePost(post.slug)
    // A new name is a new post as far as other computers are concerned.
    const next = { ...post, slug, syncVersion: undefined }
    setCurrent(next)
    latest.current = next
    await window.api.saveDraft(next)
    await refresh()
    return next
  }

  const doPublish = async () => {
    if (!current) return
    let post = current
    if (!post.frontMatter.title.trim()) {
      setBanner({ kind: 'warn', text: 'Give the post a title first.' })
      return
    }
    if (post.slug.startsWith('untitled-')) post = await renameSlug(post)

    post = { ...post, frontMatter: { ...post.frontMatter, draft: false } }
    setCurrent(post)
    latest.current = post

    setPublishing('Publishing…')
    setBanner(null)
    const res = await window.api.publish(post)
    setPublishing(null)

    if (res.ok) {
      setBanner({ kind: 'ok', text: 'Published.' })
      await refresh()
    } else {
      setBanner({ kind: 'err', text: res.message ?? 'Could not publish.', log: res.log })
    }
  }

  /** A pending autosave would write the post back after it is deleted or moved. */
  const cancelAutosave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    setSaveState('idle')
  }

  const doUnpublish = async () => {
    if (!current) return
    cancelAutosave()
    const post = { ...current, frontMatter: { ...current.frontMatter, draft: true } }
    setCurrent(post)
    latest.current = post

    setPublishing('Updating…')
    setBanner(null)
    const res = await window.api.unpublish(post)
    setPublishing(null)
    await refresh()
    setBanner(
      res.ok
        ? { kind: 'ok', text: 'Back to draft. It is no longer on your blog.' }
        : { kind: 'err', text: res.message ?? 'Could not update your blog.', log: res.log },
    )
  }

  const doDelete = async (media: boolean) => {
    if (!current) return
    setConfirmDelete(false)
    cancelAutosave()

    setPublishing('Deleting…')
    setBanner(null)
    const res = await window.api.removePost(current.slug, media)
    setPublishing(null)
    const list = await refresh()
    setCurrent(list[0] ?? null)
    setBanner(
      res.ok
        ? { kind: 'ok', text: 'Post deleted.' }
        : { kind: 'err', text: res.message ?? 'Could not delete the post.', log: res.log },
    )
  }

  const togglePreview = async () => {
    if (previewOrigin) {
      await window.api.stopPreview()
      setPreviewOrigin(null)
      return
    }
    const res = await window.api.startPreview()
    if (res.ok) setPreviewOrigin(res.origin)
    else setBanner({ kind: 'err', text: 'Preview could not start.', log: res.error })
  }

  // ---------------------------------------------------------------- render

  if (!status) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        <span className="spinner" />
      </div>
    )
  }

  if (!status.configured) {
    return (
      <Setup
        onDone={async () => {
          const s = await window.api.status()
          setStatus(s)
          const list = await refresh()
          setCurrent(list[0] ?? null)
        }}
      />
    )
  }

  const config: BlogConfig = status.config
  const groupSuggestions = [
    ...new Set(assets.filter((a) => a.postSlug === current?.slug).map((a) => a.group)),
  ]

  return (
    <div className="app">
      {/* ------------- posts ------------- */}
      <div className="pane posts">
        <div className="titlebar-pad" />
        <div className="pane-head">
          <h2>Posts</h2>
          <button
            className="ghost icon-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <div className="pane-body">
          {posts.map((p) => (
            <button
              key={p.slug}
              className={`post-item ${current?.slug === p.slug ? 'on' : ''}`}
              onClick={async () => {
                const fresh = (await window.api.readPost(p.slug)) ?? p
                setCurrent(fresh)
              }}
            >
              <span className="t">{p.frontMatter.title || 'Untitled'}</span>
              <span className="d">
                {p.frontMatter.date}
                {p.frontMatter.draft && <> · <span className="badge">draft</span></>}
              </span>
            </button>
          ))}
        </div>
        <div className="insert-bar">
          <button className="primary" style={{ flex: 1 }} onClick={newPost}>
            New post
          </button>
        </div>
      </div>

      {/* ------------- editor ------------- */}
      <div className="pane editor">
        <div className="titlebar-pad" />
        {!current ? (
          <div className="empty" style={{ paddingTop: 100 }}>
            No post open.
            <br />
            Press <strong>New post</strong> to start writing.
          </div>
        ) : previewOrigin ? (
          <>
            <div className="pane-head">
              <h2>Preview</h2>
              <button onClick={togglePreview}>Back to writing</button>
            </div>
            <iframe className="preview" src={previewOrigin} title="Preview" />
          </>
        ) : (
          <>
            <div className="fm">
              <input
                className="title"
                value={current.frontMatter.title}
                placeholder="Post title"
                onChange={(e) =>
                  patchPost((p) => ({ frontMatter: { ...p.frontMatter, title: e.target.value } }))
                }
              />
              <input
                className="desc"
                value={current.frontMatter.description ?? ''}
                placeholder="A one-line description (optional)"
                onChange={(e) =>
                  patchPost((p) => ({
                    frontMatter: { ...p.frontMatter, description: e.target.value || undefined },
                  }))
                }
              />
              <div className="row" style={{ marginTop: 10 }}>
                <div className="narrow">
                  <label>Date</label>
                  <input
                    type="date"
                    value={current.frontMatter.date}
                    onChange={(e) =>
                      patchPost((p) => ({ frontMatter: { ...p.frontMatter, date: e.target.value } }))
                    }
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Cover photo</label>
                  <CoverPicker
                    cover={current.frontMatter.cover}
                    assets={assets}
                    postSlug={current.slug}
                    onPick={(cover) => patchPost((p) => ({ frontMatter: { ...p.frontMatter, cover } }))}
                  />
                </div>
              </div>
            </div>

            <SyncBanner sync={sync} onRetry={async () => setSync(await window.api.retryMigration())} />

            {banner && (
              <div style={{ padding: '10px 40px 0' }}>
                <div className={`banner ${banner.kind}`}>
                  {banner.text}
                  {banner.log && (
                    <>
                      {' '}
                      <button
                        className="ghost"
                        style={{ fontSize: 12, padding: '1px 6px' }}
                        onClick={async () =>
                          navigator.clipboard.writeText(await window.api.buildReport())
                        }
                      >
                        Copy report
                      </button>
                    </>
                  )}
                  <button
                    className="ghost"
                    style={{ fontSize: 12, padding: '1px 6px', float: 'right' }}
                    onClick={() => setBanner(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            <Editor
              key={`${current.slug}:${reloads}`}
              post={current}
              onChange={(doc) => patchPost({ doc })}
              onEditorReady={setEditor}
              onFilesDropped={(files) => onAddFiles(files, true)}
            />

            <div className="statusbar">
              <span>
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? sync?.shared && sync.offline
                      ? 'Saved on this computer'
                      : 'Saved'
                    : sync?.shared && sync.offline && sync.pending > 0
                      ? 'Offline — changes will be shared when you reconnect'
                      : ''}
              </span>
              <span className="grow" />
              {pendingCount > 0 && (
                <span>
                  <span className="spinner" style={{ verticalAlign: -2, marginRight: 5 }} />
                  Preparing {pendingCount}
                </span>
              )}
              <button className="ghost danger" onClick={() => setConfirmDelete(true)} disabled={!!publishing}>
                Delete
              </button>
              {!current.frontMatter.draft && (
                <button onClick={doUnpublish} disabled={!!publishing}>
                  Back to draft
                </button>
              )}
              <button onClick={togglePreview}>Preview</button>
              <button className="primary" onClick={doPublish} disabled={!!publishing}>
                {publishing ?? (current.frontMatter.draft ? 'Publish' : 'Update')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ------------- media ------------- */}
      <Library
        postSlug={current?.slug ?? ''}
        editor={editor}
        onAddFiles={onAddFiles}
        pendingCount={pendingCount}
      />

      {pendingFiles && (
        <GroupDialog
          count={pendingFiles.files.length}
          suggestions={groupSuggestions}
          onConfirm={ingest}
          onCancel={() => setPendingFiles(null)}
        />
      )}
      {confirmDelete && current && (
        <DeleteDialog
          title={current.frontMatter.title}
          published={!current.frontMatter.draft}
          mediaCount={assets.filter((a) => a.postSlug === current.slug).length}
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {showSettings && <Settings config={config} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

/**
 * The one thing about sharing the owner needs to see, if anything: another
 * computer has the blog open, or this blog still needs a permission to be
 * usable elsewhere.
 */
function SyncBanner({ sync, onRetry }: { sync: any; onRetry: () => void }) {
  if (!sync) return null
  let body: React.ReactNode = null
  let kind = 'warn'
  if (sync.migration?.state === 'needs-permission') {
    body = (
      <>
        To use your blog on another computer, add the <strong>D1 — Edit</strong> permission to your
        Cloudflare token (Cloudflare → My Profile → API Tokens → Edit), then{' '}
        <button className="ghost" style={{ fontSize: 12, padding: '1px 6px' }} onClick={onRetry}>
          check again
        </button>
        . Until then everything works on this computer as before.
      </>
    )
  } else if (sync.migration?.state === 'running') {
    kind = 'ok'
    body = (
      <>
        <span className="spinner" style={{ verticalAlign: -2, marginRight: 6 }} />
        {sync.migration.message ?? 'Getting your blog ready for other computers…'}
      </>
    )
  } else if (sync.migration?.state === 'failed') {
    body = (
      <>
        {sync.migration.message}{' '}
        <button className="ghost" style={{ fontSize: 12, padding: '1px 6px' }} onClick={onRetry}>
          Try again
        </button>
      </>
    )
  } else if (sync.others?.length) {
    body = (
      <>
        Your blog is also open on <strong>{sync.others.join(' and ')}</strong>. Editing the same post on
        both at once keeps both versions.
      </>
    )
  }
  if (!body) return null
  return (
    <div style={{ padding: '10px 40px 0' }}>
      <div className={`banner ${kind}`} style={{ marginBottom: 0 }}>
        {body}
      </div>
    </div>
  )
}

function publishLabel(p: { phase: string; detail?: string }): string {
  switch (p.phase) {
    case 'waiting-for-photos':
      return `Finishing ${p.detail ?? 'photos'}…`
    case 'building':
      return 'Building…'
    case 'uploading':
      return 'Backing up…'
    case 'deploying':
      return 'Publishing…'
    case 'verifying':
      return 'Checking…'
    default:
      return 'Publishing…'
  }
}

/** Cover photo: pick from this post's library, no file dialog needed. */
function CoverPicker({
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
  const options = assets.filter((a) => a.postSlug === postSlug && a.kind === 'image')
  return (
    <select
      value={cover ?? ''}
      onChange={(e) => onPick(e.target.value || undefined)}
      style={{ padding: '7px 9px' }}
    >
      <option value="">None</option>
      {options.map((a) => (
        <option key={a.key} value={a.key}>
          {a.key.split('/').slice(1).join('/')}
        </option>
      ))}
    </select>
  )
}
