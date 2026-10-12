# Blog editor

A desktop app that sets up and runs a blog for someone non-technical. They install
it, double-click an icon, and get a working blog on their own Cloudflare account —
no terminal, no repository, no DNS, no domain purchase. Then they write posts and
drag photos in; the app converts the media, stores it, and publishes.

Each user owns and pays for their own infrastructure. The app is a tool, not a
hosted platform — it holds nothing on their behalf and runs no server.

Companion doc: [CODE-SIGNING.md](./CODE-SIGNING.md).

Reference material throughout comes from an existing Hugo blog with a hand-rolled
media pipeline (`convert-media.sh`, `upload-r2.sh`) and about 1.3 GB of published
media. Its encoding settings are proven and are carried into the app unchanged;
its measurements are used below to justify design decisions.

---

## 1. Principles

1. **The app does the technical work, not the user.** Every resource it needs, it
   creates. Setup is a one-time job done with a technical helper (§4); everything
   after that, the owner does alone and never sees a dashboard.
2. **One service.** Cloudflare only. Every extra account is a barrier — someone
   non-technical should not need a GitHub account to write a blog.
3. **Zero installed dependencies.** No Node, Hugo, ffmpeg, git, or AWS CLI. The
   installer carries everything.
4. **Every failure surfaces in the app, in plain language,** with the one action
   that fixes it.
5. **Nothing is ever lost.** Local autosave plus off-machine backup (§6).
6. **It should cost them nothing.** See §2.

---

## 2. Architecture

```
        ┌──────────────────── their Cloudflare account ───────────────────┐
        │                                                                 │
        │   Worker  <name>.<their-subdomain>.workers.dev                  │
        │   ├── static assets  ← the built Hugo site (HTML/CSS/JS)        │
        │   └── R2 binding     ← serves /media/* from their bucket        │
        │                                                                 │
        │   R2 bucket                                                     │
        │   ├── media/…        AVIF + MP4                                 │
        │   └── _source/…      markdown + config (backup)                 │
        └─────────────────────────────────────────────────────────────────┘
                 ▲
                 │  direct upload — no git, no CI, no build on Cloudflare
        ┌────────┴────────┐
        │  Electron app   │  bundled: hugo, ffmpeg, sharp, wrangler
        └─────────────────┘
```

### Media lives in R2, but the Worker serves it

Shipping media as Worker static assets would leave Cloudflare with a single moving
part, so it is worth checking whether R2 is needed at all. It is. Measured across
the reference library:

| | count | total | mean | max |
|---|---|---|---|---|
| images (AVIF) | 402 | 106 MB | 269 KB | 540 KB |
| video (HEVC MP4) | 52 | 1,241 MB | 23.9 MB | **93.6 MB** |

**14 of 52 videos exceed the 25 MiB per-file limit on Worker static assets**, the
largest at 94 MB. Video is 92% of total storage. R2 is a requirement, not a
preference. (Confirm current asset limits before building; they move.)

The bucket does **not** need to be public, though. Binding R2 to the Worker and
serving `/media/*` through it removes an entire tier of setup: no R2 custom domain,
no second hostname, no DNS record, no `r2.dev` rate limits. The Worker is ~20 lines:

```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/media/')) return env.ASSETS.fetch(req)
    const obj = await env.MEDIA.get(url.pathname.slice('/media/'.length))
    if (!obj) return new Response('Not found', { status: 404 })
    return new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    }})
  }
}
```

Cloudflare's CDN caches on that header, so repeat views never reach the Worker.

### No GitHub, no domain

Requiring someone non-technical to create a GitHub account, understand a
repository, and authorise a token is itself the barrier this app removes. Deploying
straight to Cloudflare also eliminates the access token and its yearly expiry, the
Workers-to-repository connection, and any question of where the site gets built —
publishing is a direct upload, so build failures surface locally by construction.

The cost is losing git as history and backup. §6 replaces it.

Likewise, `<name>.<subdomain>.workers.dev` is free and immediate, so first-run
needs no domain and no payment. Moving to a real domain later is a guided upgrade
(§7) — and if the domain is bought through Cloudflare Registrar, it stays genuinely
easy, because the zone arrives already on Cloudflare's nameservers.

One design consequence, decided here because it is expensive to change later:
**media is referenced by root-relative path (`/media/…`), never by absolute URL.**
The Worker serves site and media on one origin, so relative paths work everywhere —
and a later domain change becomes a config edit rather than a rewrite of every post
ever written.

### What it costs them

