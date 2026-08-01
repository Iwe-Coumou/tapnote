# tapnote

[![Release](https://img.shields.io/github/v/release/Iwe-Coumou/tapnote)](https://github.com/Iwe-Coumou/tapnote/release)
![License](https://img.shields.io/github/license/Iwe-Coumou/tapnote)
![Last commit](https://img.shields.io/github/last-commit/Iwe-Coumou/tapnote)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![NTAG 424 DNA](https://img.shields.io/badge/NFC-NTAG%20424%20DNA-6E4B9E)

An NFC tap-to-reveal message gift. An NFC tag stores a link; tapping it with
a phone opens a page showing a personal message — either a random pick from
a private list, or a specific message queued up in advance. Built to work in
mobile Safari with no app and no Web NFC, so it works from any phone.

## How it works

- A **Cloudflare Worker** (`src/index.js`) serves the page. There's no
  server to manage — Cloudflare runs the code on-demand at the edge.
- **Cloudflare KV** (`TAPNOTE_KV`) stores the message list and the queue
  state. The message list never gets sent to the browser in full — the
  Worker picks one message server-side and returns only that.
- The page (`src/message.html` + `src/style.css`) is a static template with
  one placeholder for the message text, inserted into the DOM via
  `textContent` (never `innerHTML`), and the styles are spliced in the same
  way from a separate file.

## Routes

| Method | Path        | Auth   | Purpose                                                                 |
| ------ | ----------- | ------ | ------------------------------------------------------------------------ |
| GET    | `/message`  | tag    | Returns the styled HTML page with one message (queued message if one is waiting, otherwise random from the pool). Requires a valid, unreplayed NTAG 424 DNA tap signature — see below. |
| POST   | `/queue`    | secret | Body `{ "message": "..." }`. Appends to the queue — taps serve queued messages in order (FIFO) before falling back to random once the queue is empty. |
| GET    | `/queue`    | secret | Returns `{ "queue": [...] }` — the full ordered list of upcoming queued messages. |
| DELETE | `/queue`    | secret | With no body, clears the entire queue. With `{ "index": 1 }`, removes just that one queued item. |
| POST   | `/messages` | secret | Body `{ "message": "..." }`. Appends a message to the random-pick pool permanently. |
| GET    | `/messages` | secret | Returns the full pool as a JSON array. |
| PUT    | `/messages` | secret | Body `{ "messages": [...] }`. Replaces the whole pool at once — pass an empty array to reset it. |
| DELETE | `/messages` | secret | Body `{ "index": 2 }` or `{ "message": "exact text" }`. Removes one message from the pool. |
| POST   | `/reply`    | none   | Body `{ "text": "...", "repliedTo": "..." }`. Public — same posture as `/message` itself, no secret. Max 300 characters. |
| GET    | `/replies`  | secret | View-once: returns all replies as a JSON array (each `{ text, repliedTo, timestamp }`) and clears them as part of the same request. There's no separate delete endpoint — viewing *is* the consuming action, same as `/message` destructively pops the queue. |
| GET    | `/replies/count` | secret | Non-destructive: returns `{ "count": N }` without touching or clearing anything. |
| POST   | `/songs`    | secret | Body `{ "url": "https://open.spotify.com/track/...", "title": "..." }` (`title` optional). Appends a song to the pool. |
| GET    | `/songs`    | secret | Returns the full song pool as a JSON array of `{ url, title }`. |
| PUT    | `/songs`    | secret | Body `{ "songs": [...] }`. Replaces the whole pool at once — pass an empty array to reset it. |
| DELETE | `/songs`    | secret | Body `{ "index": 0 }` or `{ "url": "..." }`. Removes one song from the pool. |

Routes marked `secret` expect an `Authorization: Bearer <ADMIN_SECRET>` header.
The `tag` route is authenticated by the NFC tag itself, not a header.

The two error states reachable through `/message` itself (an invalid/replayed
tag link, or something unexpected failing) render with the same letter
styling via `error.html`, rather than plain browser error text — those are
the only error responses she could ever actually see. Admin-route errors
(401/404 on the CLI-facing endpoints) stay plain text on purpose.

Songs are a plain curated list, not a live Spotify playlist lookup — Spotify's Web API now requires the developer account to hold an active Premium subscription for even basic catalog reads, so `/message` never calls out to Spotify at all. Add track links by hand (Spotify app → Share → Copy Link) via `/songs` or the CLI.

## Project structure

```
src/
  index.js       Worker entry point: routing, KV access, auth
  message.html   Page template (placeholders: __MESSAGE_JSON__, __SONG_JSON__, /*__STYLES__*/)
  error.html     Styled fallback for the error states reachable through /message
  style.css      Page styles, shared by both templates, spliced in at request time
wrangler.toml    Cloudflare config: Worker name, KV binding, module rules
messages.json    Local staging file used to seed KV (gitignored — never committed)
.dev.vars        Local secret values for `wrangler dev` (gitignored — never committed)
```

## Prerequisites

- [Node.js](https://nodejs.org) (LTS) — needed to run `npm`/`wrangler` locally.
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account. No
  payment method is required for anything in this project — Workers Free
  and the Workers KV free tier cover this usage many times over, and
  Cloudflare has no way to bill you without a card on file.

## Setup

```
npm install
npx wrangler login
```

`wrangler login` opens a browser tab to authorize the CLI against your
Cloudflare account.

### Create the KV namespace (one-time)

```
npx wrangler kv namespace create TAPNOTE_KV
```

This prints a `[[kv_namespaces]]` block with an `id` — it should already be
present in `wrangler.toml` if you're picking up this repo as-is, but if
you're setting up a fresh Cloudflare account, replace the `id` with the one
this command gives you.

## Local development

```
npm run dev
```

Serves the Worker locally (usually `http://127.0.0.1:8787`), using a local,
simulated KV store (separate from production — safe to experiment in).

For the authenticated routes to work locally, create a `.dev.vars` file in
the project root (gitignored, never committed):

```
ADMIN_SECRET=some-local-test-value
```

### Seeding messages locally

Create `messages.json` (gitignored) with your message list:

```json
["First message.", "Second message.", "Third message."]
```

Load it into the local KV store:

```
npx wrangler kv key put --binding=TAPNOTE_KV "messages" --path=./messages.json --local
```

### Testing the authenticated routes locally

```powershell
$headers = @{ Authorization = "Bearer some-local-test-value" }
$body = @{ message = "A queued test message" } | ConvertTo-Json

# Queue a specific message for the next tap:
Invoke-RestMethod -Uri "http://127.0.0.1:8787/queue" -Method Post -Headers $headers -Body $body -ContentType "application/json"

# Add a message to the permanent random pool:
Invoke-RestMethod -Uri "http://127.0.0.1:8787/messages" -Method Post -Headers $headers -Body $body -ContentType "application/json"
```

## Deploying to production

```
npm run deploy
```

First deploy will prompt you to register a `workers.dev` subdomain (used for
every Worker on the account, not just this one). After that, set the real
secret and seed the real KV store — both are separate from your local
`.dev.vars`/`--local` KV and are **not** touched by future `npm run deploy`
runs, so you only need to redo these when the values themselves change:

```
npx wrangler secret put ADMIN_SECRET
npx wrangler kv key put --binding=TAPNOTE_KV "messages" --path=./messages.json --remote
```

The live site will be at `https://<worker-name>.<your-subdomain>.workers.dev/message`.

### Ongoing content updates

No redeploy needed to change messages — just hit the live endpoints with
your real `ADMIN_SECRET`, same as the local testing commands above but
pointed at the production URL.

## NTAG 424 DNA verification

`/message` is protected by the tag itself, so the page opens on a real tap
and not from a pasted, bookmarked, or screenshotted URL.

An NTAG 424 DNA in SUN (Secure Unique NFC) mode rewrites its own URL on every
tap, appending two params the chip generates in hardware:

```
/message?picc_data=EF963FF7828658A599F3041510671E88&cmac=94EED9EE65337086
```

`picc_data` is the tag's UID plus a per-tap read counter, AES-encrypted with a
key that only the chip and this Worker hold. `cmac` is a MAC over that data.
`verifyTagAuth()` in `src/index.js` decrypts `picc_data`, re-derives the
per-tap session key, recomputes the CMAC, and compares it. Nothing else can
produce a valid pair — the key never leaves the chip or the Worker.

The read counter is what stops a link from being reused. It only ever
increases, and the last-seen value per UID is stored in KV under
`tag-counter:<uid>`. A shared or screenshotted URL always carries a counter
that's already been served, so it gets the 403 letter page instead.

### Configuration

Verification turns on as soon as a key is set. With no keys configured every
request passes, which is the plain-NFC-tag behaviour this started with — so
the live site keeps working until the hardware is actually swapped.

Keys are raw AES-128 as 32 hex characters, matching what you programmed into
the chip:

```
npx wrangler secret put TAG_AES_KEY
```

| Secret / var | Required | Purpose |
| ------------ | -------- | ------- |
| `TAG_AES_KEY` | to enable | Used for both roles below when they aren't set individually. |
| `TAG_META_KEY` | no | Decrypts `picc_data` — the chip's `SDMMetaReadKey`. Overrides `TAG_AES_KEY`. |
| `TAG_MAC_KEY` | no | Derives the CMAC session key — the chip's `SDMFileReadKey`. Overrides `TAG_AES_KEY`. |
| `TAG_UIDS` | no | Comma-separated hex UID allowlist. Unset means any UID holding the key is accepted. |
| `TAG_REPLAY_GRACE_SECONDS` | no | Window in which the *same* counter may be re-served, so a page refresh doesn't hard-fail. Default `120`; `0` disables it. |

The chip must be configured to mirror both UID and read counter (a
`PICCDataTag` of `0xC7` — 7-byte UID) using **encrypted** PICC data, not
plaintext UID mirroring. Other layouts fail with `unexpected PICC layout`.

Mirrored custom data is optional and handled either way. The chip signs the
literal URL text between `SDMMACInputOffset` and `SDMMACOffset`, so what the
CMAC covers depends on how the tag was programmed — `sdmMacInput()` reads that
range off the raw URL rather than assuming it:

- **No custom data** — the offsets coincide, the signed message is empty.
- **Custom data mirrored** (an `enc=` param) — the signed message runs from
  the start of the `enc` value to the start of the `cmac` value, which means
  it *includes the `&cmac=` separator between them*. Omitting those six
  characters is the non-obvious way to get a MAC that never matches.

A tap is worth exactly one message. Within the grace window the *same* letter
and song are redisplayed rather than drawn again — the pick is recorded
alongside the counter under `tag-counter:<uid>` and replayed on reload. Without
that, a pull-to-refresh would pop another queued message each time, so a single
tap could drain the whole queue.

The grace window is still a deliberate trade: for those two minutes a copied
URL does work, though it only ever shows the letter that tap already revealed.
Set it to `0` if you'd rather a refresh break outright.

Local testing without hardware: put `TAG_AES_KEY=00000000000000000000000000000000`
in `.dev.vars` and use the vector URL above — it's the all-zero-key test
vector, and it verifies once before the replay check takes over.

### Programming a tag (NXP TagWriter, Android)

*Write tags → New dataset → Link → Configure Mirroring.* Use **NXP TagWriter**,
not the NFC Developer App — the latter watermarks every URL it writes with
`_____TRIAL_VERSION______NOT_FOR_PRODUCTION_____` and, worse, re-keys the tag
to a value it doesn't show you. A tag whose key you don't know can never be
reconfigured.

| Setting | Value |
| ------- | ----- |
| Select Card Type | NTAG 424 DNA |
| URI Type | `https://` (not `http://` — iOS wants HTTPS for background tag reading) |
| Enter URL | `tapnote.icoumou.workers.dev/message?picc_data=` + 32 zeros + `&cmac=` + 16 zeros |
| SDM Meta Read Access Right | `01` — a key number, **not** `0E` (plaintext) or `0F` (disabled) |
| Derivation Key for CMAC | `01` |
| Enable Counter Mirroring | ✅ — required; without it there's no replay protection |
| Encrypted File Data Mirroring | ☐ — keeps the signed message empty |
| Enable Read Counter Limit | ☐ |
| SDM Counter Retrieval Key | `0E` (irrelevant — the counter we use comes from inside `picc_data`) |

Offsets are set by placing the cursor in the URL field and pressing the
matching *Set Offset* button. TagWriter counts from the start of the NDEF
file, so they run 7 ahead of the position within the URL text (2 bytes of
length prefix + 5 bytes of record header). For the URL above:

| Offset | Cursor position | Value |
| ------ | --------------- | ----- |
| PICC Data Offset | before the first of the 32 zeros | `53` |
| SDM MAC Offset | before the first of the 16 zeros | `91` |
| SDM MAC Input Offset | same position | `91` |

Equal MAC offsets mean the signed message is empty. **Re-set all three after
any edit to the URL** — they're absolute positions, so changing a single
character invalidates them, and the failure mode is a tag that reads fine and
never verifies.

Leave the keys at factory zeros. Changing them needs a reader (`pylibsdm` with
an ACR122U, or TagXplorer) — TagWriter can't do it, and NXP points at
RFIDDiscover with a PEGODA for the job. It also buys little here: the counter
check is what stops a shared link, and it works regardless of whether the key
is secret.

## A note on how this was built

The idea, design, and product decisions behind this project are mine — I
built it as a personal gift and used it as a chance to learn Cloudflare
Workers. I worked through the implementation with AI assistance (Claude):
it explained the concepts, but I wrote and tested the code myself as I went,
reviewed and understood each piece before moving to the next, and made the
calls on architecture, security, and design decisions throughout. AI acted
as a tutor and pair programmer here, not an autopilot.
