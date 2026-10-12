# Code signing, explained

Written for the decision you actually face: distributing a Windows desktop app
privately to one or a few known, non-technical people — not publishing it to the
world. That context changes the answer a lot, so the recommendation is at the end
of the reasoning, not the start.

> Prices, product names and eligibility rules in this area change often. Treat the
> numbers as "roughly, as of early 2026" and confirm before buying.

---

## 1. What actually happens when they run an unsigned installer

Two separate Windows mechanisms fire, and people conflate them.

**Mark of the Web (MOTW).** When a browser downloads a file, Windows tags it with a
hidden alternate data stream (`Zone.Identifier`) recording that it came from the
internet. That tag is what makes everything downstream treat the file as suspect.
A file copied from a USB stick or a network share may not carry it at all.

**SmartScreen.** On running a MOTW-tagged executable, Windows checks its hash and
signing certificate against Microsoft's reputation service. The possible outcomes:

| state | what the user sees |
|---|---|
| known-good reputation | runs, no prompt |
| unknown file, unsigned | **"Windows protected your PC"** — a blue full-screen dialog. The only visible button is *Don't run*. |
| unknown file, signed | same dialog, but the publisher name is shown instead of "Unknown publisher" |
| known-bad | blocked outright |

The critical detail: in the unknown-file dialog, **the Run-anyway button is not
visible.** The user has to click the small *More info* link first, and only then
does *Run anyway* appear. There is no way to guess that. A non-technical person
reading "Windows protected your PC" with one button offering to not run it will
conclude they have downloaded a virus, and stop — this is the single biggest
failure point in handing someone an unsigned app.

A second, less predictable problem: **antivirus false positives.** Unsigned
Electron apps packaged with NSIS get flagged by Defender and third-party scanners
with some regularity, because the shape (a packer-built installer that unpacks a
large binary and writes to AppData) resembles malware. Signing does not make this
impossible, but it reduces it substantially and gives you something to appeal with.

---

## 2. What signing does and does not buy

**Does:**

- Replaces "Unknown publisher" with your verified name in every dialog.
- Proves the binary has not been altered since you built it.
- Accrues reputation **to the certificate**, so once one of your releases is
  trusted, later releases signed with the same certificate inherit that trust —
  this is the part that matters for an app that auto-updates.
- Materially reduces antivirus false positives.

**Does not:**

- Make the first download instantly trusted. With an ordinary (OV) certificate you
  still get the SmartScreen dialog until reputation accumulates — which depends on
  download volume you will never reach with a two-person audience. **This is the
  trap: people buy a cheap certificate expecting the warning to disappear, and it
  doesn't.**
- Vouch for the software being safe. It is identity, not quality.
- Help on a machine where the user ignores dialogs anyway.

---

## 3. The options

### Nothing (unsigned)

**Cost: $0.** The user sees the dialog on first install.

The mitigation that actually works: **you install it for them.** In person, or over
a screen-share, once. They never meet the dialog. Everything after that is
auto-updates, and — see §5 — those usually do not trigger SmartScreen at all.

For a two-person private distribution this is a completely legitimate choice, and
it is what I would do first.

### OV (Organization Validation) certificate

**Roughly $200–400/year.** The CA verifies your identity or business. You get your
name in the dialogs and AV false positives drop.

Two catches:

1. **No instant SmartScreen trust.** Reputation still has to build. With your
   download volume, it may effectively never.
2. **Since June 2023, the private key must live on certified hardware** — a FIPS
   140-2 Level 2 HSM or USB token — per CA/Browser Forum rules. You can no longer
   be handed a `.pfx` file and sign with it in CI. Signing from GitHub Actions
   therefore requires a cloud signing service (DigiCert KeyLocker, SSL.com eSigner,
   and similar), which is an extra subscription and an extra integration. A
   physical USB token means signing only from the machine it is plugged into,
   which rules out CI entirely.

This is the option that looks obvious and usually disappoints.

### EV (Extended Validation) certificate

**Roughly $400–600/year.** Heavier vetting. Historically the only route to
immediate SmartScreen reputation, and still generally better than OV on that front,
though reports suggest the advantage has narrowed.

Also hardware-key-bound, with the same CI consequences. And the blocker for you:
**EV typically requires a registered business entity.** As an individual, you
generally cannot buy one.

### Azure Trusted Signing

**Roughly $10/month.** Microsoft's own cloud signing service, and the one genuinely
interesting option here. Certificates are short-lived and fully managed; you never
handle a key. It is built for CI, with a supported GitHub Actions path, and it
integrates with `electron-builder`.

