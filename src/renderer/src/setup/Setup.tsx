/**
 * Setup mode — for the helper, not the owner.
 *
 * Deliberately verbose: real field names, the actual permissions, the specific
 * failure. Setup assumes someone comfortable with a Cloudflare dashboard sits
 * with the owner once, so this screen does not need to teach Cloudflare's
 * permission model through screenshots. Everything *after* setup is written for
 * the owner alone.
 */
import React, { useEffect, useState } from 'react'
import type { TokenCheck } from '../../../shared/types.js'
import { Connect } from './Connect.js'
import { PERMISSIONS, TOKEN_URL, R2_TOKEN_HELP } from './permissions.js'

interface Step {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed'
  detail?: string
  remedy?: string
}


/** First run: a new blog, or this computer joining one that exists. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'choose' | 'new' | 'connect'>('choose')

  if (mode === 'new') return <NewBlog onDone={onDone} onConnect={() => setMode('connect')} />
  if (mode === 'connect') return <Connect onDone={onDone} onBack={() => setMode('choose')} />

  return (
    <div className="setup-scroll"><div className="setup">
      <h1>Blog Editor</h1>
      <p className="lede">Is this a new blog, or one you already write on another computer?</p>
      <div className="card">
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>I already have a blog</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          Carry on with it on this computer. Your posts and photos come with it, and nothing on your blog
          changes. Takes a couple of minutes.
        </p>
        <button className="primary" onClick={() => setMode('connect')}>
          Connect to my blog
        </button>
      </div>
      <div className="card">
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Set up a new blog</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          Creates a brand new blog in a Cloudflare account. About ten minutes, best done with whoever is
          helping.
        </p>
        <button onClick={() => setMode('new')}>Set up a new blog</button>
      </div>
    </div></div>
  )
}

function NewBlog({ onDone, onConnect }: { onDone: () => void; onConnect: () => void }) {
  const [token, setToken] = useState('')
  const [check, setCheck] = useState<TokenCheck | null>(null)
  const [checking, setChecking] = useState(false)

  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')

  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')

  const [steps, setSteps] = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => window.api.onSetupProgress((s) => setSteps(s)), [])

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const doCheck = async () => {
    setChecking(true)
    setCheck(null)
    try {
      setCheck(await window.api.checkToken(token.trim()))
    } finally {
      setChecking(false)
    }
  }

  const canProvision =
    check?.ok && slug.length >= 3 && accessKeyId.trim() && secretAccessKey.trim() && title.trim()

  const provision = async () => {
    setRunning(true)
    setError(null)
    const res = await window.api.provision({
      cloudflareToken: token.trim(),
      r2AccessKeyId: accessKeyId.trim(),
      r2SecretAccessKey: secretAccessKey.trim(),
      name: slug,
      title: title.trim(),
      author: author.trim() || title.trim(),
    })
    setRunning(false)
    setExisting(!!res.existingBlog)
    if (res.ok) setDone(true)
    else if (res.existingBlog) setError(null)
    else setError(res.error ?? 'Setup did not finish.')
  }

  if (done) {
    return (
      <div className="setup-scroll"><div className="setup">
        <h1>The blog is live</h1>
        <p className="lede">
          Everything is set up and checked end to end. Hand the computer back.
        </p>
        <button className="primary" onClick={onDone}>
          Start writing
        </button>
      </div></div>
    )
  }

  return (
    <div className="setup-scroll"><div className="setup">
      <h1>Set up a blog</h1>
      <p className="lede">
        This screen is for whoever is helping. It needs a Cloudflare account — the free
        plan is enough — and takes about ten minutes.
      </p>

      {/* ---------------- 1. permission ---------------- */}
      <div className="card">
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>1 · Cloudflare permission</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          Create an API token with these permissions. The Zone ones are not used yet —
          they are included so adding a custom domain later needs no second visit.
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
        <p className="hint" style={{ marginBottom: 14 }}>
          Set the expiry to <strong>no expiry</strong>. An expiring token kills publishing
          months later with no warning, and the owner cannot fix it themselves.
        </p>

        <div className="field">
          <label>API token</label>
          <div className="row-split">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the token"
              spellCheck={false}
            />
            <button onClick={doCheck} disabled={!token.trim() || checking} style={{ flex: '0 0 92px' }}>
              {checking ? <span className="spinner" /> : 'Check'}
            </button>
          </div>
        </div>

        {check?.looksLikeGlobalKey && <div className="banner err">{check.error}</div>}

        {check && !check.looksLikeGlobalKey && (
          <>
            {check.error && <div className="banner err">{check.error}</div>}
            {check.accountName && (
              <p className="hint" style={{ marginBottom: 8 }}>
                Account: <strong>{check.accountName}</strong>
              </p>
            )}
            {check.granted.map((g) => (
              <div className="perm ok" key={g}>
                <span>✓</span>
                <span>{g}</span>
              </div>
            ))}
            {check.missing.map((m) => (
              <div className="perm err" key={m}>
                <span>✕</span>
                <span>{m}</span>
              </div>
            ))}
            {check.optionalMissing?.map((m) => (
              <div className="perm" key={m} style={{ color: 'var(--muted)' }}>
                <span>–</span>
                <span>{m} — not granted, fine for now</span>
              </div>
            ))}
            {check.missing.length > 0 && (
              <div className="banner warn" style={{ marginTop: 10 }}>
                Add the permissions marked ✕ to the token, then check again.
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------------- 2. storage keys ---------------- */}
      <div className="card">
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>2 · Photo storage keys</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          In R2, create an API token with <strong>Object Read &amp; Write</strong>. Copy the
          Access Key ID and Secret — these are different from the API token above, and
          Cloudflare shows the secret only once.
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
      </div>

      {/* ---------------- 3. the blog ---------------- */}
      <div className="card">
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>3 · The blog</h3>
        <div className="field">
          <label>Short name (used in the web address)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="alice-blog" spellCheck={false} />
          {slug && (
            <p className="hint">
              Will be at <code>{slug}.&lt;your-subdomain&gt;.workers.dev</code>
            </p>
          )}
        </div>
        <div className="field">
          <label>Blog title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Alice's Trip Log" />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Author</label>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Alice" />
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}
      {existing && (
        <div className="banner warn">
          A blog called <strong>{slug}</strong> already exists in this Cloudflare account, so nothing was
          changed. <button className="primary" style={{ marginLeft: 8 }} onClick={onConnect}>Connect to it instead</button>
        </div>
      )}

      <button className="primary" onClick={provision} disabled={!canProvision || running}>
        {running ? 'Setting up…' : 'Set up the blog'}
      </button>
      {!canProvision && !running && (
        <p className="hint">Check the token and fill in the storage keys and blog name first.</p>
      )}

      {steps.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <ul className="steps">
            {steps.map((s) => (
              <li key={s.id}>
                <span className={`ico ${s.status === 'running' ? 'run' : ''} ${s.status === 'done' ? 'ok' : ''} ${s.status === 'failed' ? 'err' : ''}`}>
                  {s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? '◐' : '·'}
                </span>
                <span style={{ flex: 1 }}>
                  {s.label}
                  {s.detail && <small>{s.detail}</small>}
                  {s.remedy && <span className="remedy">{s.remedy}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div></div>
  )
}
