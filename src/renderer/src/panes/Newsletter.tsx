import React, { useEffect, useState } from 'react'

type Provider = 'cloudflare' | 'resend'

interface Mailing {
  id: number
  post: string | null
  subject: string
  at: number
  finishedAt: number | null
  sent: number
  total: number
}

interface Subscriber {
  id: number
  email: string
  at: number
}

const when = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const PROVIDERS: { id: Provider; label: string; help: string; url: string }[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    help:
      'Uses the Cloudflare account your blog is on. Needs the Workers Paid plan ($5 a month, 3,000 ' +
      'emails included), the "Email Sending — Edit" permission on your token, and your domain added ' +
      'under Email Service → Email Sending.',
    url: 'https://dash.cloudflare.com/?to=/:account/email-service/sending',
  },
  {
    id: 'resend',
    label: 'Resend',
    help:
      'A separate email service, free for up to 100 emails a day and 3,000 a month. Make an account, ' +
      'add your domain under Domains, then create an API key with sending access and paste it below.',
    url: 'https://resend.com/domains',
  },
]

/**
 * The newsletter: how it is sent, the box under posts, who is subscribed, and
 * writing to them. Sending a new-post email lives in the editor, beside Publish.
 */
export function Newsletter({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<any>(null)
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // sending setup
  const [provider, setProvider] = useState<Provider>('cloudflare')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [resendKey, setResendKey] = useState('')
  const [senderBusy, setSenderBusy] = useState(false)
  const [senderMsg, setSenderMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testTo, setTestTo] = useState('')

  const [openBusy, setOpenBusy] = useState(false)
  const [openMsg, setOpenMsg] = useState<string | null>(null)

  const [addEmail, setAddEmail] = useState('')
  const [listMsg, setListMsg] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)

  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null)
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async () => {
    const s = await window.api.newsletterStatus()
    setStatus(s)
    if (!s.ok) return setError(s.message)
    setError(null)
    if (s.sender) {
      setProvider(s.sender.provider)
      setFromEmail(s.sender.fromEmail)
      setFromName(s.sender.fromName)
    } else if (s.customDomain) {
      setFromEmail(`newsletter@${s.customDomain.replace(/^www\./, '')}`)
    }
    const list = await window.api.listSubscribers()
    if (list.ok) setSubscribers(list.subscribers)
  }

  useEffect(() => {
    load()
    return window.api.onNewsletterProgress((p) => setProgress({ sent: p.sent, total: p.total }))
  }, [])

  const refresh = async () => {
    const s = await window.api.newsletterStatus()
    if (s.ok) setStatus(s)
    const list = await window.api.listSubscribers()
    if (list.ok) setSubscribers(list.subscribers)
  }

  const saveSender = async () => {
    setSenderBusy(true)
    setSenderMsg(null)
    const res = await window.api.saveNewsletterSender({
      provider,
      fromEmail,
      fromName,
      ...(resendKey.trim() ? { resendKey: resendKey.trim() } : {}),
    })
    setSenderBusy(false)
    setSenderMsg(res.ok ? { ok: true, text: 'Saved. Send yourself a test to check it works.' } : { ok: false, text: res.message })
    if (res.ok) {
      setResendKey('')
      await refresh()
    }
  }

  const sendTest = async () => {
    setSenderBusy(true)
    setSenderMsg(null)
    const res = await window.api.sendTestEmail(testTo)
    setSenderBusy(false)
    setSenderMsg(
      res.ok
        ? { ok: true, text: `Sent to ${testTo.trim()}. It can take a minute; check spam if it does not arrive.` }
        : { ok: false, text: res.message },
    )
  }

  const toggleOpen = async (open: boolean) => {
    setOpenBusy(true)
    setOpenMsg(open ? 'Turning it on… this can take a minute.' : null)
    const res = await window.api.setSubscribeOpen(open)
    setOpenBusy(false)
    setOpenMsg(res.ok ? (open ? 'Done. Every post now ends with the box.' : null) : (res.message ?? 'That did not work.'))
    await refresh()
  }

  const add = async () => {
    setListMsg(null)
    const res = await window.api.addSubscriber(addEmail)
    if (!res.ok) return setListMsg(res.message)
    setAddEmail('')
    await refresh()
  }

  const remove = async (id: number) => {
    if (confirmRemove !== id) return setConfirmRemove(id)
    setConfirmRemove(null)
    const res = await window.api.removeSubscriber(id)
    if (!res.ok) setListMsg(res.message)
    await refresh()
  }

  const finish = async (res: any, what: string) => {
    setProgress(null)
    if (res.ok) {
      setSendMsg({ ok: true, text: `${what} sent to ${plural(res.mailing.total, 'subscriber')}.` })
    } else if (res.mailing) {
      setSendMsg({
        ok: false,
        text:
          `Sent to ${res.mailing.sent} of ${res.mailing.total}. ${res.message}` +
          (res.resumable ? ' Press "Send the rest" below later to carry on.' : ''),
      })
    } else {
      setSendMsg({ ok: false, text: res.message })
    }
    await refresh()
  }

  const sendNow = async () => {
    setConfirmSend(false)
    setSendMsg(null)
    setProgress({ sent: 0, total: status?.subscribers ?? 0 })
    const res = await window.api.sendNewsletter({ subject, body })
    if (res.ok) {
      setSubject('')
      setBody('')
    }
    await finish(res, 'Your email was')
  }

  const resume = async (m: Mailing) => {
    setSendMsg(null)
    setProgress({ sent: m.sent, total: m.total })
    await finish(await window.api.resumeMailing(m.id), `"${m.subject}" was`)
  }

  const sender = status?.sender
  const ready = !!sender
  const count = status?.subscribers ?? 0
  const sending = !!progress || status?.sending != null
  const info = PROVIDERS.find((p) => p.id === provider)!

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && !sending && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && !sending && onClose()}
    >
      <div className="modal newsletter-modal">
        <h3>Newsletter</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          Visitors leave their email address under a post, and get an email when you publish a new
          one. Every email has an unsubscribe link.
        </p>
        {error && <div className="banner err">{error}</div>}
        {!status && (
          <p className="hint">
            <span className="spinner" style={{ verticalAlign: -2, marginRight: 6 }} />
            Loading
          </p>
        )}

        {status?.ok && (
          <>
            {/* ------------- sending ------------- */}
            <div className="card">
              <strong style={{ fontSize: 13 }}>How emails are sent</strong>
              {!status.customDomain && (
                <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
                  Emails have to come from an address on your own domain, so add one under{' '}
                  <strong>Web addresses</strong> in Settings first.
                </div>
              )}
              <div className="row-split" style={{ marginTop: 10 }}>
                {PROVIDERS.map((p) => (
                  <label className="check" key={p.id}>
                    <input
                      type="radio"
                      name="provider"
                      checked={provider === p.id}
                      onChange={() => setProvider(p.id)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
              <p className="hint">
                {info.help}{' '}
                <a href="#" onClick={() => window.api.openExternal(info.url)}>
                  Open {info.label} ↗
                </a>
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <label>Send from</label>
                <input
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  placeholder="newsletter@alice.com"
                  spellCheck={false}
                />
              </div>
              {provider === 'resend' && (
                <>
                  <div className="field">
                    <label>Sender name</label>
                    <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Alice's blog" />
                  </div>
                  <div className="field">
                    <label>Resend API key</label>
                    <input
                      type="password"
                      value={resendKey}
                      onChange={(e) => setResendKey(e.target.value)}
                      placeholder={sender?.hasResendKey ? 'Saved — paste a new one to replace it' : 're_…'}
                      spellCheck={false}
                    />
                  </div>
                </>
              )}
              <button className="primary" onClick={saveSender} disabled={senderBusy || !fromEmail.trim()}>
                {senderBusy ? <span className="spinner" /> : 'Save'}
              </button>
              {ready && (
                <div className="row-split" style={{ marginTop: 12 }}>
                  <input
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && testTo.trim() && !senderBusy && sendTest()}
                    placeholder="Your own email address"
                    spellCheck={false}
                  />
                  <button style={{ flex: '0 0 130px' }} onClick={sendTest} disabled={senderBusy || !testTo.trim()}>
                    Send a test
                  </button>
                </div>
              )}
              {senderMsg && <p className={`hint ${senderMsg.ok ? '' : 'err'}`}>{senderMsg.text}</p>}
            </div>

            {/* ------------- the box under posts ------------- */}
            <div className="card">
              <label className="check">
                <input
                  type="checkbox"
                  checked={status.open}
                  disabled={openBusy}
                  onChange={(e) => toggleOpen(e.target.checked)}
                />
                <span>
                  <strong style={{ fontSize: 13 }}>Show "Get new posts by email" under every post</strong>
                  <br />
                  <span className="hint">Turning it off hides the box. Nobody is unsubscribed.</span>
                </span>
              </label>
              {openBusy && <span className="spinner" style={{ marginLeft: 26 }} />}
              {openMsg && <p className="hint">{openMsg}</p>}
            </div>

            {/* ------------- subscribers ------------- */}
            <div className="card">
              <strong style={{ fontSize: 13 }}>Subscribers ({count})</strong>
              {subscribers?.length === 0 && <p className="hint">Nobody has subscribed yet.</p>}
              <div className="subscriber-list">
                {subscribers?.map((s) => (
                  <div className="perm" key={s.id}>
                    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{s.email}</span>
                    <span className="hint" style={{ margin: 0 }}>{when(s.at)}</span>
                    <button className="ghost danger" onClick={() => remove(s.id)}>
                      {confirmRemove === s.id ? 'Remove?' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
              <div className="row-split" style={{ marginTop: 10 }}>
                <input
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addEmail.trim() && add()}
                  placeholder="Add someone who asked to be on the list"
                  spellCheck={false}
                />
                <button style={{ flex: '0 0 90px' }} onClick={add} disabled={!addEmail.trim()}>
                  Add
                </button>
              </div>
              {listMsg && <p className="hint err">{listMsg}</p>}
            </div>

            {/* ------------- writing to everyone ------------- */}
            <div className="card">
              <strong style={{ fontSize: 13 }}>Send an email to all subscribers</strong>
              <div className="field" style={{ marginTop: 10 }}>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
              </div>
              <div className="field">
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  placeholder="Your message. Leave a blank line between paragraphs."
                />
              </div>
              {progress ? (
                <p className="hint">
                  <span className="spinner" style={{ verticalAlign: -2, marginRight: 6 }} />
                  Sending… {progress.sent} of {progress.total}
                </p>
              ) : confirmSend ? (
                <div className="row-split">
                  <button className="primary" onClick={sendNow}>
                    Send to {plural(count, 'subscriber')} now
                  </button>
                  <button className="ghost" onClick={() => setConfirmSend(false)}>
                    Not yet
                  </button>
                </div>
              ) : (
                <button
                  className="primary"
                  onClick={() => setConfirmSend(true)}
                  disabled={!ready || !count || !subject.trim() || !body.trim() || sending}
                >
                  Send…
                </button>
              )}
              {!ready && <p className="hint">Choose how emails are sent first.</p>}
              {sendMsg && <p className={`hint ${sendMsg.ok ? 'ok' : 'err'}`}>{sendMsg.text}</p>}
            </div>

            {/* ------------- what was sent ------------- */}
            {status.mailings?.length > 0 && (
              <div className="card">
                <strong style={{ fontSize: 13 }}>Sent</strong>
                {(status.mailings as Mailing[]).map((m) => (
                  <div className="perm" key={m.id}>
                    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
                      {m.post ? 'New post: ' : ''}
                      {m.subject}
                    </span>
                    <span className="hint" style={{ margin: 0 }}>
                      {when(m.at)} · {m.sent} of {m.total}
                    </span>
                    {!m.finishedAt && m.sent < m.total && (
                      <button className="ghost" onClick={() => resume(m)} disabled={sending || !ready}>
                        Send the rest
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="actions">
          <button onClick={onClose} disabled={sending}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
