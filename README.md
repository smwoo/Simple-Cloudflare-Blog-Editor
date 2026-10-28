# Blog Editor

A desktop app for writing a blog with photos and videos, without needing to know
how websites work. You write posts and drag photos in; the app shrinks the photos
and videos for the web, stores them, and publishes your blog.

Your blog runs on **your own Cloudflare account**. Cloudflare's free plan covers
a personal blog; you only pay if you go past its free storage, which takes a
very large photo library. The app is just a tool on your computer: nobody else
hosts or sees your blog's data.

## Download and install

Go to the **[Releases page](https://github.com/smwoo/Simple-Cloudflare-Blog-Editor/releases)**,
open the newest release, and download the file for your computer:

| Your computer | File to download |
| --- | --- |
| Windows 10 or 11 | `Blog-Editor-Setup-….exe` |
| Mac with Apple silicon (M1 or newer) | `Blog-Editor-…-mac-arm64.dmg` |
| Older Intel Mac | `Blog-Editor-…-mac-x64.dmg` |

Not sure which Mac you have? Click the Apple menu → **About This Mac**. If it
says "Chip: Apple M…", you have Apple silicon.

You do not need to install anything else. Everything the app uses comes inside it.

### Windows

1. Double-click the downloaded `.exe`.
2. Windows shows **"Windows protected your PC"**. This appears because the app is
   made by an individual, not a company that pays for a certificate. Click
   **More info**, then **Run anyway**. You only see this once.
3. Follow the installer, then open **Blog Editor** from the desktop or Start menu.

Windows updates the app automatically when a new version is released.

### Mac

1. Double-click the downloaded `.dmg`, then drag **Blog Editor** into the
   **Applications** folder.
2. Open Blog Editor from Applications. macOS says it **cannot verify the
   developer**. Click **Done** (not "Move to Trash").
3. Open **System Settings → Privacy & Security**, scroll down to the message
   about Blog Editor, and click **Open Anyway**. Confirm with your password.

You only do this once. The Mac version does not update itself yet: to update,
download the new `.dmg` from the Releases page and drag it into Applications again.

## Setting up your blog (first time only)

The first time you open the app, it asks you to set up your blog. This takes
about ten minutes. If someone comfortable with technology is helping you, this
is the part to do together.

You need:

- **A Cloudflare account.** Sign up free at [cloudflare.com](https://dash.cloudflare.com/sign-up).
- **Cloudflare's photo storage (R2) turned on.** In the Cloudflare dashboard,
  open **R2 Object Storage** and follow the prompt to enable it. Cloudflare asks
  for a payment card even on the free plan; a normal blog stays within the free
  allowance.

Then the app walks you through three steps:

1. **Cloudflare permission.** Click **Open Cloudflare API tokens**, create a token
   with the permissions the app lists (including **D1 — Edit**, which lets the
   blog be used from other computers), set it to never expire, and paste it into
   the app. Press **Check**: every permission should get a green tick.
2. **Photo storage keys.** Click **Open R2 API tokens**, create a token with
   **Object Read & Write**, and paste the **Access Key ID** and **Secret Access
   Key** into the app. Cloudflare shows the secret only once, so copy it straight away.
3. **Your blog.** Choose a short name (it becomes part of the web address), a
   title, and your name. Press **Set up the blog**.

When it finishes, your blog is live at an address like
`https://your-name.your-account.workers.dev`, which you can share straight away.

## Writing posts

- **New post** starts a post. It saves automatically as you type.
- **Photos and videos:** drag them onto the post to place them there, or onto the
  **Photos** panel on the right to keep them for later — select them there and
  press **Insert** when you want them in the post. Several photos together
  become a gallery. The app prepares them for
  the web automatically; your originals are kept untouched on your computer.
- **Preview** shows the post as it will look online.
- **Publish** puts the post on your blog. **Update** republishes changes.
- **Comments:** visitors can leave a comment under any published post with just
  their name, and reply to a comment to start a conversation under it. To remove
  a comment you do not want, open the post and press **Comments**. Blogs set up
  before comments existed get them the next time you publish.
- **Newsletter:** visitors can leave their email address at the end of a post to
  hear about new ones. Emails are sent with a free [Resend](https://resend.com)
  account (up to 100 emails a day). Set it up in **Settings** → **Newsletter**:
  enter your sending address and Resend key, turn on the box under posts, and
  send yourself a test. When you publish, tick **Email subscribers** beside
  **Publish**. In the same Settings screen you can write an email to all
  subscribers and remove addresses. Every email has an unsubscribe link. This
  needs your own web address (see below). See [NEWSLETTER.md](./NEWSLETTER.md)
  for the Resend setup.

## Good to know

- **Your own web address.** If you own a domain at Cloudflare (or buy one there),
  open **Settings** (the gear icon) → **Web addresses** and add it, for example
  `alice.com` or `blog.alice.com`.
- **Where your work is kept.** Your posts and photo list are kept in your own
  Cloudflare account, so they are safe if this computer is lost. Original photos
  stay on the computer you added them from; the blog only ever holds the
  web-ready versions.
- **Using another computer.** Install the app there and choose **Connect to my
  blog**. It asks only for a Cloudflare token — the one you used before, or a
  new one with the same permissions — and finds your blog by itself. Nothing on
  the blog changes. Photos added on the first computer show straight from your
  blog, so nothing big is downloaded. Changes on either computer appear on the
  other; if the same post is changed on both at once, both versions are kept.
- **Switching to a different blog.** **Settings** → **Disconnect…** restarts the
  app on setup. The blog stays online and your other computers are unaffected.
  This computer's copy is set aside as a `blog-disconnected-…` folder in the
  app's data folder, not deleted; rename it back to `blog` (with the app closed)
  to return to it.
- **Updating from an older version.** Blogs set up before version 0.2 need the
  **D1 — Edit** permission added to their Cloudflare token (Cloudflare → My
  Profile → API Tokens → Edit). The app asks for it, then gets the blog ready
  for other computers by itself. Do this on the computer that has the blog
  before connecting a second one.
- **If something goes wrong,** open **Settings** → **Copy report**, and send the
  text to whoever helped you set up. It contains no passwords or keys.
- **Uninstalling** the app does not take your blog offline. It keeps running on
  Cloudflare until you delete it there.

---

# For developers

Each user owns and pays for their own infrastructure. The app is a tool, not a
hosted platform: it runs no server and holds nothing on anyone's behalf.

See [PLAN.md](./PLAN.md) for the design and [CODE-SIGNING.md](./CODE-SIGNING.md)
for the distribution decision.

## How it fits together

```
        ┌──────────── the owner's own Cloudflare account ───────────┐
        │  Worker  <name>.<subdomain>.workers.dev                   │
        │  ├── static assets  ← the built Hugo site                 │
        │  └── R2 binding     ← serves /media/* from their bucket   │
        │  R2 bucket: media/… and _source/… (backup)                │
        └───────────────────────────┬───────────────────────────────┘
                                    │ direct upload — no git, no CI
                         ┌──────────┴──────────┐
                         │   Electron app      │
                         └─────────────────────┘
```

Media lives in R2 rather than as Worker assets because 14 of 52 videos in the
reference library exceed the 25 MiB per-file asset limit (largest 94 MB). The
bucket stays private and the Worker serves it, which removes the R2 custom
domain, a second hostname and a DNS record from setup entirely.

## Development

```sh
npm install
node scripts/fetch-binaries.mjs   # hugo + ffmpeg >= 8 into resources/bin/
npm run dev                       # Electron with HMR
npm test                          # 176 tests
npm run typecheck
npm run smoke                      # build, render once, screenshot, assert no console errors
```

Without `fetch-binaries` the app falls back to `hugo`/`ffmpeg` on `PATH`, which
is fine for development on a machine that has them.

### Packaging

```sh
npm run pack:mac     # dmg, arm64 + x64
npm run pack:win     # NSIS installer, x64 only
```

CI builds each platform on its own runner — Windows installers built from macOS
hit wine friction, and macOS notarization only runs on macOS.

### Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag -a v0.1.2 -m v0.1.2 && git push origin v0.1.2
```

CI builds the Mac dmgs and the Windows installer and publishes them as one
pre-release with the install notes from `.github/release-notes.md`. Installed
Windows copies pick it up through auto-update; Mac users reinstall.

## Layout

```
src/shared/      types + the markdown serializer (used by both processes)
src/main/        Electron main
  cloudflare/    API client, R2, Worker deploy
  media/         ffmpeg wrapper, conversion pipeline, job queue
  site/          Hugo scaffold, build, preview server
  db/            config + secrets store, asset library
  newsletter/    email rendering, Resend sender, resumable send
  setup.ts       provisioning
  publish.ts     publish + source backup
  domain.ts      custom domain attachment
src/preload/     the only renderer↔OS bridge
src/renderer/    React UI
  editor/        TipTap, the three atomic media nodes, asset store
  library/       photo library pane
  setup/         Setup mode (for the helper)
resources/
  site-template/ the Hugo site, self-contained (no submodule, no CDN)
  bin/           fetched binaries (gitignored)
```

## Things that will bite you

- **ffmpeg must be ≥ 8.** The HDR branch uses swscale colour conversion that
  older builds lack. `ffmpeg-static` ships 6.1.1 and `@ffmpeg-installer` ships
  4.x — neither works, which is why `scripts/fetch-binaries.mjs` exists and
  asserts the version at build time.
- **Images go through sharp, not ffmpeg.** ffmpeg is smaller and faster and
  honours EXIF orientation, but it strips the ICC profile. Phone photos are
  Display P3; without the profile a browser reads P3 as sRGB and every
  saturated colour flattens.
- **Keys are allocated at drop time, not upload time.** That is what keeps the
  document stable while uploads run. Do not "fix" it to insert on completion.
- **Media is referenced as `/media/…`, never an absolute URL.** A custom domain
  is then one config value and a rebuild, instead of rewriting every post.
- **Never overwrite a media key.** Objects ship `immutable` with a one-year
  max-age, so a replacement serves stale bytes from the edge for months.
- **`latest.yml` must be `no-cache`** if updates are ever served from R2.
- **Always build with `--cleanDestinationDir`.** Hugo does not clean its output
  directory, which is how the reference site accumulated 12 stale stylesheets.
