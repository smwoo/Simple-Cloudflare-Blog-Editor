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
export function Settings({ onClose, config }: { onClose: () => void; config: any }) {
  const [health, setHealth] = useState<Health[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [domain, setDomain] = useState('')
  const [domainMsg, setDomainMsg] = useState<string | null>(null)

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
    setDomainMsg('Setting up…')
    const res = await window.api.attachDomain(domain.trim())
    setDomainMsg(res.ok ? `${res.url} is live.` : (res.message ?? 'Could not set that up.'))
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

        {!config?.customDomain && (
          <div className="card">
            <strong style={{ fontSize: 13 }}>Use your own web address</strong>
            <p className="hint" style={{ marginBottom: 10 }}>
              Buy the address at Cloudflare first — bought anywhere else it will not work here.
            </p>
            <div className="row-split">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="alice.com" />
              <button
                style={{ flex: '0 0 96px' }}
                onClick={async () => window.api.openExternal((await window.api.registrarUrl(domain.trim())) ?? '')}
              >
                Buy it ↗
              </button>
            </div>
            <button className="primary" style={{ marginTop: 10 }} onClick={attach} disabled={!domain.trim()}>
              I bought it — set it up
            </button>
            {domainMsg && <p className="hint">{domainMsg}</p>}
          </div>
        )}

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