The Workers free plan covers a blog read by a handful of people, static asset
requests are not metered the way dynamic ones are, and R2 has no egress charges.
R2 storage is free to 10 GB and then roughly $0.015/GB-month — against the measured
~1.3 GB per year of fairly video-heavy blogging, that is **$0/month for years**.
Confirm current limits and prices, and state the expectation plainly during setup
so nobody fears a surprise bill.

---

## 3. What the user does

**Once, with a helper** (§4) — someone comfortable with a dashboard, half an hour:

```
 1. Install the app, double-click
 2. Create a free Cloudflare account
 3. Create an API token in the dashboard   → paste it into Setup mode
 4. "What should your blog be called?"     → name + availability check
 5.  ███████████░░░  Setting up your blog…   ~60 seconds, the app does everything
 6. "Your blog is live at alice.workers.dev"
```

**Every day after, alone:**

```
 Open the app → New post → write → drag photos in → Publish
```

The owner never returns to Cloudflare. If something breaks later the helper is
probably not in the room, which is why §8 matters as much as §4.

---

## 4. Setup

**Setup assumes a technical helper.** Someone comfortable with a Cloudflare
dashboard sits with the owner once, creates an API token, and runs the app's setup
screen. That changes what this section has to be: the permission step is an ordinary
task for a competent person, not a cliff for a novice, so the app does not need to
teach Cloudflare's permission model through screenshots.

What it does **not** change is everything after setup. The helper will not be there
at 11pm six months later when a token is revoked or storage fills up, so §8's
plain-language error handling stands exactly as written — with "send this to the
person who set it up" as a legitimate resolution, backed by **Copy report**.

### Two modes, two audiences

Trying to serve both people with one interface is what makes these apps bad. Split
them:

- **Setup mode** — for the helper. Shows the real fields, the actual API responses,
  and the specific failure. Verbose on purpose. Reachable from a *Set up this blog*
  screen on first run, and from Settings afterwards.
- **Write mode** — everything else. The owner never sees a token, an account ID, or
  the word *Worker*.

### The token

The helper creates a Cloudflare API token in the dashboard with:

| permission | why |
|---|---|
| Workers Scripts — Edit | deploy the site |
| Workers R2 Storage — Edit | create the bucket, store media |
| Account Settings — Read | read the account ID and `workers.dev` subdomain |
| Zone — Read + Workers Routes — Edit | **only for custom domains (§7)** |

Two recommendations worth following:

- **Include the Zone permissions up front, even though nothing uses them yet.**
  They cost nothing now and mean a later custom domain needs no second visit from
  the helper. The reason to keep scope minimal — that first-run is where novices
  abandon — does not apply when a competent person is doing it deliberately.
- **Create the token with no expiry.** Cloudflare allows it, and an expiring token
  is a silent time bomb that kills publishing months later and requires the helper
  again. This is the single cheapest reliability decision in the plan.

Steer away from the **Global API Key**: it is easier to find, so it is what someone
will reach for unaided, and it is account-wide god mode that the app would then
store. Detect it and say why not.

Cloudflare OAuth would still be nicer than a pasted token — one *Authorize* click —
and `wrangler login` shows the machinery exists. But with a helper present it is a
convenience rather than a risk mitigation, so it is no longer worth blocking on.

### Validation still earns its keep

The app verifies each permission independently, because a half-scoped token is the
most common setup failure and the difference between *"The token is missing
permission to create storage — tick Workers R2 Storage"* and a bare 403 is minutes
versus an hour, even for someone technical.

### Provisioning, performed by the app

| # | step | how |
|---|---|---|
| 1 | verify token, read account ID | `/user/tokens/verify`, `/accounts` |
| 2 | check and claim the `workers.dev` subdomain | Workers subdomain API |
| 3 | create the R2 bucket | R2 API |
| 4 | scaffold the Hugo site into the app's data directory | local |
| 5 | build it with bundled Hugo | local, ~36 ms |
| 6 | deploy the Worker with assets + R2 binding | Workers upload API |
| 7 | fetch the live URL, assert 200 | HTTP |
| 8 | upload a probe image, fetch it through `/media/`, assert 200 and cache header | HTTP |

Steps 7 and 8 are the ones that matter — everything before them can succeed while
the site is still broken. Bundle `wrangler` and drive it rather than reimplementing
the asset-upload protocol; it already handles the manifest, hashing, and deployment
sequence.

Provisioning must be **idempotent and resumable**: if it dies at step 6, re-running
adopts the bucket that already exists instead of failing on a name collision. This
matters more than polish here — a helper who can re-run a step is unblocked; a
helper who has to clean up half-created resources by hand is not.

