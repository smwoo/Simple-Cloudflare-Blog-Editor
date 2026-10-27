/**
 * Connect mode: this computer joins a blog that already exists.
 *
 * Only a Cloudflare token is asked for. The blog is found in the account the
 * token can see, and its storage keys come with it. Nothing is published:
 * the blog is copied here, checked, and handed over for writing.
 */
import React, { useEffect, useState } from 'react'
import type { TokenCheck } from '../../../shared/types.js'
import { PERMISSIONS, TOKEN_URL, R2_TOKEN_HELP } from './permissions.js'

interface FoundBlog {
  accountId: string
  accountName: string
  databaseId: string
  name: string
  title: string
  siteUrl: string
  customDomain?: string
  posts: number
  lastEditedAt?: number
  lastEditedOn?: string
  needsUpdate: boolean
}

interface UnmovedBlog {
  accountId: string
  accountName: string
  name: string
  bucket: string
}

interface Found {
  blogs: FoundBlog[]
  unmoved: UnmovedBlog[]
  checks: Record<string, TokenCheck>
}

const RELEASES = 'https://github.com/smwoo/Simple-Cloudflare-Blog-Editor/releases/latest'

function when(ms?: number) {
  if (!ms) return null
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

export function Connect({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [token, setToken] = useState('')
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<Found | null>(null)
  const [findError, setFindError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<{ text: string; log?: string } | null>(null)
  const [askKeys, setAskKeys] = useState<'rejected' | 'recover' | null>(null)
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [recovering, setRecovering] = useState<UnmovedBlog | null>(null)
  const [done, setDone] = useState<{ posts: number; assets: number } | null>(null)

  useEffect(() => window.api.onConnectProgress((d) => setProgress(d)), [])

  const find = async () => {
    setFinding(true)
    setFound(null)
    setFindError(null)
    setError(null)
    setAskKeys(null)
    const res = await window.api.findBlogs(token.trim())
    setFinding(false)
    if (!res.ok) {
      setFindError('That token was not accepted. Check it was copied whole, and that it has not expired.')
      return
    }
    setFound(res)
    if (res.blogs.length === 1) setChosen(res.blogs[0].databaseId)
  }

  const blog = found?.blogs.find((b) => b.databaseId === chosen)
  const check = blog ? found?.checks[blog.accountId] : undefined
  const keys = () =>
    accessKeyId.trim() && secretAccessKey.trim()
      ? { r2AccessKeyId: accessKeyId.trim(), r2SecretAccessKey: secretAccessKey.trim() }
      : undefined

  const run = async (target: { accountId: string; databaseId: string }) => {
    setRunning(true)
    setError(null)
    setProgress('Starting…')
    const res = await window.api.connectBlog({
      token: token.trim(),
      ...target,
      keys: askKeys ? keys() : undefined,
    })
    setRunning(false)
    setProgress(null)
    if (res.ok) {
      setDone({ posts: res.posts, assets: res.assets })
    } else if (res.keysRejected) {
      setAskKeys('rejected')
      setError({ text: "Your blog's storage keys no longer work. Enter new ones below — they will be saved for every computer." })
    } else if (res.needsUpdate) {
      setError({ text: 'This blog was set up by a newer version of Blog Editor. Update this app first.' })
    } else {
      setError({ text: res.error ?? 'Could not connect to the blog.', log: res.log })
    }
  }

  const recover = async () => {
    if (!recovering) return
    setRunning(true)
    setError(null)
    setProgress('Starting…')
    const res = await window.api.recoverBlog({ token: token.trim(), blog: recovering, keys: keys() })
    if (!res.ok) {
      setRunning(false)
      setProgress(null)
      setError({
        text: res.keysRejected
          ? 'Those storage keys were not accepted for this blog.'
          : (res.error ?? 'Could not recover the blog.'),
      })
      return
    }
    setRecovering(null)
    setAskKeys(null)
    await run({ accountId: recovering.accountId, databaseId: res.databaseId })
  }

  if (done) {
    return (
      <div className="setup-scroll"><div className="setup">
        <h1>Your blog is on this computer</h1>
        <p className="lede">
          {done.posts} post{done.posts === 1 ? '' : 's'} and {done.assets} photo{done.assets === 1 ? '' : 's'} and
          videos. Photos added on your other computer show straight from your blog, so nothing big was
          downloaded. Changes you make here appear on your other computers, and theirs here.
        </p>
        <button className="primary" onClick={onDone}>
          Start writing
        </button>
      </div></div>
    )
  }

  return (
    <div className="setup-scroll"><div className="setup">
      <h1>Connect to your blog</h1>
      <p className="lede">
        Use this on a second computer, or a new one, to carry on with a blog you already have. Nothing on
        your blog changes.
      </p>

      {/* ---------------- 1. permission ---------------- */}
      <div className="card">
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>1 · Cloudflare permission</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          Paste the API token from your other computer, or create a new one with these permissions. A new
          token for each computer is best: if one is lost, you can switch off just that one.
        </p>
        <table style={{ width: '100%', fontSize: 12.5, marginBottom: 14, borderCollapse: 'collapse' }}>
          <tbody>
            {PERMISSIONS.map(([scope, group, level]) => (
              <tr key={group} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '4px 0', color: 'var(--muted)' }}>{scope}</td>
                <td style={{ padding: '4px 0' }}>{group}</td>
                <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 600 }}>{level}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="ghost" onClick={() => window.api.openExternal(TOKEN_URL)} style={{ marginBottom: 14 }}>
          Open Cloudflare API tokens ↗
        </button>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>API token</label>
          <div className="row-split">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && token.trim() && find()}
              placeholder="Paste the token"
              spellCheck={false}
            />
            <button onClick={find} disabled={!token.trim() || finding || running} style={{ flex: '0 0 92px' }}>
              {finding ? <span className="spinner" /> : 'Check'}
            </button>
          </div>
        </div>
        {findError && <div className="banner err" style={{ marginTop: 10 }}>{findError}</div>}
      </div>

      {/* ---------------- 2. choose ---------------- */}
      {found && (
        <div className="card">
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>2 · Your blog</h3>

          {found.blogs.length === 0 && found.unmoved.length === 0 && (
            <div className="banner warn" style={{ marginBottom: 0 }}>
              No blog found in the Cloudflare account this token belongs to. Is it the account you used when
              the blog was set up? If you have more than one account, make the token in that one.
            </div>
          )}

          {found.blogs.map((b) => (
            <label
              key={b.databaseId}
              className="perm"
              style={{ alignItems: 'flex-start', cursor: 'pointer', padding: '8px 0' }}
            >
              <input
                type="radio"
                name="blog"
                checked={chosen === b.databaseId}
                onChange={() => setChosen(b.databaseId)}
                style={{ marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>
                <strong>{b.title}</strong>
                <br />
                <span className="hint" style={{ margin: 0 }}>
                  {b.customDomain ?? b.siteUrl.replace(/^https:\/\//, '')} · {b.posts} post{b.posts === 1 ? '' : 's'}
                  {b.lastEditedAt && <> · last edited {when(b.lastEditedAt)}{b.lastEditedOn && <> on {b.lastEditedOn}</>}</>}
                  {found.blogs.some((o) => o.accountId !== b.accountId) && <> · {b.accountName}</>}
                </span>
              </span>
            </label>
          ))}

          {found.unmoved.map((u) => (
            <div key={`${u.accountId}/${u.name}`} className="banner warn" style={{ marginTop: 10 }}>
              <strong>{u.name}</strong> has not been made ready for other computers yet.
              <br />
              If your other computer still works, open Blog Editor on it and update it to the latest version —
              it gets the blog ready by itself. Then press <strong>Check</strong> here again.
              <div style={{ marginTop: 8 }}>
                <button
                  className="ghost"
                  onClick={() => {
                    setRecovering(u)
                    setAskKeys('recover')
                    setError(null)
                  }}
                >
                  My other computer is gone — recover from the backup
                </button>
              </div>
            </div>
          ))}

          {blog?.needsUpdate && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              This blog was set up by a newer version of Blog Editor.{' '}
              <a href="#" onClick={() => window.api.openExternal(RELEASES)}>Get the latest version ↗</a>
            </div>
          )}
          {check && check.missing.length > 0 && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              The token is missing: {check.missing.join(', ')}. Add these permissions and press Check again.
            </div>
          )}
        </div>
      )}

      {/* ---------------- storage keys, only when needed ---------------- */}
      {askKeys && (
        <div className="card">
          <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Photo storage keys</h3>
          <p className="hint" style={{ marginBottom: 14 }}>
            {askKeys === 'recover'
              ? `To rebuild ${recovering?.name} from its backup, the app needs the storage keys. `
              : ''}
            In R2, create an API token with <strong>Object Read &amp; Write</strong> and paste its Access Key ID
            and Secret.
          </p>
          <button className="ghost" onClick={() => window.api.openExternal(R2_TOKEN_HELP)} style={{ marginBottom: 14 }}>
            Open R2 API tokens ↗
          </button>
          <div className="field">
            <label>Access Key ID</label>
            <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} spellCheck={false} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Secret Access Key</label>
            <input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              spellCheck={false}
            />
          </div>
          {askKeys === 'recover' && (
            <p className="hint" style={{ marginBottom: 0 }}>
              The backup does not include the blog's password, if it had one. Set it again in Settings
              afterwards.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="banner err">
          {error.text}
          {error.log && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 6 }}>{error.log}</pre>}
        </div>
      )}
      {progress && (
        <p className="hint">
          <span className="spinner" style={{ verticalAlign: -2, marginRight: 6 }} />
          {progress}
        </p>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="ghost" onClick={onBack} disabled={running}>
          Back
        </button>
        {askKeys === 'recover' ? (
          <button className="primary" onClick={recover} disabled={running || !keys()}>
            {running ? 'Recovering…' : 'Recover the blog'}
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => blog && run(blog)}
            disabled={!blog || blog.needsUpdate || !!check?.missing.length || running || (askKeys === 'rejected' && !keys())}
          >
            {running ? 'Connecting…' : 'Yes, this is my blog'}
          </button>
        )}
      </div>
    </div></div>
  )
}
