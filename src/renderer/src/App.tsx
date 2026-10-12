import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/react'
import { Editor } from './editor/Editor.js'
import { Library } from './library/Library.js'
import { Setup } from './setup/Setup.js'
import { GroupDialog } from './panes/GroupDialog.js'
import { Settings } from './panes/Settings.js'
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
  const [pendingFiles, setPendingFiles] = useState<string[] | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [publishing, setPublishing] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string; log?: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null)
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
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1600)
    }, 1200)
  }, [])

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

  /** Files arrived — ask the one question, then ingest. */
  const onAddFiles = (files: string[]) => setPendingFiles(files)

  const ingest = async (group: string) => {
    const files = pendingFiles ?? []
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

    if (keys.length && editor) appendToGalleryOrInsert(editor, keys)
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
    const next = { ...post, slug }
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
          <button className="ghost" onClick={() => setShowSettings(true)} title="Settings">
            ⚙
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
              key={current.slug}
              post={current}
              onChange={(doc) => patchPost({ doc })}
              onEditorReady={setEditor}
              onFilesDropped={(files) => onAddFiles(files)}
            />

            <div className="statusbar">
              <span>
                {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}
              </span>
              <span className="grow" />
              {pendingCount > 0 && (
                <span>
                  <span className="spinner" style={{ verticalAlign: -2, marginRight: 5 }} />
                  Preparing {pendingCount}
                </span>
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
          count={pendingFiles.length}
          suggestions={groupSuggestions}
          onConfirm={ingest}
          onCancel={() => setPendingFiles(null)}
        />
      )}
      {showSettings && <Settings config={config} onClose={() => setShowSettings(false)} />}
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