### Afterwards: Connection health

The same checks, re-runnable from Settings forever, each green or red with one
sentence, ending in **Copy report** — app version, OS, which check failed, last 50
log lines, credentials scrubbed. This is what the owner sends the helper.

Credentials live in Electron `safeStorage` (DPAPI on Windows, Keychain on macOS),
never in a plaintext file.

---

## 5. The app

### Bundled, so nothing is installed

One Electron codebase ships to both platforms. Electron itself is the easy part —
the bundled native binaries are where cross-platform claims actually break, so each
was checked rather than assumed:

| need | component | macOS | Windows | note |
|---|---|---|---|---|
| shell | Electron 44 | ✓ arm64 + x64 | ✓ x64 | Node 24.21, Chrome 152 |
| images | `sharp` | ✓ darwin-arm64, darwin-x64 | ✓ win32-x64, win32-arm64 | full prebuilt coverage |
| video | `ffmpeg` + `ffprobe` | ⚠ see below | ⚠ see below | **not from npm** |
| site build + preview | `hugo_extended` 0.167 | ✓ darwin-universal | ✓ windows-amd64 | **no windows-arm64 build** |
| deploy | `wrangler` | ✓ | ✓ windows-64 | drags in `workerd`; no windows-arm64 |
| storage API | `@aws-sdk/client-s3` | ✓ | ✓ | pure JS |
| secrets | Electron `safeStorage` | ✓ Keychain | ✓ DPAPI | built in |

Installer lands around 250–300 MB per platform. That is the price of double-click.

**Target Windows x64 only.** Neither `hugo_extended` nor `workerd` publishes a
windows-arm64 build, and chasing that gap is not worth it — Windows on ARM runs
x64 binaries under emulation, so an x64 build still works there. macOS gets both
architectures, helped by Hugo's `darwin-universal`.

**Do not source ffmpeg from npm.** The conversion pipeline's HDR branch relies on
swscale colour conversion that needs **ffmpeg ≥ 8**, and the convenient packages
are far behind: `ffmpeg-static@5.3.0` ships ffmpeg **6.1.1**, and
`@ffmpeg-installer/ffmpeg` ships the **4.x** series. Neither works. Fetch pinned
≥ 8 builds per platform at CI time instead, and assert the version at app startup
so a regression surfaces as a build failure rather than washed-out video months
later. `ffmpeg-static` also ships no `ffprobe`, which the HDR detection needs.

**`workerd` is dead weight if you only deploy.** It is wrangler's *local runtime*,
pulled in as a dependency and worth roughly a hundred megabytes. Exclude it from
the packaged app unless you actually run a Worker locally.

**Database:** Electron 44 carries Node 24.21, so `node:sqlite` should be present
and would mean zero native modules to rebuild per platform. Verify that early — if
Electron has it disabled, fall back to `better-sqlite3`, which is proven in
Electron but needs a native rebuild for each platform and architecture.

**HEVC playback in the preview pane is a real Windows gap.** HEVC was chosen
deliberately for size and iOS compatibility, and Chromium on macOS decodes it
natively. On Windows, Chromium leans on a platform decoder that is present on many
machines but not all — some need the OEM or paid Store HEVC extension. So the
owner could drag in a video and find it will not play *inside the app*, while it
plays perfectly on the published site. Mitigate by generating a small H.264 proxy
alongside each video purely for in-app preview — ffmpeg is already bundled and it
costs seconds — and keep poster frames for library thumbnails regardless.

### Images use sharp; only video uses ffmpeg

Using one bundled ffmpeg for both would be tidier, so I benchmarked it on a real
4032×3024 photo:

| encoder | output | bytes |
|---|---|---|
| ImageMagick `-quality 80` (reference pipeline) | 1200×900 | 327,950 |
| ffmpeg `libsvtav1 -crf 24` | 1200×900 | 304,148 |
| ffmpeg `libsvtav1 -crf 28` | 1200×900 | 254,043 |

ffmpeg wins on size, and it **does** honor EXIF orientation — on an `Orientation=6`
photo it produced 900×1200, matching `magick -auto-orient`. That matters: 38 of 59
sampled photos have non-default orientation, so getting it wrong turns most of a
library sideways.

But it strips the colour profile:

```
ImageMagick:  Profile-icc: 536 bytes   icc:description: Display P3
ffmpeg:       (none)
```

