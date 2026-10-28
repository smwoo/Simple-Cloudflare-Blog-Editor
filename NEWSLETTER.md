# Newsletter

Visitors leave their email address in a box at the end of each post. When the
owner publishes, they can tick **Email N subscribers** beside Publish, and every
subscriber gets one email with a link to the post. Settings → Newsletter also
sends an email the owner writes to everyone, lists and edits the subscribers,
and shows what was sent. Every email has its own unsubscribe link and a
one-click unsubscribe header, which mail apps show as a button.

## How the email is sent

Sending email to people who did not sign up for an account at the sender is
the one thing a Cloudflare-only blog cannot do for free. Options considered
(October 2026):

| | Cloudflare Email Sending | Resend | Email Routing `send_email` | MailChannels |
| --- | --- | --- | --- | --- |
| Sends to anyone | Yes | Yes | **No** — verified addresses only | — |
| Cost | Workers Paid, $5/mo, 3,000 included, then $0.35 per 1,000 | Free: 100/day, 3,000/month. Pro $20/mo for 50,000 | Free | Free Workers integration ended in 2024 |
| Extra account | No | Yes, plus an API key | No | Yes |
| Per request | 1 email (50 recipients max) | 100 emails (`/emails/batch`) | — | — |
| Status | Beta; new accounts start on a low daily quota | Generally available | GA | — |
| Domain setup | Onboard the domain under Email Service → Email Sending (dashboard only) | Add the domain under Domains, then add its DNS records | — | — |

Both usable options need the blog's own domain, on Cloudflare DNS for
Cloudflare. Neither can send from `*.workers.dev`, so the newsletter is only
useful once a custom domain is attached.

The app supports both, and the owner chooses in Settings → Newsletter:

- **Cloudflare** keeps to the "one service" principle and uses the token the app
  already holds. Add **Account → Email Sending → Edit** to it. The cost is
  the paid plan.
- **Resend** keeps to the "costs nothing" principle for a family blog (under
  100 subscribers per post). The cost is a second account.

## Design

- **Subscribers live in the visitors' database** (`<name>-comments`, bound to
  the Worker as `COMMENTS`), beside comments, because the Worker writes them.
  Its schema is ensured at every deploy, and by the app on first use.
- **Sending settings live in the shared database** (`newsletter_sender`), so
  every computer sends the same way. The Resend key sits beside the R2 secret,
  where the Worker cannot read it, and is never passed to the renderer.
- **The app sends, not the Worker.** Sending runs only when the owner presses
  something, and the app already holds the credentials. The Worker needs no
  email binding and no secrets.
- **Mailings and deliveries.** Every email is a `mailings` row, and every
  subscriber it reached is a `deliveries` row, written after each batch. A send
  that stops at a daily limit resumes with **Send the rest** and reaches only
  the people it missed. A new-post email is unique per post, so two computers
  (or two presses) cannot both send it.
- **The database clock.** Mailings are timed by the database clock, and
  subscriptions by the Worker's. A mailing goes to those subscribed when it was
  written, whatever the laptop's clock says.
- **One email per subscriber**, never a shared `to` list: each carries its own
  unsubscribe link, and nobody sees anyone else's address.
- **Unsubscribe** is `/api/unsubscribe?t=<token>`. GET only asks, because mail
  scanners open links. POST removes the address. The POST is also the RFC 8058
  one-click target in `List-Unsubscribe` / `List-Unsubscribe-Post`.
- **Subscribing** follows the comment rules: JSON body only, honeypot, five per
  address per ten minutes. It answers the same whether or not the address
  was already subscribed.

## Not done

- **Double opt-in.** Anyone can enter someone else's address. That person gets
  only post notices, each with a working unsubscribe link, but a confirmation
  email would stop it. That needs the Worker to send, through a `send_email` or
  secret binding.
- **Bounce handling.** Addresses that bounce stay on the list. Both services
  suppress repeat bounces on their side.
- **Domain onboarding from the app.** Cloudflare documents no API for it yet.
  Resend's could be automated with a Zone DNS Edit permission.
- **Live testing.** Neither service has been exercised from the app against a
  real account. The request shapes follow the documentation, and the first test
  email from Settings → Newsletter is the check.
