import messageTemplate from "./message.html"

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/message") {
            return handleMessage(env);
        }

        return new Response("Not found", { status: 404 });
    },
};

async function pickMessage(env) {
    const raw = await env.TAPNOTE_KV.get("messages");
    if (!raw) {
        return "No messsages configured yet.";
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

async function handleMessage(env) {
    const message = await pickMessage(env);
    return renderMessagePage(message);
}