import type { Editor } from '@tiptap/core'

export interface LinkDraft {
  href: string
  from: number
  to: number
}

/** "example.com" → "https://example.com"; leaves mailto:, /paths and #anchors alone. */
export function normalizeHref(raw: string): string {
  const href = raw.trim()
  if (!href) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return href
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`
  return `https://${href}`
}

/** Snapshot the selection, since focusing the address field blurs the editor. */
export function startLink(editor: Editor): LinkDraft {
  const { from, to } = editor.state.selection
  return { href: editor.getAttributes('link').href ?? '', from, to }
}

export function applyLink(editor: Editor, draft: LinkDraft): void {
  const href = normalizeHref(draft.href)
  if (!href) return removeLink(editor, draft)

  const chain = editor.chain().focus().setTextSelection({ from: draft.from, to: draft.to })
  if (draft.from === draft.to && !editor.isActive('link')) {
    // Nothing selected: insert the address itself as the link text.
    chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else {
    chain.extendMarkRange('link').setLink({ href }).run()
  }
}

export function removeLink(editor: Editor, draft: LinkDraft): void {
  editor
    .chain()
    .focus()
    .setTextSelection({ from: draft.from, to: draft.to })
    .extendMarkRange('link')
    .unsetLink()
    .run()
}
