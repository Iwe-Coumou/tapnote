import messageTemplate from "./message.html"

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
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

    await env.TAPNOTE_KV.put("queue:next", message);
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

  const raw = await env.TAPNOTE_KV.get("messages");
  const messages = raw ? JSON.parse(raw) : [];
  messages.push(message);
  await env.TAPNOTE_KV.put("messages", JSON.stringify(messages));

  return new Response("Added", { status: 200 });
}


function isAuthorized(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.ADMIN_SECRET}`;
  return safeEqual(authHeader, expected);
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

        return new Response("Not found", { status: 404 });
    },
};

async function pickMessage(env) {
    const queued = await env.TAPNOTE_KV.get("queue:next");
    if (queued !== null) {
        await env.TAPNOTE_KV.delete("queue:next");
        return queued;
    }

    const raw = await env.TAPNOTE_KV.get("messages");
    if (!raw) {
        return "No messages configured yet.";
    }

    const messages = JSON.parse(raw)
    const index = Math.floor(Math.random() * messages.length);
    return messages[index];
}

function renderMessagePage(message) {
    const safeMessageJson = JSON.stringify(message).replace(/</g, "\\u003c");
    const html = messageTemplate.replace("__MESSAGE_JSON__", () => safeMessageJson);

    return new Response(html, {
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
        return new Response("Invalid or already-used tag link", { status: 403 });
    }

    const message = await pickMessage(env);
    return renderMessagePage(message);
}