// @vitest-environment happy-dom
/**
 * The Newsletter dialog against a stand-in for the main process: what it
 * shows, and that sending asks once more before it goes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Newsletter } from '../Newsletter.js'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let el: HTMLElement
let calls: { name: string; args: unknown[] }[]

const status = {
  ok: true,
  sender: { fromEmail: 'news@alice.com', fromName: 'Alice', hasResendKey: true },
  open: true,
  subscribers: 2,
  announced: [],
  mailings: [
    { id: 7, post: 'nov', subject: 'November', at: Date.UTC(2026, 10, 1), finishedAt: null, sent: 1, total: 2 },
  ],
  sending: null,
  customDomain: 'alice.com',
}

beforeEach(async () => {
  calls = []
  const record =
    (name: string, answer: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ name, args })
      return answer
    }
  ;(window as any).api = {
    newsletterStatus: record('status', status),
    listSubscribers: record('list', {
      ok: true,
      subscribers: [
        { id: 1, email: 'bob@example.com', at: 0 },
        { id: 2, email: 'cy@example.com', at: 0 },
      ],
    }),
    sendNewsletter: record('send', { ok: true, mailing: { sent: 2, total: 2 } }),
    resumeMailing: record('resume', { ok: true, mailing: { sent: 2, total: 2 } }),
    onNewsletterProgress: () => () => {},
    openExternal: async () => {},
  }
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => root.render(React.createElement(Newsletter, { onClose: () => {} })))
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const button = (text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement

const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Newsletter dialog', () => {
  it('shows the sender, the subscribers and an unfinished mailing', () => {
    expect(el.textContent).toContain('Subscribers (2)')
    expect(el.textContent).toContain('bob@example.com')
    expect((el.querySelector('input[placeholder="newsletter@alice.com"]') as HTMLInputElement).value).toBe('news@alice.com')
    expect(el.textContent).toContain('New post: November')
    expect(button('Send the rest')).toBeTruthy()
  })

  it('asks once more before sending to everyone', async () => {
    await act(async () => {
      type(el.querySelector('input[placeholder="Subject"]')!, 'Hello')
      type(el.querySelector('textarea')!, 'News')
    })
    await act(async () => button('Send…').click())
    expect(calls.some((c) => c.name === 'send')).toBe(false)
    await act(async () => button('Send to 2 subscribers now').click())
    expect(calls.find((c) => c.name === 'send')?.args).toEqual([{ subject: 'Hello', body: 'News' }])
    expect(el.textContent).toContain('Your email was sent to 2 subscribers.')
  })
})
