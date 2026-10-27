# Using one blog from several computers

Status: **built, not yet run against a live Cloudflare account.** Target
release v0.2.0. Companion to [PLAN.md](./PLAN.md); this replaces the `_source/`
backup design in §6 there.

Where it lives: `src/main/cloudflare/d1.ts` (REST client), `src/main/sync/`
(schema, typed queries, the sync engine, migration, connect and recovery),
`src/renderer/src/setup/Connect.tsx`. Tests in `src/main/sync/__tests__` run
the real SQL on `node:sqlite` against fake accounts and buckets.

Deviations from the design below:

- Posts are stored as the whole markdown file (`markdown`), plus `title`,
  `date` and `draft` columns for listing, rather than front matter and body
  apart. Files are shared byte for byte, with no parse round trip.
- Version snapshots are kept at most every ten minutes per post, not on every
  autosave, so the last 20 cover real history rather than the last minute.
- On a conflict the computer that is typing keeps the slug; the other version
  becomes a draft copy, "Title (from Alice's MacBook)".
- Editing a post that another computer deleted brings it back rather than
  losing the writing.
- Timestamps come from the database clock, so a computer with the wrong time
  cannot hide its changes from the others.
- `BLOG_EDITOR_USER_DATA=<dir>` runs the app on a separate data folder: for
  smoke runs, and for trying sharing with two "computers" on one machine.

Not covered yet:

- The Worker ignores `Range`, so a video shown from the blog plays without
  seeking until it has loaded. The live site has the same limitation; Safari
  is stricter about it than Chromium.
- No UI for renaming this computer or for browsing `post_versions`.

Today the blog is locked to the computer that set it up. The goal: install the
app on any computer, connect it to the existing blog, and carry on — same posts,
drafts, photo library and settings — without adding storage cost and without any
server outside the owner's own Cloudflare account.

---

## 1. Constraints

- **No storage bloat.** R2 holds what the live blog serves, plus small video
  poster frames. Originals are never uploaded.
- **Owner's account only.** Shared state lives in a D1 database in the owner's
  Cloudflare account. The app talks to it through the Cloudflare REST API with the
  owner's token. The Worker does not bind D1, so the public site gains no new
  surface.
- **Two existing users** must migrate without losing a draft.

## 2. What the code does today

| Data | Where | Off-machine? |
|---|---|---|
| Posts (markdown) | `site/content/posts/*.md` | Mirrored to `_source/posts/` in R2 (`publish.ts` `backupSource`, `saveDraft`) |
| `hugo.yaml` | `site/` | `_source/hugo.yaml` |
| Web media | `media/` | Yes, R2, keyed by asset key |
| `config.json` (account, bucket, URL, title, author, custom domain, site password) | local | No |
| `library.json` (assets, with **absolute** paths) | local | No |
| Thumbnails, posters, H.264 preview proxies | `cache/` | No |
| Originals | `originals/` | No |
| Token + R2 keys | `secrets.bin` (safeStorage) | No, and machine-bound |

Problems this exposes:

- `restoreSource()` exists but no UI calls it, and it restores posts only.
- `backupSource()` writes a dated copy of **every** post to `_source/history/` on
  every publish and never prunes it.
- **Hazard:** `provision()` always scaffolds a fresh site with only `welcome.md`
  and deploys it (`setup.ts`, steps 5–7). Running setup on a second computer with
  the same blog name would replace the live blog with an empty one.

## 3. Where state lives after this change

| Store | Contents | Why |
|---|---|---|
| **R2** `<name>-media` | Web media, plus `<key>.poster.jpg` for each video | Already served by the Worker at `/media/*` |
| **Worker** `<name>` | Built site | Unchanged |
| **D1** `<name>-db` | Blog settings, R2 keys, posts, recent versions, asset rows, machines | Small text; shared; conditional updates give conflict detection for free |
| **Local** | Hugo site dir, originals, media and thumbnails this computer created, local paths, the Cloudflare token | Speed and offline work. Everything except originals is rebuildable |

`_source/` is retired once migration completes (§8).

## 4. D1 schema

```sql
blog(id INTEGER PRIMARY KEY CHECK (id = 1),
     schema_version, name, title, author, site_url, custom_domain,
     site_password, bucket, r2_access_key_id, r2_secret, updated_at)

posts(slug TEXT PRIMARY KEY, front_matter TEXT /* JSON */, body TEXT,
      version INTEGER, updated_at, updated_by, deleted_at)

post_versions(slug, version, body, saved_at, machine_id)   -- last 20 per slug

assets(key TEXT PRIMARY KEY, kind, post_slug, grp, state, bytes_output,
       width, height, duration_sec, has_poster, created_at, origin_machine)

machines(id TEXT PRIMARY KEY, name, platform, app_version, last_seen)
```