Phone photos are **Display P3**. Without the profile a browser reads P3 primaries
as sRGB and every saturated colour flattens — on a photo blog, that is the point of
the images. So: **sharp for images** (AVIF out, `.rotate()` for EXIF, keeps ICC),
**ffmpeg for video**, and ffmpeg as a decode fallback feeding sharp for HEIC, which
sharp's prebuilt binaries cannot read and which any iPhone user produces on day one.

*Calibration task:* quality numbers do not transfer between encoders. Encode a
dozen representative photos across sharp quality 50–80, compare by eye, and pick
the lowest that is visually indistinguishable. The table above is bytes only — I
did not judge quality visually, and that call is yours.

### Video settings

Taken unchanged from the reference pipeline, where they were hard-won: HEVC
`libx265` CRF 26 preset slow, `-tag:v hvc1` (Safari will not recognise the track
otherwise), `+faststart`, `yuv420p` 8-bit, 30 fps, fit inside 1080p without
upscaling, metadata stripped, AAC 128k stereo — plus an HDR branch converting
iPhone HLG/PQ footage to SDR BT.709 while scaling, keyed off `ffprobe`'s
`color_transfer`.

### Layout

```
┌────────────┬──────────────────────────────┬──────────────┐
│ posts      │  editor                      │  photos      │
│            │  ┌────────────────────────┐  │  [this post ▾]│
│ Nov 2026   │  │ title · date · cover   │  │  ▦ ▦ ▦ ▦     │
│ Oct 2026   │  ├────────────────────────┤  │  ▦ ▦ ▦ ▦     │
│ Sept 2026  │  │ ## The daylight dims   │  │              │
│            │  │ Hello everyone…        │  │  ⇅ drop here │
│ + New post │  │ ┌──────────────────┐   │  │              │
│            │  │ │ ▦ ▦ ▦  gallery   │   │  │  3 unplaced  │
│            │  │ └──────────────────┘   │  │              │
│            │  └────────────────────────┘  │  Preparing…  │
│            │  [preview]        [Publish]  │  ███░░ 8/14  │
└────────────┴──────────────────────────────┴──────────────┘
```

### The editor: TipTap

**TipTap 3 (ProseMirror).** Core, React bindings and the starter kit are all MIT at
3.31.4, and the free starter kit already covers every block and mark needed —
headings, paragraphs, bullet and ordered lists, bold, italic, strike, link,
blockquote, horizontal rule. Nothing here needs a paid extension.

Chosen over the alternatives for two properties that matter more than features:

- **Atomic nodes with custom rendering.** ProseMirror's `atom: true` plus a
  NodeView is precisely the primitive the three shortcodes need: each renders as a
  real React component showing the real thing, while the cursor can never get
  inside it. Syntax cannot be broken by someone clicking in the wrong place,
  because there is no text there to edit.
- **Schema-enforced validity.** ProseMirror will not let an invalid document exist.
  For a non-technical user clicking, dragging and pasting, that guarantee is worth
  more than any amount of defensive serializer code.

Lexical is the credible fallback — also MIT, no commercial tier at all — but its
markdown and decorator-node story requires more scaffolding for the same result.
Revisit only if TipTap's licensing changes shape.

### Document model

```
doc
├── heading (h2, h3)
├── paragraph  ← text with bold / italic / link marks
├── bulletList / orderedList
├── gallery    ⟵ atom   { items: [assetId…], caption? }
├── video      ⟵ atom   { assetId, caption? }
└── figure     ⟵ atom   { assetId, caption?, align }
```

**Media nodes store an asset id, never a URL.** The serializer resolves it to
`/media/<key>` at write time. That is what makes a later custom domain a config
change rather than a rewrite of every post (§2), and it lets the editor render from
live library state — an upload's progress, a freshly generated poster frame —
without touching the document.

Serialization is canonical, because the app authors every post:

```
gallery → {{<gallery srcs="/media/a.avif, /media/b.avif">}}
video   → {{<video src="/media/x.mp4">}}
figure  → {{<figure src="/media/y.avif" caption="…" align="center">}}
```

The only test needed is idempotency:

```ts
expect(serialize(parse(serialize(doc)))).toEqual(serialize(doc))
```

Front matter comes from a template; `cover.relative: false` is always written and
never shown. Preview runs bundled `hugo server -D` in an iframe pane — the real
theme, not an approximation.

### How the editor and the media library meet

The library is the right-hand pane. It defaults to **this post's photos**, grouped,
with a toggle to everything. Each tile shows a thumbnail (a poster frame for
video), its state, and whether it is currently placed in the post.

**Four ways media gets into a post**, all converging on the same insert path:

