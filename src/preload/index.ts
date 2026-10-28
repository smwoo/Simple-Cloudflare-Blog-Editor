/**
 * The only bridge between the renderer and the OS.
 *
 * Context isolation is on and node integration is off, so the renderer can do
 * nothing except call these named channels. Secrets never cross this boundary:
 * the token is passed *in* during setup and never read back out.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const on = (channel: string, fn: (payload: any) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, payload: any) => fn(payload)
  ipcRenderer.on(channel, handler)
  // Must return void, not the IpcRenderer removeListener() hands back, so this
  // is usable directly as a React effect cleanup.
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  // status + setup
  status: () => invoke<any>('app:status'),
  checkToken: (token: string, accountId?: string) => invoke<any>('setup:checkToken', token, accountId),
  provision: (input: any) => invoke<any>('setup:provision', input),
  onSetupProgress: (fn: (steps: any[]) => void) => on('setup:progress', fn),
  health: () => invoke<any[]>('setup:health'),

  // connecting this computer to an existing blog
  findBlogs: (token: string) => invoke<any>('connect:find', token),
  connectBlog: (args: { token: string; accountId: string; databaseId: string; keys?: any }) =>
    invoke<any>('connect:run', args),
  recoverBlog: (args: { token: string; blog: any; keys: any }) => invoke<any>('connect:recover', args),
  onConnectProgress: (fn: (detail: string) => void) => on('connect:progress', fn),
  /** Set this computer's copy of the blog aside and restart on setup. */
  disconnect: (force: boolean) =>
    invoke<{ ok: boolean; unsent?: number; uploading?: number }>('app:disconnect', force),

  // sharing with other computers
  syncStatus: () => invoke<any>('sync:status'),
  retryMigration: () => invoke<any>('sync:migrate'),
  syncNow: () => invoke<any>('sync:pull'),
  onSyncStatus: (fn: (s: any) => void) => on('sync:status', fn),
  onSyncChanged: (fn: (c: { posts: string[]; assets: number }) => void) => on('sync:changed', fn),
  onSyncConflict: (fn: (c: { slug: string; copySlug: string; machineName: string }[]) => void) =>
    on('sync:conflict', fn),

  // posts
  listPosts: () => invoke<any[]>('posts:list'),
  readPost: (slug: string) => invoke<any>('posts:read', slug),
  saveDraft: (post: any) => invoke<any>('posts:saveDraft', post),
  deletePost: (slug: string) => invoke<any>('posts:delete', slug),
  publish: (post: any) => invoke<any>('posts:publish', post),
  unpublish: (post: any) => invoke<any>('posts:unpublish', post),
  removePost: (slug: string, media: boolean) => invoke<any>('posts:remove', { slug, media }),
  onPublishProgress: (fn: (p: any) => void) => on('publish:progress', fn),

  // comments visitors left on the blog
  listComments: (slug: string) => invoke<any>('comments:list', slug),
  deleteComment: (id: number) => invoke<any>('comments:delete', id),

  // the newsletter: subscribers, how it is sent, and sending
  newsletterStatus: () => invoke<any>('newsletter:status'),
  /** The Resend key goes in only; leaving it out keeps the saved one. */
  saveNewsletterSender: (s: { fromEmail: string; fromName?: string; resendKey?: string }) =>
    invoke<any>('newsletter:saveSender', s),
  sendTestEmail: (to: string) => invoke<any>('newsletter:test', to),
  setSubscribeOpen: (open: boolean) => invoke<any>('newsletter:setOpen', open),
  listSubscribers: () => invoke<any>('newsletter:subscribers'),
  addSubscriber: (email: string) => invoke<any>('newsletter:add', email),
  removeSubscriber: (id: number) => invoke<any>('newsletter:remove', id),
  sendNewsletter: (msg: { subject: string; body: string }) => invoke<any>('newsletter:send', msg),
  announcePost: (slug: string) => invoke<any>('newsletter:announce', slug),
  resumeMailing: (id: number) => invoke<any>('newsletter:resume', id),
  onNewsletterProgress: (fn: (p: { mailingId: number; sent: number; total: number }) => void) =>
    on('newsletter:progress', fn),

  // media
  pickFiles: () => invoke<string[]>('media:pick'),
  addMedia: (files: string[], postSlug: string, group: string) =>
    invoke<{ keys: string[]; rejected: string[] }>('media:add', { files, postSlug, group }),
  listMedia: (postSlug?: string) => invoke<any[]>('media:list', postSlug),
  unplacedMedia: () => invoke<any[]>('media:unplaced'),
  deleteMedia: (keys: string[]) => invoke<any>('media:delete', keys),
  retryMedia: (key: string) => invoke<void>('media:retry', key),
  mediaStats: () => invoke<any>('media:stats'),
  onMediaProgress: (fn: (p: any) => void) => on('media:progress', fn),

  // preview
  startPreview: () => invoke<any>('preview:start'),
  stopPreview: () => invoke<any>('preview:stop'),

  // domain
  registrarUrl: (domain?: string) => invoke<string | null>('domain:registrarUrl', domain),
  attachDomain: (domain: string) => invoke<any>('domain:attach', domain),
  listDomains: () =>
    invoke<{ hostname: string; withWww: boolean; primary: boolean }[]>('domain:list'),
  removeDomain: (hostname: string) => invoke<any>('domain:remove', hostname),
  onDomainProgress: (fn: (p: any) => void) => on('domain:progress', fn),

  // site
  setSitePassword: (password: string) => invoke<any>('site:setPassword', password),

  // misc
  openExternal: (url: string) => invoke<void>('shell:open', url),
  openPostOnBlog: (slug: string) => invoke<void>('shell:openPost', slug),
  reveal: (which: 'originals' | 'site') => invoke<void>('shell:reveal', which),
  buildReport: () => invoke<string>('report:build'),
  updateState: () => invoke<any>('update:state'),
  onUpdateState: (fn: (s: any) => void) => on('update:state', fn),

  /**
   * Drag-and-drop gives the renderer a File, not a path. webUtils turns it back
   * into one so the main process can read the original bytes rather than a copy
   * marshalled through IPC.
   */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