- **R2 keys live in `blog`.** A new computer needs only a Cloudflare token. This
  grants nothing new: any token that passes the permission check already has
  *Workers R2 Storage — Edit*. They are visible in the D1 console to anyone who
  can sign in to the owner's account, who could already reach the bucket.
- **The Cloudflare token is never stored in D1.** It stays in each computer's
  safeStorage.
- Each computer caches the R2 keys in its own safeStorage too, so it works
  offline. Rotating them in Settings updates the `blog` row, and other computers
  take the new keys on their next pull.

`library.json` remains as a local cache: the D1 row plus this computer's
**relative** paths and an `originalAvailable` flag.

## 5. Sync rules

- **Save:** write the file locally at once, then
  `UPDATE posts SET …, version = version + 1 WHERE slug = ? AND version = ?`.
  Zero rows changed means another computer saved first. Keep both versions, as
  "*Title* (from Alice's MacBook)", and tell the user plainly.
- **Offline:** saves queue locally and are sent, with the same version check,
  when the connection returns.
- **Pull:** on launch and on window focus, fetch rows with `updated_at` after the
  last pull.
- **Delete:** set `deleted_at`. A post deleted on one computer never comes back
  from another.
- **Assets:** keys are immutable and never reused, so asset rows never conflict.
- **Presence:** refresh `machines.last_seen` every minute. If another computer
  was active in the last 5 minutes, show a banner: "Your blog is also open on
  *Alice's MacBook*". This warns; it does not lock.
- **Publish gate:** publish is blocked until the pull has finished and the
  outgoing queue is empty. A deploy replaces the whole site, so it must be built
  from the complete post set.

## 6. Media on a computer that did not add it

Media is **never deliberately downloaded**. It is read from the blog's own public
address: the Worker serves `/media/*` from R2, and the site password does not
gate media.

- **One switch point:** the `blogmedia://` protocol handler (`index.ts`). It
  serves from disk if the file exists. Otherwise it streams
  `https://<custom domain or site URL>/media/<key>` through Electron `net.fetch`.
  The renderer CSP and the `assetStore.ts` URLs do not change. `net.fetch` uses
  Chromium's HTTP cache, and media is served `immutable`, so each file crosses
  the network once and the edge serves it without an R2 read.
- **Preview pane:** Hugo preview mounts the local media folder at `/media`
  (`hugo.ts`). A `session.webRequest` redirect sends a preview `/media/<key>`
  request with no local file to the live address.
- **Library grid:** images use the web AVIF itself, lazy-loaded and scaled. No
  thumbnail is generated for remote assets.
- **Video posters:** the media queue uploads `<key>.poster.jpg` (~50 KB) next to
  each video. That is about 50 MB per 1,000 videos, against a 10 GB free tier.
  The editor shows a still on every computer. The published site also gets a
  proper poster, because `shortcodes/video.html` already accepts `poster` and
  the serializer starts emitting it.
- **Video playback on Windows:** web output can be HEVC (`libx265`), which many
  Windows machines cannot decode. That is why the local H.264 proxy exists. For
  a remote video the editor tries the remote file first. If it will not decode,
  it shows "Can't play here — open on the blog", which opens the live post. No
  download.
- **Offline:** a grey tile with "Shows when you're online". Writing and saving
  still work.
- **No local file needed elsewhere:** remote assets are already `live`, so
  `flushUploads` skips them. Hugo builds do not read media. Delete removes R2
  keys directly.
- **`originalAvailable: false`** hides re-convert and quality actions, which
  would otherwise compress a web file a second time.

## 7. Connecting a new computer to an existing blog

The first screen offers two choices: **Set up a new blog** and **I already have
a blog — connect to it**.

### Steps the user sees

1. **Cloudflare permission.** Paste a token and press **Check**. This is the
   same screen and permission list as setup. A shared token and one token per
   computer are both accepted. The blog is identified by account and D1 row,
   never by token. Help text suggests one token per computer, so a lost laptop
   can be cut off alone, but does not require it.

   | | Shared token | Token per computer |
   |---|---|---|
   | New computer | Paste the same token | Create one with the listed permissions |
   | Lost laptop | Revoke it, re-paste a new one everywhere | Revoke only that one |
   | Migration (§8) | Edit permissions once | Edit each |

2. **Choose your blog.** For **every** account the token can see, list the D1
   databases and read the `blog` row of each candidate. A database counts only if
   that table exists, not just because the name matches. Show a card for each:
   title, web address, post count, last edited, and on which computer. A single
   blog is preselected: "Yes, this is my blog".