| | action | result |
|---|---|---|
| 1 | drag files from Finder/Explorer **into the document** | ingest, then insert at the drop point |
| 2 | drag files **into the library pane** | ingest, left unplaced for later |
| 3 | drag a library tile **into the document** | insert an existing asset |
| 4 | select tiles → **Insert** | insert at the cursor, in selection order |
| + | paste an image from the clipboard | ingest and insert inline |

Shape is chosen, not asked: 2+ images → `gallery`, 1 image → `figure`, a video →
`video`. Dropping onto an existing gallery appends to it rather than creating a
second one.

**Ingest asks exactly one question** — *"What should we call this group?"*, with
autocomplete over groups already used in this post. Everything else is derived:
the key is `media/<post-slug>/<group>/<n>.avif`. Conversion and upload run behind a
single progress bar reading *"Preparing 14 photos…"*, never an ffmpeg log.

### The detail that makes this work: assign keys at ingest

The final object key is decided **when the file is dropped**, not when the upload
finishes. The node gets its asset id immediately, the gallery appears straight away
with placeholder tiles that fill in as conversion completes, and the document is
**stable and serializable from the first second** — including as a draft, before
anything has been uploaded.

The alternative — insert on upload completion — means either blocking the writer
behind a two-minute video encode or rewriting the document underneath them while
they type. Both are worse, and the second is the kind of bug that eats a paragraph.

State lives in the library, not the document: `local → converting → uploading →
live`. The editor renders whatever the library currently knows.

**Publishing blocks on pending uploads.** A post referencing media that has not
landed yet would publish broken images, so Publish waits for the queue to drain —
*"Finishing 3 photos…"* — rather than racing it.

### Working with a gallery

`gallery` is the workhorse — 62 of 124 shortcode uses in the reference blog — so it
gets the most attention. Inside the node: thumbnails drag to reorder, a hover ✕
removes one, a trailing drop zone accepts more, and a caption field sits beneath.
Selecting the node and pressing Delete removes the whole thing. `figure` gets an
inline caption and an alignment control; `video` shows a player with its poster
frame.

Alt text is not demanded — it is friction a non-technical user will not accept —
but the caption doubles as alt text when one is written.

### Photo library internals

SQLite in the app data directory (`node:sqlite` if Electron exposes it, else
`better-sqlite3` — see above): one row per asset with post slug, group, local path,
object key, site path (`/media/…`), bytes in and out, dimensions, poster frame, and
state.

Three views earn their place:

- **In this post** — the default, grouped.
- **Unplaced** — uploaded but not referenced in any post. Someone drags in 40
  photos, places 25, and forgets 15. Without this view those sit in their storage
  forever, paid for and invisible.
- **All photos** — for reusing something from an earlier post.

Offer cleanup of unplaced media from Settings, listing first and deleting only on
explicit confirmation. Never delete automatically.

Originals are copied to a local archive before conversion and never deleted
automatically. Show that folder's size in Settings with a reveal button, so it does
not silently grow to gigabytes.

---

## 6. Publishing and backup

```
Publish →  write the post locally
       →  hugo --minify --cleanDestinationDir      (36 ms)
       →  upload changed media to R2               (content-hashed, skips unchanged)
       →  deploy Worker assets                     (wrangler, hash manifest)
       →  mirror content + config to R2 _source/   (markdown is kilobytes)
       →  fetch the live URL, assert 200
       →  "Published — view your post"
```

**Backup replaces git.** Without a repository there is no version history, and
their laptop is the only machine — so on every publish, and on a timer for drafts,
mirror the markdown and config to `_source/` in their own bucket, keeping the last
N versions of each file. It is kilobytes, it lives in an account they own and pay
for, and it makes recovery on a new machine a matter of installing the app and
signing in.

This is also what keeps drafts safe. An unpublished post otherwise exists in
exactly one place, and a dead laptop takes it along. The user is told none of this;
the status line just reads *"Saved"*.

**No conflicts to handle.** One writer, one blog, one machine. If a deploy fails
midway, re-running is idempotent: media is content-addressed, assets are
hash-manifested, `_source/` is a mirror. Keep a small safety net for a rejected or
partial deploy — retry once, then *"Couldn't publish just now — your draft is safe.
Try again in a minute."*

`--cleanDestinationDir` matters: Hugo does not clean its output directory by
default, which is how the reference site accumulated 12 hashed stylesheets where a
clean build produces 1.

---

## 7. Adding a custom domain

Optional, and never required to start. Offered from Settings as *"Use my own web
address"* once someone has a blog they like.

