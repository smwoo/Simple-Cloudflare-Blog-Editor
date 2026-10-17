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
  checkToken: (token: string) => invoke<any>('setup:checkToken', token),
  provision: (input: any) => invoke<any>('setup:provision', input),
  onSetupProgress: (fn: (steps: any[]) => void) => on('setup:progress', fn),
  health: () => invoke<any[]>('setup:health'),

  // posts
  listPosts: () => invoke<any[]>('posts:list'),
  readPost: (slug: string) => invoke<any>('posts:read', slug),
  saveDraft: (post: any) => invoke<any>('posts:saveDraft', post),
  deletePost: (slug: string) => invoke<any>('posts:delete', slug),
  publish: (post: any) => invoke<any>('posts:publish', post),
  onPublishProgress: (fn: (p: any) => void) => on('publish:progress', fn),

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
  reveal: (which: 'originals' | 'site') => invoke<void>('shell:reveal', which),
  backupNow: () => invoke<any>('backup:now'),
  restoreBackup: () => invoke<any>('backup:restore'),
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