3. **Bringing your blog to this computer** (progress screen):
   1. Write `config.json` from the `blog` row, plus the account ID and database
      ID. Store the token and R2 keys in safeStorage.
   2. Register this computer in `machines` with a friendly name, editable later.
   3. `scaffold(siteDir, config)` from the bundled template, **without** the
      welcome post.
   4. Write every non-deleted post to `site/content/posts/`.
   5. Build `library.json` from `assets`. Every entry is remote and has
      `originalAvailable: false`.
   6. Run a **local build only**, to prove the site builds here. **Connect never
      deploys.**
   7. Open the editor.

### Failure cases

| Case | What the app does |
|---|---|
| Token is for the wrong account (most likely) | "No blog found in *Bob's Account*. Is this the account you used when the blog was set up?" "Set up a new blog" is only a small secondary link. |
| Blog not migrated yet (bucket has `_source/`, no D1) | If the original computer still works: "Open Blog Editor on your other computer and update it, then press Check again." If it is lost: **Recover from backup** rebuilds D1 from `_source/posts/` and from listing the R2 media keys, then connects. |
| Database `schema_version` newer than this app | "Update Blog Editor on this computer first", with a link to the latest release. |
| R2 keys in D1 rejected | "Your blog's storage keys no longer work." The user enters new keys here; they are saved back to D1. |
| Interrupted mid-way | Every step can safely run again. Nothing in Cloudflare is written except the `machines` row. |

### Why this is safe

- The blog is chosen by **data in D1**, not by a typed name, so a typo cannot
  create or overwrite a blog.
- Connect never deploys. The first publish from the new computer runs only
  after the full post set has been pulled (§5 publish gate).
- Setup checks first as well (§9 phase 0): if `<name>-db` exists or the bucket
  has `_source/`, it offers Connect instead of deploying.

## 8. Migrating the two existing users

1. **Ship v0.2.0.** Windows users update automatically. **Mac users must
   download the new `.dmg` themselves.** Tell them directly.
2. **Token permission.** On launch the token check reports *D1 — Edit* missing.
   The app shows "Add **D1 → Edit** to your Cloudflare token", with a link.
   Editing a token's permissions keeps its value, so nothing is re-entered.
3. **One-time migration on the original computer.** Local files are the truth,
   not `_source/`.
   - Create `<name>-db` (adopt it if it exists) and apply the schema.
   - Insert the `blog` row from `config.json` and the R2 keys from safeStorage.
   - Insert every local post, drafts included.
   - Insert assets from `library.json`. Rewrite paths as relative. Set
     `originalAvailable` from what is actually on disk.
   - Upload `<key>.poster.jpg` for each video from the local `cache/`. Nothing
     is re-encoded.
   - Register this computer.
   - **Verify** that D1 row counts match local post and asset counts. Only then
     delete `_source/` from R2.
   - Every step can safely run again. If interrupted, it resumes on the next
     launch.
4. Settings shows **"Ready to use on another computer ✓"**.
5. On the second computer: install, choose **Connect**, and follow §7.

Before release, rehearse on a copy of each user's real data folder, or a
faithful stand-in, on both macOS and Windows.

## 9. Build order

| # | Work | Ships alone? |
|---|---|---|
| 0 | Setup refuses to deploy over an existing blog; offers Connect | Yes, ship now |
| 1 | `cloudflare/d1.ts` (parameterised `/query`), schema, *D1 — Edit* in `REQUIRED_PERMISSIONS` with a list-databases probe, setup creates `<name>-db` | |
| 2 | Relative library paths; `originalAvailable` | |
| 3 | Save, publish, delete and the media queue write to D1 with version checks and the offline queue; upload video posters; serializer emits `poster` | |
| 4 | Migration (§8) | |
| 5 | Connect flow (§7); remote fallback in `blogmedia://`; preview redirect; remote video playback fallback | |
| 6 | Pull on focus, conflict copies, presence banner | |
| 7 | Remove `backupSource`, `restoreSource` and `_source/history`; keep recover-from-backup as a one-time path | Becomes v0.2.0 |

### Tests

- Relative path round trip, macOS and Windows separators
- Setup refuses when D1 or `_source/` exists
- Connect, then publish, builds the full site
- Connect interrupted and re-run
- Wrong-account token; token that sees several accounts
- Concurrent saves keep both versions
- A deleted post does not come back
- Offline queue is sent on reconnect
- Migration interrupted and resumed; `_source/` kept until counts match
- Recovery from `_source/` only
- D1 `schema_version` newer than the app is refused
- `blogmedia://` falls back to the live URL when the local file is missing