**Buy it through Cloudflare Registrar.** This is the whole reason the feature is
tractable for a non-technical user: a domain bought at Cloudflare lands in their
account already on Cloudflare's nameservers, with its DNS zone created and active.
The genuinely hard parts of bringing a domain — changing nameservers at another
registrar, waiting on propagation, transfer locks and auth codes — never happen.
Registrar also sells at cost, with no markup on renewal.

Bringing a domain already registered elsewhere is the harder path and should be a
later addition, if ever. The app should say so rather than silently failing on it.

### The flow

```
 1. Settings → "Use my own web address"
 2. "What address would you like?"   → availability + yearly price
 3. [Buy it at Cloudflare]           → opens their browser to checkout
 4. "Done? I'll take it from here"   → app finds the new zone
 5.  ██████░░░  Setting it up…       → attach, rebuild, redeploy, wait for SSL
 6. "alice.com is live"              → old address keeps working
```

**Step 3 happens in a browser, deliberately.** Buying a domain means entering
payment details, and the app must never touch those. Cloudflare's checkout is the
right place for it; the app's job is to make the before and after painless. (Check
whether the Registrar API exposes availability and pricing lookups for step 2 — if
not, step 2 collapses into step 3 and the app simply opens the search page.)

### What the app does in step 5

| # | step | notes |
|---|---|---|
| 1 | find the new zone | `GET /zones` — poll briefly; registration takes a moment to appear |
| 2 | confirm the zone is active | a freshly registered domain should already be |
| 3 | attach the apex as a Worker **Custom Domain** | creates the DNS record and orders the certificate automatically — far simpler than hand-building DNS and routes |
| 4 | attach `www` the same way | both hostnames serve the same Worker |
| 5 | update Hugo's `baseURL` | otherwise RSS, sitemap and canonical links keep pointing at `workers.dev` |
| 6 | rebuild and redeploy | 36 ms build, then a normal deploy |
| 7 | **poll until the certificate is active**, then fetch `https://alice.com` and assert 200 | see below |
| 8 | leave the `workers.dev` address working | a free fallback, and any link already shared still resolves |

**Do not declare success before the certificate is live.** Cloudflare provisions it
automatically, but it takes a minute or two, and in that window the site answers
with an SSL warning. Someone non-technical who visits then will conclude they have
broken their blog and paid for the privilege. Hold the progress bar — *"Securing
your web address, this takes a minute"* — and only then show the link.

### Permissions

Attaching a custom domain needs **Zone read** and **Workers Routes edit**, which
§4 recommends including in the original token even though nothing uses them until
now. Do that and this flow needs no second visit from the helper and no re-auth.

If the token was scoped without them, the app detects it before starting — not as
a 403 halfway through — and says exactly which two permissions to add.

### Why this is cheap to support

Because media is referenced as `/media/…` rather than an absolute URL (§2), moving
to a custom domain rewrites **no content at all**. One config value changes, the
site rebuilds, and every image in every post resolves against whatever host serves
it. Had the app written absolute URLs, this feature would mean rewriting every post
ever published and re-uploading the whole site — the kind of migration that is
easy to get wrong and impossible to explain to a non-technical user.

---

## 8. Designing for someone who will not read an error message

**New post** is the one primary button: title, date, done. The slug and front
matter are derived.

**Vocabulary.** Never *bucket*, *Worker*, *deploy*, *shortcode*, *front matter*,
*CRF*, or *token*. The words are *Publish*, *Photos*, *Cover photo*, *Draft*, and —
once, during setup — *permission*.

**Errors**, each with the single action that fixes it:

| what happened | what they see |
|---|---|
| no network | "No internet connection. Your work is saved — try again when you're back online." |
| permission revoked or expired | "The app lost permission to your Cloudflare account. **Send this to whoever set up your blog**" + **Copy report**, naming the exact permission |
| permission under-scoped | same shape — the owner cannot fix a token, so never ask them to. Name the missing permission precisely so the helper fixes it in one pass, remotely |
| storage over the free tier | "Your photo storage is above the free allowance. Cloudflare will charge about $X/month." — a fact, not an error |
| build failed | "Something's wrong with this post and it can't be published yet." + **Copy report** |
| disk full | "Your computer is out of space. Free up some room and try again." |

**Copy report** on every failure path, producing a pastable block scrubbed of
credentials.

**Autosave** every few seconds to a local draft, independent of publishing.

---

## 9. Distribution, updates and signing

Audience: a handful of known people. Full reasoning in
[CODE-SIGNING.md](./CODE-SIGNING.md).

