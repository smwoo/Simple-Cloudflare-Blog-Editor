import React, { useEffect, useState } from 'react'

interface Health {
  id: string
  label: string
  ok: boolean
  detail?: string
}

/**
 * Connection health: the same checks setup ran, re-runnable forever.
 *
 * This is what the owner opens when something is wrong, and it ends in Copy
 * report — the support channel, since the helper will not be in the room.
 */
interface BlogDomain {
  hostname: string
  withWww: boolean
  primary: boolean
}

export function Settings({ onClose, config: initialConfig }: { onClose: () => void; config: any }) {
  const [config, setConfig] = useState<any>(initialConfig)
  const [domains, setDomains] = useState<BlogDomain[] | null>(null)
  const [domainBusy, setDomainBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [health, setHealth] = useState<Health[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [domain, setDomain] = useState('')
  const [domainMsg, setDomainMsg] = useState<string | null>(null)
  const [password, setPassword] = useState<string>(initialConfig?.sitePassword ?? '')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null)

  const loadDomains = async () => {
    setDomains(await window.api.listDomains())
    setConfig((await window.api.status()).config)
  }
  useEffect(() => {
    loadDomains()
  }, [])

  const run = async () => {
    setBusy(true)
    setHealth(await window.api.health())
    setStats(await window.api.mediaStats())
    setBusy(false)
  }
  useEffect(() => {
    run()
  }, [])

  const copyReport = async () => {
    await navigator.clipboard.writeText(await window.api.buildReport())
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const attach = async () => {
    setDomainBusy('add')
    setDomainMsg('Setting up… this can take a minute.')
    const res = await window.api.attachDomain(domain.trim())
    setDomainMsg(res.ok ? `${res.url} is live.` : (res.message ?? 'Could not set that up.'))
    if (res.ok) setDomain('')
    await loadDomains()
    setDomainBusy(null)
  }

  const remove = async (hostname: string) => {
    setConfirmRemove(null)
    setDomainBusy(hostname)
    setDomainMsg(null)
    const res = await window.api.removeDomain(hostname)
    setDomainMsg(
      res.ok
        ? `${hostname} removed. Your blog is now at ${res.customDomain ?? 'its workers.dev address'}.`
        : (res.message ?? `Could not remove ${hostname}.`),
    )
    await loadDomains()
    setDomainBusy(null)
  }

  const savePassword = async (next: string) => {
    setPasswordBusy(true)
    setPasswordMsg('Updating your blog… this can take a minute.')
    const res = await window.api.setSitePassword(next)
    setConfig((await window.api.status()).config)
    setPassword(next.trim())
    setPasswordMsg(
      res.ok
        ? next.trim()
          ? 'Done. Visitors now need the password.'
          : 'Done. Anyone with the address can read your blog.'
        : (res.message ?? 'Could not update your blog.'),
    )
    setPasswordBusy(false)
  }

  const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 540 }}>
        <h3>Settings</h3>

        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Connection</strong>
            <button className="ghost" onClick={run} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Check again'}
            </button>
          </div>
          {(health ?? []).map((h) => (
            <div className={`perm ${h.ok ? 'ok' : 'err'}`} key={h.id}>
              <span>{h.ok ? '✓' : '✕'}</span>
              <span style={{ flex: 1 }}>{h.label}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{h.detail}</span>
            </div>
          ))}
          {health?.some((h) => !h.ok) && (
            <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
              Something is not working. Send the report below to whoever set up your blog.
            </div>
          )}
        </div>

        <div className="card">
          <strong style={{ fontSize: 13 }}>Your blog</strong>
          <p className="hint">
            {config?.customDomain ? (
              <a href="#" onClick={() => window.api.openExternal(`https://${config.customDomain}`)}>
                {config.customDomain}
              </a>
            ) : (
              <a href="#" onClick={() => window.api.openExternal(config?.siteUrl)}>
                {config?.siteUrl}
              </a>
            )}
          </p>
          {stats && (
            <p className="hint">
              {stats.count} photos · {mb(stats.bytesOutput)} published · {mb(stats.bytesOriginal)} originals
              kept on this computer
            </p>
          )}
          <button className="ghost" onClick={() => window.api.reveal('originals')}>
            Show originals folder
          </button>
        </div>

        <div className="card">
          <strong style={{ fontSize: 13 }}>Password</strong>
          <p className="hint">
            Visitors type this once on each device to read your blog. It keeps casual visitors
            out, not determined ones. Search engines are always asked not to list your blog.
          </p>
          <div className="row-split">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && password.trim() && !passwordBusy && savePassword(password)
              }
              placeholder="No password: anyone with the address can read it"
              spellCheck={false}
            />
            <button
              className="primary"
              style={{ flex: '0 0 120px' }}
              onClick={() => savePassword(password)}
              disabled={
                !password.trim() || password.trim() === (config?.sitePassword ?? '') || passwordBusy
              }
            >
              {passwordBusy ? <span className="spinner" /> : 'Set password'}
            </button>
          </div>
          {config?.sitePassword && (
            <button
              className="ghost"
              style={{ marginTop: 8 }}
              onClick={() => savePassword('')}
              disabled={passwordBusy}
            >
              Remove password
            </button>
          )}
          {passwordMsg && <p className="hint">{passwordMsg}</p>}
        </div>

        <div className="card">
          <strong style={{ fontSize: 13 }}>Web addresses</strong>
          <div className="perm" style={{ marginTop: 8 }}>
            <span style={{ flex: 1 }}>
              <a href="#" onClick={() => window.api.openExternal(config?.siteUrl)}>
                {config?.siteUrl?.replace(/^https:\/\//, '')}
              </a>
            </span>
            <span className="hint" style={{ margin: 0 }}>always works</span>
          </div>
          {domains === null && <p className="hint"><span className="spinner" /></p>}
          {domains?.map((d) => (
            <div className="perm" key={d.hostname}>
              <span style={{ flex: 1 }}>
                <a href="#" onClick={() => window.api.openExternal(`https://${d.hostname}`)}>
                  {d.hostname}
                </a>
                {d.withWww && <span className="hint"> (and www)</span>}{' '}
                {d.primary && <span className="badge">main</span>}
              </span>
              {domainBusy === d.hostname ? (
                <span className="spinner" />
              ) : confirmRemove === d.hostname ? (
                <>
                  <button className="danger" onClick={() => remove(d.hostname)} disabled={!!domainBusy}>
                    Remove it
                  </button>
                  <button className="ghost" onClick={() => setConfirmRemove(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="ghost" onClick={() => setConfirmRemove(d.hostname)} disabled={!!domainBusy}>
                  Remove
                </button>
              )}
            </div>
          ))}

          <p className="hint" style={{ margin: '14px 0 8px' }}>
            Add a domain in your Cloudflare account (alice.com), or a subdomain of one
            (blog.alice.com). Need a domain?{' '}
            <a href="#" onClick={async () => window.api.openExternal((await window.api.registrarUrl()) ?? '')}>
              Buy one at Cloudflare ↗
            </a>
          </p>
          <div className="row-split">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && domain.trim() && !domainBusy && attach()}
              placeholder="alice.com or blog.alice.com"
              spellCheck={false}
            />
            <button
              className="primary"
              style={{ flex: '0 0 120px' }}
              onClick={attach}
              disabled={!domain.trim() || !!domainBusy}
            >
              {domainBusy === 'add' ? <span className="spinner" /> : 'Add address'}
            </button>
          </div>
          {domainMsg && <p className="hint">{domainMsg}</p>}
        </div>

        <div className="actions">
          <button onClick={copyReport}>{copied ? 'Copied' : 'Copy report'}</button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