Microsoft opened it beyond organizations to **individual developers**, subject to
identity verification — reportedly including a requirement that your verifiable
identity history goes back about three years. Confirm current eligibility and
region availability before planning around it; it also needs an Azure subscription.

If you ever decide signing is worth it, this is almost certainly the right product:
it is an order of magnitude cheaper than the alternatives, it works in CI without
an HSM dance, and it comes from the vendor whose warning you are trying to avoid.

### Self-signed certificate

**Cost: $0, and worthless here.** SmartScreen does not trust a certificate that
does not chain to a trusted root. It would only help if the user first installed
your root certificate into their Trusted Root store — a more technical operation
than clicking through the warning you are trying to avoid.

---

## 4. macOS, if you also want it on your own machine

The equivalent gate is **Gatekeeper**. An unsigned, un-notarized `.app` that was
downloaded gives *"cannot be opened because the developer cannot be verified."*

- **For yourself:** `xattr -d com.apple.quarantine /Applications/YourApp.app`, or
  approve it under System Settings → Privacy & Security. Free, fine. Note that
  recent macOS versions have tightened the old Control-click → Open shortcut for
  un-notarized apps, pushing you to System Settings instead — so this is slightly
  more awkward than it used to be, and worse than Windows for a non-technical
  person, because there is no "run anyway" button in the first dialog at all.
- **For anyone else:** Apple Developer Program, **$99/year**, which gets you a
  Developer ID certificate plus notarization (you upload each build to Apple, they
  scan it, you staple the ticket). Unlike Windows, this is binary — once notarized
  there is no reputation period, it just works.

macOS is the cheaper and more deterministic of the two platforms to sign. If the
non-technical user is on Windows and you are the only Mac user, skip it.

---

## 5. How this interacts with auto-updates

This matters more than it first appears.

`electron-updater` downloads the new installer **itself**, rather than through a
browser. Files fetched that way generally do not get the Mark of the Web, so the
SmartScreen check that fires on a browser download typically does not fire on an
update.

The practical consequence: with an unsigned app, **the first install is the only
real hurdle.** If you get them past it once, updates flow silently. That is what
makes "install it for them, stay unsigned" a durable answer rather than a
postponement.

Conversely, if you ever distribute by emailing a new `.exe` each time, every
release is a fresh unknown file and you will hit the dialog every release. Set up
auto-update early — it is worth more than a certificate here.

---

## 6. Recommendation

**Ship unsigned. Do each first install yourself. Set up auto-update in the same
session.**

Rationale: your audience is **2–5 known friends**, so certificate reputation — the
thing you would be paying for — can never accumulate at all. SmartScreen trust is
earned through download volume; five downloads is indistinguishable from zero. An
OV certificate would cost a few hundred a year plus a cloud-HSM subscription to
work in CI, and the warning would still appear. There is no price at which the
expensive option works at this scale.

Five installs is also still hand-doable: roughly fifteen minutes each, once ever.
And because Mark of the Web is applied by the *browser*, handing the installer over
on a USB stick or a local network share often avoids the prompt entirely. An OV certificate
would cost a few hundred a year, require a cloud HSM subscription to work in CI,
and *still* show the warning. The expensive option solves a distribution problem
you do not have.

**Revisit if any of these become true:**

- the group stops being small and known — people you cannot sit next to, or
  reach by text, for the one install;
- you start distributing by sending `.exe` files instead of auto-updating;
- Defender starts quarantining your builds, which is disruptive in a way the
  one-time dialog is not.

At that point go to **Azure Trusted Signing** (~$10/month), not an OV certificate.

**Either way, do these now, because they are free:**

1. Wire up `electron-updater` from the first release, so the install dialog is a
   one-time event rather than a recurring one.
2. Write the four-line install note with a screenshot of the *More info → Run
   anyway* path, in case you cannot be there.
3. Build and distribute release artifacts from CI, not from your laptop, so adding
   signing later is a config change rather than a rebuild of your process.

---

## 7. If you do sign, the mechanics

`electron-builder` handles Windows signing declaratively. With Azure Trusted
Signing, you configure the endpoint, account and certificate-profile name in the
`win` block and supply Azure credentials as GitHub Actions secrets; builder invokes
the signing service during packaging. With a cloud HSM product instead, you point
`win.signtoolOptions` at the provider's signing tool.

Two things to get right whichever route you take:

- **Sign the installer and the app executable**, not just one of them.
- **Timestamp every signature.** Without a timestamp, signatures stop validating
  the day the certificate expires; with one, builds signed during the
  certificate's validity remain valid afterwards.