**Updates.** `electron-updater` with the **generic** provider — a static HTTPS
directory of installers plus a `latest.yml` manifest. Since each user owns their
own storage, the update channel cannot live in a user's bucket; host it in **your**
account, or as GitHub Releases on a public repo, which needs no token. One small
shared dependency is fine: it is yours, not theirs.

> If you serve updates from an R2 bucket, `latest.yml` must be `no-cache`. Under
> the media default of `max-age=31536000, immutable` it would pin everyone to the
> first version they ever saw, permanently and silently.

A **minimum-version floor** is worth the half hour: a build below the floor refuses
to publish and asks them to restart, so nobody writes posts with a stale serializer.

**Signing.** An unsigned installer gives *"Windows protected your PC"* with the
Run-anyway button hidden behind a *More info* link — someone non-technical reads
that as a virus and stops. But a certificate is not the fix at this scale.
SmartScreen trust accrues through download volume that a handful of installs can
never reach, so an OV certificate (~$200–400/yr, plus a cloud-HSM subscription to
work in CI) leaves the warning in place. EV generally requires a registered
business entity.

**Ship unsigned, and do each first install yourself** — in person or over a
screen-share — setting up auto-update in the same session. Updates are fetched by
the app rather than a browser, so they do not pick up the Mark of the Web and
generally do not trigger SmartScreen at all. One dialog per person, ever.

Revisit if distribution grows beyond people you can reach directly; the answer then
is **Azure Trusted Signing** (~$10/month, CI-friendly, open to individuals subject
to identity verification), not an OV certificate.

---

## 10. Phases

**Phase 0 — prove the chain (~2 days).**
Hardcoded token, hardcoded post: create a bucket, scaffold a site, build, deploy the
Worker with assets and an R2 binding, fetch the live URL, fetch a media file
through `/media/`.
*Gate:* a blog exists at a `workers.dev` URL with a working image, created entirely
by code. This retires every architectural unknown in §2 at once, so it goes first.

**Phase 1 — provisioning and setup (~2 days).**
Setup mode, the eight-step provisioner, idempotent resume, per-permission
validation, Connection health, Copy report, `safeStorage`.
*Gate:* set up a blog from a **brand-new Cloudflare account**, as the helper would.
Then deliberately break each precondition — wrong token, missing permission, name
taken, offline mid-provision — and confirm each names the actual problem and
resumes cleanly rather than leaving half-created resources behind.

This is a day shorter than it would be without a helper: the effort that would have
gone into teaching Cloudflare's permission model belongs in Phases 2 and 3 instead,
which is what the owner touches every single time they write.

**Phase 2 — media pipeline (~3 days).**
sharp and ffmpeg conversion, R2 upload, job queue with progress, originals archive.
*Gate:* 20 photos and 2 videos in; correct AVIF and HEVC out, **ICC intact**,
orientation correct, served through `/media/` with the right cache header. Lock the
quality number by eye.

**Phase 3 — editor (~3–4 days).**
TipTap, the three shortcode nodes, front matter template, canonical serializer,
idempotency test, autosave, draft backup to `_source/`, preview pane.
*Gate:* drag 14 photos straight into a paragraph and keep typing while they
convert — the gallery appears immediately, fills in as they land, and the text
never shifts under the cursor. Then hit Publish mid-upload and confirm it waits
rather than shipping broken images.

**Phase 4 — ship (~2 days).**
GitHub Actions on a `windows-latest` runner, electron-builder NSIS installer,
`electron-updater`, the install note.
*Gate:* on a clean Windows machine, from installer to published post, performed by
someone who has never seen it — while you watch silently and fix whatever they
hesitate at.

**Phase 5 — custom domains (~2 days, optional).**
The §7 flow: zone discovery, Worker Custom Domain attachment for apex and `www`,
`baseURL` rewrite, rebuild, certificate polling.
*Gate:* buy a real domain through Cloudflare Registrar and go from `workers.dev` to
it without editing a single post — then confirm the old address still resolves.

Roughly two to three weeks of focused evenings for Phases 0–4, with custom domains
after. With setup assisted, Phases 2 and 3 are now the ones that cannot be
rushed — they are what the owner touches every time they write, alone.

Build on a **CI matrix — `macos-latest` and `windows-latest`** — rather than
cross-compiling. Windows installers built from macOS hit wine friction, and macOS
notarization can only run on macOS, so neither host can produce the other's
artifacts properly. Both runners are free for this workload, and it gives signing
somewhere to attach later if it is ever needed.

---

## 11. Risks

