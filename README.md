# Blog Editor

A desktop app that sets up and runs a blog for someone non-technical. They
install it, double-click an icon, and get a working blog on their own Cloudflare
account — no terminal, no repository, no DNS, no domain purchase. Then they
write posts and drag photos in; the app converts the media, stores it, and
publishes.

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
npm test                          # 46 tests
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

## Layout

```
src/shared/      types + the markdown serializer (used by both processes)
src/main/        Electron main
  cloudflare/    API client, R2, Worker deploy
  media/         ffmpeg wrapper, conversion pipeline, job queue
  site/          Hugo scaffold, build, preview server
  db/            config + secrets store, asset library
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
