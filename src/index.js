import messageTemplate from "./message.html"
import errorTemplate from "./error.html"
import pageStyles from "./style.css"

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
        .replace("/*__STYLES__*/", () => pageStyles);

    return new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=UTF-8" },
    });
}

// --- NTAG 424 DNA "SUN" (Secure Unique NFC) verification -------------------
// Placeholder for now — the physical tag is currently a plain NFC tag with
// no chip-side crypto, so there is nothing to verify yet.
//
// Once upgraded to an NTAG 424 DNA, each tap will append two extra query
// params to the URL, e.g.:
//   /message?picc_data=7EA2F1...&cmac=94ED3B...
// `picc_data` is the tag's UID + a per-tap read counter, AES-encrypted by
// the chip with a key only it and this Worker know. `cmac` is a checksum
// over that data, proving the URL wasn't forged or edited by hand.
//
// This function will eventually:
//   1. Decrypt `picc_data` with `env.TAG_AES_KEY` (crypto.subtle, AES-CBC)
//      to recover the tag UID and current read counter.
//   2. Recompute the CMAC and compare it to the `cmac` param (safeEqual-style)
//      to confirm the URL is genuine.
//   3. Look up the last-seen counter for that UID — KV key like
//      `tag-counter:<uid>`, or a Durable Object per tag if strict
//      same-request consistency is needed — and reject if this counter has
//      already been used or is lower than the stored one. That's the
//      replay/shared-link protection: a screenshotted old URL will always
//      carry a stale counter.
//   4. Store the new counter value before returning valid.
function verifyTagAuth(request, env) {
  return { valid: true }; // no-op until the tag hardware is upgraded
}


async function handleMessage(request, env) {
    const authResult = verifyTagAuth(request, env);
    if (!authResult.valid) {
        return renderErrorPage(request, "That link doesn't look right — try tapping the tag again?", 403);
    }

    try {
        const message = await pickMessage(env);
        const song = await pickSong(env);
        return renderMessagePage(message, song);
    } catch {
        return renderErrorPage(request, "Something went wrong on this end — try tapping again in a moment.", 500);
    }
}