| risk | mitigation |
|---|---|
| **The helper is not there when it breaks months later** | Plain-language errors with "send this to the person who set it up" plus **Copy report** (§8) — this, not setup, is now the riskiest surface |
| Token created with an expiry; publishing dies silently later | Create it with no expiry (§4); warn in-app if one is detected |
| Token scoped without Zone permissions, blocking a later custom domain | Include them up front (§4); detect and name them before the domain flow starts |
| Helper reaches for the Global API Key | Detect it, explain why not, steer back |
| Provisioning dies halfway and leaves orphans | Idempotent and resumable; re-running adopts existing resources |
| Worker asset limits change | Media is in R2, not assets — the limit only binds the built site |
| **npm ffmpeg packages are too old for the HDR path** | Pin ≥ 8 per-platform builds at CI time; assert the version at startup (§5) |
| **HEVC may not play in the preview pane on Windows** | Generate an H.264 proxy for in-app playback only (§5) |
| No windows-arm64 build of Hugo or workerd | Ship Windows x64 only; it runs under emulation on ARM |
| Laptop dies with unpublished drafts | `_source/` mirror in their own bucket, on a timer |
| ICC stripped → flat, desaturated photos | sharp for images; verified in the Phase 2 gate |
| HEIC from an iPhone | ffmpeg decode fallback into sharp |
| Surprise Cloudflare bill | Show expected cost at setup; surface usage before it crosses the free tier |
| They lose their Cloudflare password | It is their account and the app cannot help. Say so at setup, once, plainly |
| SmartScreen stops the install | First install done by you; see CODE-SIGNING.md |
| Update channel placed in a user's own bucket | Host updates in your account, not theirs |
| **Custom domain shows an SSL warning before the certificate lands** | Poll for certificate activation before revealing the link (§7) |
| A domain registered elsewhere | Out of scope — say so plainly rather than half-supporting it |
| Someone never updates and writes with a stale serializer | Minimum-version floor blocks publishing until they restart |
| Originals quietly fill their disk | Archive size shown in Settings with a reveal button |
| Stale assets accumulate in the built site | `--cleanDestinationDir` on every build |

---

## 12. Open questions

1. **Does Cloudflare offer OAuth for third-party apps?** Worth a look, but no
   longer urgent — with a helper doing setup, a pasted token is fine, and OAuth
   would be a convenience rather than a risk mitigation. Revisit only if the app
   ever needs to be self-service.
2. **Does the Registrar API expose availability and pricing?** If it does, the app
   can show *"alice.com — $10.44/year"* in-app before handing off to checkout. If
   not, it just opens Cloudflare's domain search and the flow is one step shorter
   to build. Either way the purchase happens in their browser — see §7.
3. **Does your own blog move onto this?** It has ten hand-written posts and lives on
   GitHub. The app opens existing posts read-only rather than risk reformatting
   them, so the honest answer is probably to leave yours alone and prove the app on
   new blogs first. This also decides whether you need a macOS build.
4. **Site template: one theme, or a choice at setup?** One, initially — every option
   is a support surface.
5. **Privacy.** These blogs are friends-and-family. A client-side password prompt is
   a sign, not a lock — the HTML and every media URL stay fully public to anyone who
   looks. Cloudflare Access is a real lock and is configurable per Worker. Decide
   which the template ships with.

---

## Appendix: settings that must not drift

| setting | value |
|---|---|
| image format | AVIF, max 1200 px, never upscaled |
| image quality | recalibrate for sharp in Phase 2 (ImageMagick q80 is the reference) |
| ICC profile | **keep**; strip EXIF |
| EXIF orientation | bake into pixels (`sharp.rotate()`) |
| video codec | HEVC `libx265`, CRF 26, preset slow |
| video tag | `hvc1` (required by Safari) |
| video size and fps | fit 1080p, no upscale, 30 fps, `yuv420p` |
| video audio | AAC 128k stereo |
| HDR handling | HLG/PQ → SDR BT.709 while scaling |
| faststart | `-movflags +faststart` |
| media key | `media/<post-slug>/<group>/<n>.avif` |
| media reference in posts | **root-relative** `/media/…`, never an absolute URL |
| Hugo `baseURL` | the live host; rewritten and redeployed on a domain change |
| media Cache-Control | `public, max-age=31536000, immutable` (set by the Worker) |
| `latest.yml` Cache-Control | **`no-cache`** — the one exception |
| source backup | `_source/` in the user's own bucket, last N versions |
| Hugo build | `--minify --cleanDestinationDir` |
| Hugo config | `locale:`, not the deprecated `languageCode:` |
