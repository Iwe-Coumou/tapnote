# tapnote

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
| GET    | `/message`  | none   | Returns the styled HTML page with one message (queued message if one is waiting, otherwise random from the pool). |
| POST   | `/queue`    | secret | Body `{ "message": "..." }`. Appends to the queue — taps serve queued messages in order (FIFO) before falling back to random once the queue is empty. |
| GET    | `/queue`    | secret | Returns `{ "queue": [...] }` — the full ordered list of upcoming queued messages. |
| DELETE | `/queue`    | secret | With no body, clears the entire queue. With `{ "index": 1 }`, removes just that one queued item. |
| POST   | `/messages` | secret | Body `{ "message": "..." }`. Appends a message to the random-pick pool permanently. |
| GET    | `/messages` | secret | Returns the full pool as a JSON array. |
| PUT    | `/messages` | secret | Body `{ "messages": [...] }`. Replaces the whole pool at once — pass an empty array to reset it. |
| DELETE | `/messages` | secret | Body `{ "index": 2 }` or `{ "message": "exact text" }`. Removes one message from the pool. |
| POST   | `/reply`    | none   | Body `{ "text": "...", "repliedTo": "..." }`. Public — same posture as `/message` itself, no secret. Max 300 characters. |
| GET    | `/replies`  | secret | Returns all replies as a JSON array, each `{ text, repliedTo, timestamp }`. |
| DELETE | `/replies`  | secret | With no body, clears all replies. With `{ "index": 1 }`, removes just that one. |
| POST   | `/songs`    | secret | Body `{ "url": "https://open.spotify.com/track/...", "title": "..." }` (`title` optional). Appends a song to the pool. |
| GET    | `/songs`    | secret | Returns the full song pool as a JSON array of `{ url, title }`. |
| PUT    | `/songs`    | secret | Body `{ "songs": [...] }`. Replaces the whole pool at once — pass an empty array to reset it. |
| DELETE | `/songs`    | secret | Body `{ "index": 0 }` or `{ "url": "..." }`. Removes one song from the pool. |

Authenticated routes expect an `Authorization: Bearer <ADMIN_SECRET>` header.

Songs are a plain curated list, not a live Spotify playlist lookup — Spotify's Web API now requires the developer account to hold an active Premium subscription for even basic catalog reads, so `/message` never calls out to Spotify at all. Add track links by hand (Spotify app → Share → Copy Link) via `/songs` or the CLI.

## Project structure

```
src/
  index.js       Worker entry point: routing, KV access, auth
  message.html   Page template (placeholders: __MESSAGE_JSON__, __STYLES__)
  style.css      Page styles, spliced into the template at request time
wrangler.toml    Cloudflare config: Worker name, KV binding, module rules
messages.json    Local staging file used to seed KV (gitignored — never committed)
.dev.vars        Local secret values for `wrangler dev` (gitignored — never committed)
index.html       Leftover from an earlier prototype, no longer used by the Worker
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

## Planned: NTAG 424 DNA verification

The tag currently in use is a plain NFC tag — the URL it opens has no
built-in authenticity check. `verifyTagAuth()` in `src/index.js` is a
deliberate no-op placeholder for now, with comments describing what it will
do once the tag is upgraded to an NTAG 424 DNA chip: verify a per-tap
signature and reject any previously-seen counter value, to prevent a
tapped/shared link from being reused.

## A note on how this was built

The idea, design, and product decisions behind this project are mine — I
built it as a personal gift and used it as a chance to learn Cloudflare
Workers. I worked through the implementation with AI assistance (Claude):
it explained the concepts, but I wrote and tested the code myself as I went,
reviewed and understood each piece before moving to the next, and made the
calls on architecture, security, and design decisions throughout. AI acted
as a tutor and pair programmer here, not an autopilot.
