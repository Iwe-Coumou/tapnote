import messageTemplate from "./message.html"
import errorTemplate from "./error.html"
import pageStyles from "./style.css"
// Single source of truth for the version in the page footer — bumping
// package.json is enough, there's no second place to remember.
import { version as appVersion } from "../package.json"

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

async function readQueue(env) {
    const raw = await env.TAPNOTE_KV.get("queue");
    return raw ? JSON.parse(raw) : [];
}

async function writeQueue(env, queue) {
    await env.TAPNOTE_KV.put("queue", JSON.stringify(queue));
}

async function handleQueue(request, env) {
    if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response("Invalid JSON body", { status: 400 });
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
        return new Response("Missing `message` field", { status: 400 });
    }

    const queue = await readQueue(env);
    queue.push(message);
    await writeQueue(env, queue);

    return new Response("Queued", { status: 200 });
}

async function handleAddMessage(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return new Response("Missing `message` field", { status: 400 });
  }

  const messages = await readMessages(env);
  messages.push(message);
  await env.TAPNOTE_KV.put("messages", JSON.stringify(messages));

  return new Response("Added", { status: 200 });
}


function isAuthorized(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.ADMIN_SECRET}`;
  return safeEqual(authHeader, expected);
}

async function readMessages(env) {
  const raw = await env.TAPNOTE_KV.get("messages");
  return raw ? JSON.parse(raw) : [];
}

async function handleListMessages(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const messages = await readMessages(env);
  return new Response(JSON.stringify(messages), {
    headers: { "content-type": "application/json" },
  });
}

async function handleReplaceMessages(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const isValid = Array.isArray(body.messages) && body.messages.every((m) => typeof m === "string");
  if (!isValid) {
    return new Response("`messages` must be an array of strings", { status: 400 });
  }

  await env.TAPNOTE_KV.put("messages", JSON.stringify(body.messages));
  return new Response("Replaced", { status: 200 });
}

async function handleDeleteMessage(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const messages = await readMessages(env);
  const index = typeof body.index === "number" ? body.index : messages.indexOf(body.message);

  if (index < 0 || index >= messages.length) {
    return new Response("Message not found", { status: 404 });
  }

  messages.splice(index, 1);
  await env.TAPNOTE_KV.put("messages", JSON.stringify(messages));
  return new Response("Deleted", { status: 200 });
}

const MAX_REPLY_LENGTH = 300;

async function readReplies(env) {
  const raw = await env.TAPNOTE_KV.get("replies");
  return raw ? JSON.parse(raw) : [];
}

// POST /reply is deliberately unauthenticated — same security posture as
// GET /message itself. Whoever has the tapped link can reply, same as
// whoever has the link can view the message; there's no separate secret
// for the recipient.
async function handleReply(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return new Response("Missing `text` field", { status: 400 });
  }
  if (text.length > MAX_REPLY_LENGTH) {
    return new Response(`Reply too long (max ${MAX_REPLY_LENGTH} characters)`, { status: 400 });
  }

  const repliedTo = typeof body.repliedTo === "string" ? body.repliedTo : null;

  const replies = await readReplies(env);
  replies.push({
    text,
    repliedTo,
    timestamp: new Date().toISOString(),
  });
  await env.TAPNOTE_KV.put("replies", JSON.stringify(replies));

  return new Response("Thanks!", { status: 200 });
}

// GET /replies is view-once: reading them clears them. There's no separate
// delete endpoint — viewing *is* the consuming action, same as GET /message
// already destructively pops the queue. Use GET /replies/count for a safe,
// non-destructive peek at how many are waiting.
async function handleListReplies(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const replies = await readReplies(env);
  await env.TAPNOTE_KV.delete("replies");
  return new Response(JSON.stringify(replies), {
    headers: { "content-type": "application/json" },
  });
}

async function handleCountReplies(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const replies = await readReplies(env);
  return new Response(JSON.stringify({ count: replies.length }), {
    headers: { "content-type": "application/json" },
  });
}

async function readSongs(env) {
  const raw = await env.TAPNOTE_KV.get("songs");
  return raw ? JSON.parse(raw) : [];
}

// Deliberately not calling the Spotify API — as of Feb 2026 that requires
// the developer account to hold an active Premium subscription, and is
// being restricted for exactly this kind of catalog read anyway. Instead
// songs are just a curated list of track links you add by hand (grabbed
// from Spotify's own Share > Copy Link), same pattern as the message pool.
function isValidSpotifyTrackUrl(url) {
  return typeof url === "string" && /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+/.test(url);
}

async function handleAddSong(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const trackUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!isValidSpotifyTrackUrl(trackUrl)) {
    return new Response("`url` must be a Spotify track link (https://open.spotify.com/track/...)", { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";

  const songs = await readSongs(env);
  songs.push({ url: trackUrl, title: title || null });
  await env.TAPNOTE_KV.put("songs", JSON.stringify(songs));

  return new Response("Added", { status: 200 });
}

async function handleListSongs(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const songs = await readSongs(env);
  return new Response(JSON.stringify(songs), {
    headers: { "content-type": "application/json" },
  });
}

async function handleReplaceSongs(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const isValid = Array.isArray(body.songs) && body.songs.every(
    (s) => s && isValidSpotifyTrackUrl(s.url) && (s.title == null || typeof s.title === "string")
  );
  if (!isValid) {
    return new Response("`songs` must be an array of { url, title? }", { status: 400 });
  }

  const normalized = body.songs.map((s) => ({ url: s.url, title: s.title || null }));
  await env.TAPNOTE_KV.put("songs", JSON.stringify(normalized));
  return new Response("Replaced", { status: 200 });
}

async function handleDeleteSong(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const songs = await readSongs(env);
  const index = typeof body.index === "number" ? body.index : songs.findIndex((s) => s.url === body.url);

  if (index < 0 || index >= songs.length) {
    return new Response("Song not found", { status: 404 });
  }

  songs.splice(index, 1);
  await env.TAPNOTE_KV.put("songs", JSON.stringify(songs));
  return new Response("Deleted", { status: 200 });
}

async function pickSong(env) {
  const songs = await readSongs(env);
  if (songs.length === 0) return null;
  return songs[Math.floor(Math.random() * songs.length)];
}

async function handleGetQueue(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const queue = await readQueue(env);
  return new Response(JSON.stringify({ queue }), {
    headers: { "content-type": "application/json" },
  });
}

// DELETE /queue with no body (or a body without "index") clears the whole
// queue. DELETE /queue with { "index": n } removes just that one entry.
async function handleDeleteQueue(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // No body (or invalid JSON) — treated as "clear everything" below.
  }

  if (typeof body.index === "number") {
    const queue = await readQueue(env);
    if (body.index < 0 || body.index >= queue.length) {
      return new Response("Queue item not found", { status: 404 });
    }
    queue.splice(body.index, 1);
    await writeQueue(env, queue);
    return new Response("Removed", { status: 200 });
  }

  await env.TAPNOTE_KV.delete("queue");
  return new Response("Cleared", { status: 200 });
}


export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/message") {
            return handleMessage(request, env);
        }

        if (request.method === "POST" && url.pathname === "/queue") {
            return handleQueue(request, env);
        }

        if (request.method === "POST" && url.pathname === "/messages") {
            return handleAddMessage(request, env);
        }

        if (request.method === "GET" && url.pathname === "/messages") {
            return handleListMessages(request, env);
        }

        if (request.method === "PUT" && url.pathname === "/messages") {
            return handleReplaceMessages(request, env);
        }

        if (request.method === "DELETE" && url.pathname === "/messages") {
            return handleDeleteMessage(request, env);
        }

        if (request.method === "GET" && url.pathname === "/queue") {
            return handleGetQueue(request, env);
        }

        if (request.method === "DELETE" && url.pathname === "/queue") {
            return handleDeleteQueue(request, env);
        }

        if (request.method === "POST" && url.pathname === "/reply") {
            return handleReply(request, env);
        }

        if (request.method === "GET" && url.pathname === "/replies") {
            return handleListReplies(request, env);
        }

        if (request.method === "GET" && url.pathname === "/replies/count") {
            return handleCountReplies(request, env);
        }

        if (request.method === "POST" && url.pathname === "/songs") {
            return handleAddSong(request, env);
        }

        if (request.method === "GET" && url.pathname === "/songs") {
            return handleListSongs(request, env);
        }

        if (request.method === "PUT" && url.pathname === "/songs") {
            return handleReplaceSongs(request, env);
        }

        if (request.method === "DELETE" && url.pathname === "/songs") {
            return handleDeleteSong(request, env);
        }

        return renderErrorPage(request, "There's nothing here — check the link?", 404);
    },
};

async function pickMessage(env) {
    const queue = await readQueue(env);
    if (queue.length > 0) {
        const [next, ...rest] = queue;
        await writeQueue(env, rest);
        return next;
    }

    const messages = await readMessages(env);
    if (messages.length === 0) {
        return "No messages configured yet.";
    }

    const index = Math.floor(Math.random() * messages.length);
    return messages[index];
}

function renderMessagePage(message, song) {
    const safeMessageJson = JSON.stringify(message).replace(/</g, "\\u003c");
    const safeSongJson = JSON.stringify(song).replace(/</g, "\\u003c");
    const html = messageTemplate
        .replace("__MESSAGE_JSON__", () => safeMessageJson)
        .replace("__SONG_JSON__", () => safeSongJson)
        .replace("__VERSION__", () => appVersion)
        .replace("/*__STYLES__*/", () => pageStyles);

    return new Response(html, {
        headers: { "content-type": "text/html; charset=UTF-8" },
    });
}

// Styled fallback for the two error states reachable through /message itself
// (an invalid/replayed tag link, or something unexpected breaking) — the
// only error responses she could ever actually see, so they get the same
// letter styling instead of plain browser error text. Admin-route errors
// (401/404 on the CLI-facing endpoints) stay plain text on purpose.
//
// Only actually renders HTML for requests that look like a browser (Accept
// includes text/html, e.g. Safari) — anything else, like tapnoted's HTTP
// client (which sends no Accept header at all), gets plain text instead.
// Without this, a 404 from a stale/undeployed CLI would dump a full HTML
// document into the terminal.
function renderErrorPage(request, message, status) {
    const accept = request.headers.get("Accept") || "";
    if (!accept.includes("text/html")) {
        return new Response(message, { status });
    }

    const safeMessageJson = JSON.stringify(message).replace(/</g, "\\u003c");
    const html = errorTemplate
        .replace("__MESSAGE_JSON__", () => safeMessageJson)
        .replace("__VERSION__", () => appVersion)
        .replace("/*__STYLES__*/", () => pageStyles);

    return new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=UTF-8" },
    });
}

// --- NTAG 424 DNA "SUN" (Secure Unique NFC) verification -------------------
// Each tap of an NTAG 424 DNA appends two params the chip generates itself:
//   /message?picc_data=7EA2F1...&cmac=94ED3B...
// `picc_data` is the tag UID + a per-tap read counter, AES-encrypted by the
// chip with a key only it and this Worker know. `cmac` is a MAC over that
// data, proving the URL wasn't forged or hand-edited. The counter is what
// makes a pasted/screenshotted link useless: it only ever goes up, and we
// refuse any value we've already served.
//
// Keys come from Worker secrets, as raw AES-128 hex (32 hex chars):
//   TAG_META_KEY  decrypts picc_data   (the chip's SDMMetaReadKey)
//   TAG_MAC_KEY   derives the CMAC key (the chip's SDMFileReadKey)
//   TAG_AES_KEY   fallback used for both when the two above aren't set
// Optional:
//   TAG_UIDS                 comma-separated hex UID allowlist (default: any UID)
//   TAG_REPLAY_GRACE_SECONDS re-serving window for the same counter (default 120)
//
// With none of the keys configured, verification is disabled and every
// request passes — that's the plain-NFC-tag setup this started as. Setting
// TAG_AES_KEY (or the split pair) is what switches enforcement on.

const ZERO_IV = new Uint8Array(16);
const DEFAULT_REPLAY_GRACE_SECONDS = 120;

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function importTagKey(hex) {
  const raw = hexToBytes(hex);
  if (!raw || raw.length !== 16) return null;
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

// WebCrypto has no raw AES-ECB. AES-CBC with a zero IV over a single block is
// exactly ECB for that block; CBC always appends a PKCS#7 padding block on
// encrypt, so we keep the first 16 bytes and drop it.
async function aesEncryptBlock(key, block) {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, block));
  return out.slice(0, 16);
}

// CBC-MAC: the last real ciphertext block of a zero-IV CBC encryption, again
// discarding the padding block WebCrypto tacks on. `data` must be a whole
// number of blocks.
async function aesCbcMac(key, data) {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, data));
  return out.slice(data.length - 16, data.length);
}

function shiftLeftOneBit(block) {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    out[i] = ((block[i] << 1) | carry) & 0xff;
    carry = (block[i] & 0x80) ? 1 : 0;
  }
  return { out, overflow: carry };
}

// AES-CMAC (RFC 4493). Needed because WebCrypto only ships HMAC, and the
// NTAG 424 signs with CMAC.
async function aesCmac(key, message) {
  const l = await aesEncryptBlock(key, new Uint8Array(16));

  const s1 = shiftLeftOneBit(l);
  const k1 = s1.out;
  if (s1.overflow) k1[15] ^= 0x87;

  const s2 = shiftLeftOneBit(k1);
  const k2 = s2.out;
  if (s2.overflow) k2[15] ^= 0x87;

  const blockCount = Math.max(1, Math.ceil(message.length / 16));
  const lastBlockIsComplete = message.length > 0 && message.length % 16 === 0;

  const padded = new Uint8Array(blockCount * 16);
  padded.set(message);
  if (!lastBlockIsComplete) padded[message.length] = 0x80;

  const subkey = lastBlockIsComplete ? k1 : k2;
  const lastOffset = (blockCount - 1) * 16;
  for (let i = 0; i < 16; i++) padded[lastOffset + i] ^= subkey[i];

  return aesCbcMac(key, padded);
}

// Single-block AES-CBC decrypt with a zero IV and no padding. WebCrypto
// insists on stripping PKCS#7, so we append a synthetic block engineered to
// decrypt to a full 16-byte padding block — it validates, gets stripped, and
// leaves exactly the real plaintext behind.
async function aesDecryptBlock(key, ciphertext) {
  const filler = new Uint8Array(16).fill(0x10);
  for (let i = 0; i < 16; i++) filler[i] ^= ciphertext[i];
  const tail = await aesEncryptBlock(key, filler);

  const buf = new Uint8Array(32);
  buf.set(ciphertext);
  buf.set(tail, 16);

  const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, buf));
  return out.slice(0, 16);
}

// Per-tap MAC session key, per NXP AN12196:
//   SV2 = 3Ch C3h 00h 01h 00h 80h || UID || SDMReadCtr   (exactly one block)
//   K_SesSDMFileReadMAC = CMAC(SDMFileReadKey, SV2)
async function deriveSessionMacKey(macKey, uid, counterBytes) {
  const sv2 = new Uint8Array(16);
  sv2.set([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]);
  sv2.set(uid, 6);
  sv2.set(counterBytes, 13);

  const raw = await aesCmac(macKey, sv2);
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

// The chip sends a truncated CMAC: the odd-indexed bytes of the full 16.
function truncateCmac(fullCmac) {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = fullCmac[i * 2 + 1];
  return out;
}

// What the chip actually signs is the literal URL text between
// SDMMACInputOffset and SDMMACOffset — so it depends on how the tag was
// programmed, and has to be read off the raw URL rather than assumed.
//
// With no mirrored file data the two offsets coincide and the signed message
// is empty. With custom data mirrored (an `enc=` param) the input runs from
// the start of that value up to the start of the cmac value, which means it
// includes the `&cmac=` separator sitting between them — easy to miss, and it
// silently breaks the MAC if you leave it out.
function sdmMacInput(rawUrl) {
  const cmacParam = rawUrl.search(/[?&]cmac=/);
  const encParam = rawUrl.search(/[?&]enc=/);
  if (cmacParam < 0 || encParam < 0) return new Uint8Array(0);

  const encValue = rawUrl.indexOf("=", encParam) + 1;
  const cmacValue = rawUrl.indexOf("=", cmacParam) + 1;
  if (encValue > cmacValue) return new Uint8Array(0);

  return new TextEncoder().encode(rawUrl.slice(encValue, cmacValue));
}

// Decides whether this counter may be served, and whether it's a new tap or a
// reload of one already answered. KV is eventually consistent, so two truly
// simultaneous requests could both read a stale value — for this use (one tag,
// one person tapping it) that's fine. A Durable Object per tag is the upgrade
// if strict same-request consistency ever matters.
//
// Returns { allowed, fresh, served }. `served` carries what the original tap
// was shown, so a refresh can redisplay that same letter instead of drawing a
// new one — a tap is meant to be worth exactly one message.
async function claimCounter(env, uidHex, counter) {
  const raw = await env.TAPNOTE_KV.get(`tag-counter:${uidHex}`);
  if (!raw) return { allowed: true, fresh: true };

  let seen;
  try {
    seen = JSON.parse(raw);
  } catch {
    seen = null;
  }
  if (!seen || typeof seen.ctr !== "number") return { allowed: true, fresh: true };

  if (counter < seen.ctr) return { allowed: false };
  if (counter > seen.ctr) return { allowed: true, fresh: true };

  // Same counter as last time: a reload of the page this tap already opened,
  // not a new tap. Allowed for a short window so a refresh (or Safari
  // re-requesting) doesn't hard-fail, but the window is measured from the
  // original tap and never slides forward.
  const graceMs = replayGraceSeconds(env) * 1000;
  const startedAt = typeof seen.ts === "number" ? seen.ts : 0;
  if (graceMs > 0 && Date.now() - startedAt <= graceMs) {
    return { allowed: true, fresh: false, served: seen.served ?? null };
  }
  return { allowed: false };
}

// Records what this tap was shown, so reloads inside the grace window replay it
// rather than consuming another queued message.
async function recordServed(env, uidHex, counter, served) {
  await env.TAPNOTE_KV.put(
    `tag-counter:${uidHex}`,
    JSON.stringify({ ctr: counter, ts: Date.now(), served })
  );
}

function replayGraceSeconds(env) {
  const configured = Number(env.TAG_REPLAY_GRACE_SECONDS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_REPLAY_GRACE_SECONDS;
}

function isAllowedUid(env, uidHex) {
  const allowlist = typeof env.TAG_UIDS === "string" ? env.TAG_UIDS.trim() : "";
  if (!allowlist) return true;
  return allowlist
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
    .includes(uidHex);
}

async function verifyTagAuth(request, env) {
  const metaKeyHex = env.TAG_META_KEY || env.TAG_AES_KEY;
  const macKeyHex = env.TAG_MAC_KEY || env.TAG_AES_KEY;

  // No keys configured — the plain-tag setup. Nothing to verify against.
  if (!metaKeyHex && !macKeyHex) return { valid: true };

  const url = new URL(request.url);
  const piccHex = url.searchParams.get("picc_data") || "";
  const cmacHex = url.searchParams.get("cmac") || "";

  const piccData = hexToBytes(piccHex);
  const providedCmac = hexToBytes(cmacHex);
  if (!piccData || piccData.length !== 16) return { valid: false, reason: "bad picc_data" };
  if (!providedCmac || providedCmac.length !== 8) return { valid: false, reason: "bad cmac" };

  try {
    const metaKey = await importTagKey(metaKeyHex);
    const macKey = await importTagKey(macKeyHex);
    if (!metaKey || !macKey) return { valid: false, reason: "tag key misconfigured" };

    const plain = await aesDecryptBlock(metaKey, piccData);

    // Byte 0 is the PICCDataTag: 0x80 = UID mirrored, 0x40 = read counter
    // mirrored, low nibble = UID length. Anything else means the chip isn't
    // configured the way this code expects.
    const piccDataTag = plain[0];
    const uidLength = piccDataTag & 0x0f;
    if ((piccDataTag & 0x80) === 0 || (piccDataTag & 0x40) === 0 || uidLength !== 7) {
      return { valid: false, reason: "unexpected PICC layout" };
    }

    const uid = plain.slice(1, 8);
    const counterBytes = plain.slice(8, 11);
    const counter = counterBytes[0] | (counterBytes[1] << 8) | (counterBytes[2] << 16);
    const uidHex = bytesToHex(uid);

    const sessionKey = await deriveSessionMacKey(macKey, uid, counterBytes);
    const expectedCmac = truncateCmac(await aesCmac(sessionKey, sdmMacInput(request.url)));

    if (!safeEqual(bytesToHex(expectedCmac), bytesToHex(providedCmac))) {
      return { valid: false, reason: "cmac mismatch" };
    }

    if (!isAllowedUid(env, uidHex)) {
      return { valid: false, reason: "unknown tag uid" };
    }

    const claim = await claimCounter(env, uidHex, counter);
    if (!claim.allowed) {
      return { valid: false, reason: "counter replay" };
    }

    return { valid: true, uid: uidHex, counter, fresh: claim.fresh, served: claim.served };
  } catch {
    return { valid: false, reason: "verification error" };
  }
}


async function handleMessage(request, env) {
    const authResult = await verifyTagAuth(request, env);

    // Only ever logged, never returned to the browser — `wrangler tail` is
    // the only way to tell a misconfigured tag from a genuine replay.
    if (!authResult.valid) {
        console.log(`tag auth REJECTED: ${authResult.reason}`);
        return renderErrorPage(request, "That link doesn't look right — try tapping the tag again?", 403);
    }
    console.log(
        authResult.uid
            ? `tag auth ok: uid=${authResult.uid} counter=${authResult.counter}`
            : "tag auth skipped: no key configured"
    );

    try {
        // A reload inside the grace window redisplays the letter that tap
        // already produced. Without this a refresh would pop another queued
        // message, so one tap could burn through the whole queue.
        if (authResult.served) {
            return renderMessagePage(authResult.served.message, authResult.served.song);
        }

        const message = await pickMessage(env);
        const song = await pickSong(env);
        if (authResult.uid) {
            await recordServed(env, authResult.uid, authResult.counter, { message, song });
        }
        return renderMessagePage(message, song);
    } catch {
        return renderErrorPage(request, "Something went wrong on this end — try tapping again in a moment.", 500);
    }
}