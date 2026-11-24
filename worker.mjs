/*
 * Cloudflare Workers setup
 * 1. Create a Worker called n on the Workers Free plan.
 * 2. Under Storage & databases > KV, create a namespace called car-note-log.
 * 3. In the Worker, add a KV namespace binding named LOG_KV and point it at
 *    car-note-log. In Settings > Variables and Secrets, add a secret named
 *    NOTE_KEY. Use a random value of at least 32 characters (URL-safe).
 * 4. Replace the starter script with this file and deploy. Use the Worker URL
 *    displayed in the dashboard in place of BASE below.
 *
 * Save a note: BASE/?key=YOUR_KEY&t=Pick%20up%20coffee
 * Read note IDs and text: BASE/?key=YOUR_KEY
 * Read timestamped notes: BASE/log?key=YOUR_KEY
 * Month index: GET BASE/index (or BASE/?format=json)
 * Month notes: GET BASE/YYYY/MM
 * Edit a note: POST BASE/update?id=ID&text=REPLACEMENT (adds updated)
 * Preview trim: GET BASE/trim?days=30
 * Apply trim: POST BASE/trim?days=30 with {"confirm":true}
 * Management routes require the note key, preferably as a Bearer header.
 * Car browser: Open BASE/pair once and enter NOTE_KEY. Then open
 *              BASE/submit?note=Pick%20up%20coffee&topic=Errands
 * Set CAR_SESSION_SECRET to a separate random secret to enable pairing.
 * JSON POST:   BASE/ with Authorization: Bearer YOUR_KEY and {"note":"Pick up coffee"}
 * Apple Notes shortcut: GET BASE/note?key=YOUR_KEY&format=notes&text=ENCODED_NOTE
 * JSON save responses also include a receipt with the note text and ID.
 *
 * Encode note text using URLSearchParams or encodeURIComponent. Use ordinary
 * notes only. Both the note and the access key can appear in browser history.
 * Keep the keyed URLs private. Only open a save link when you intend to write
 * a note. Opening it again saves another entry.
 */

/**
 * @typedef {object} WorkerEnv
 * @property {import("@cloudflare/workers-types").KVNamespace} LOG_KV
 * @property {string} NOTE_KEY
 * @property {string} CAR_SESSION_SECRET
 */

const NOTE_PREFIX = "note:";
const NOTE_KEY_TIME_BASE = 9_999_999_999_999;
const MAX_GET_NOTE_BYTES = 2_000;
const MAX_POST_NOTE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const PAGE_SIZE = 100;
const MAX_TOPIC_BYTES = 120;
const MAX_TRIM_BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const CAR_COOKIE = "__Host-car-notes";
const CAR_SESSION_SECONDS = 90 * 24 * 60 * 60;

function reply(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      ...headers,
    },
  });
}

function jsonReply(value, status = 200) {
  return reply(JSON.stringify(value), status, { "Content-Type": "application/json; charset=utf-8" });
}

function accessKey(request, url) {
  return request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1]
    ?? url.searchParams.get("key");
}

function publicNote(entry) {
  return {
    id: entry.id,
    text: entry.text,
    timestamp: entry.time,
    ...(entry.updated ? { updated: entry.updated } : {}),
    ...(entry.topic ? { topic: entry.topic } : {}),
  };
}

function storedNote(entry, key) {
  const id = key.slice(key.lastIndexOf(":") + 1);
  const order = /^note:(\d{13}):/.exec(key)?.[1];
  if (!entry.updated && order && Number.isFinite(Date.parse(entry.time))) {
    // Older edits replaced the displayed time, but the key still holds creation time.
    const created = new Date(NOTE_KEY_TIME_BASE - Number(order)).toISOString();
    if (created !== entry.time) return { ...entry, key, id, time: created, updated: entry.time };
  }
  return { ...entry, key, id };
}

async function listNotes(kv) {
  const notes = [];
  let cursor;

  do {
    const page = await kv.list({ prefix: NOTE_PREFIX, limit: PAGE_SIZE, cursor });
    const keys = page.keys.map(({ name }) => name);
    if (keys.length > 0) {
      const entries = await kv.get(keys, "json");
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry) notes.push(storedNote(entry, key));
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return notes.reverse().sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

async function readNotes(kv, { includeIds = false } = {}) {
  const notes = await listNotes(kv);
  // Newest first, matching the HTML view.
  const ordered = [...notes].reverse();

  const lines = ordered.map(entry => {
    if (includeIds) return `${entry.id}: ${entry.text}`;
    const prefix = entry.time ? `[${entry.time}] ` : "";
    const topic = entry.topic ? `[${entry.topic}] ` : "";
    return prefix + topic + entry.text;
  });

  return reply(lines.length ? lines.join("\n") + "\n" : "(empty)");
}

async function readMonthIndex(kv) {
  const months = {};
  for (const note of await listNotes(kv)) {
    if (!note.time) continue;
    const month = note.time.slice(0, 7);
    months[month] = (months[month] ?? 0) + 1;
  }
  return jsonReply(months);
}

function noteTextError(note, maxBytes) {
  if (typeof note !== "string" || !note.trim()) return reply("Provide a non-empty note.", 400);
  if (new TextEncoder().encode(note).byteLength > maxBytes) {
    return reply(`Note is too long. Limit: ${maxBytes} bytes.`, 413);
  }
  return null;
}

async function updateNote(kv, url) {
  const id = url.searchParams.get("id");
  const text = url.searchParams.get("text");
  if (!id) return reply("Provide a note id.", 400);
  const error = noteTextError(text, MAX_POST_NOTE_BYTES);
  if (error) return error;

  const entry = (await listNotes(kv)).find(note => note.id === id);
  if (!entry) return reply("Note not found.", 404);

  const { key, ...stored } = entry;
  const edited = { ...stored, text, updated: new Date().toISOString() };
  await kv.put(key, JSON.stringify(edited));
  return jsonReply(publicNote(edited));
}

async function trimNotes(request, kv, url) {
  const rawDays = url.searchParams.get("days") ?? "30";
  const days = Number(rawDays);
  if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(days) || days < 1 || days > 36500) {
    return reply("Days must be a whole number from 1 to 36500.", 400);
  }

  if (request.method === "POST") {
    const body = await readBody(request);
    let confirmed = false;
    if (body !== null) {
      try {
        confirmed = JSON.parse(body)?.confirm === true;
      } catch {
        return reply("Invalid JSON.", 400);
      }
    }
    if (!confirmed) return reply('To apply the trim, send {"confirm":true}.', 400);
  }

  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const activityTime = note => note.updated ?? note.time;
  const candidates = (await listNotes(kv))
    .filter(note => activityTime(note) && activityTime(note) < cutoff)
    .sort((a, b) => activityTime(a).localeCompare(activityTime(b)));
  if (request.method === "GET") return jsonReply({ days, cutoff, matching: candidates.length });

  const batch = candidates.slice(0, MAX_TRIM_BATCH);
  let removed = 0;
  for (let start = 0; start < batch.length; start += 6) {
    const results = await Promise.allSettled(batch.slice(start, start + 6).map(note => kv.delete(note.key)));
    removed += results.filter(result => result.status === "fulfilled").length;
  }
  const failed = batch.length - removed;
  return jsonReply({ days, cutoff, removed, failed, remaining: candidates.length - removed }, failed ? 503 : 200);
}

async function sessionSigner(env) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.CAR_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

function sessionMessage(expires, env) {
  return new TextEncoder().encode(`car-note-save:${expires}:${env.NOTE_KEY}`);
}

async function hasCarSession(request, env) {
  if (!env.CAR_SESSION_SECRET || !env.NOTE_KEY) return false;
  const cookies = request.headers.get("cookie")?.split(/;\s*/) ?? [];
  const value = cookies.find(cookie => cookie.startsWith(`${CAR_COOKIE}=`));
  const match = value?.slice(CAR_COOKIE.length + 1).match(/^(\d{10,12})\.([0-9a-f]{64})$/);
  if (!match || Number(match[1]) <= Date.now() / 1000) return false;
  const [, expires, signature] = match;
  const bytes = Uint8Array.from(signature.match(/../g), hex => parseInt(hex, 16));
  return crypto.subtle.verify("HMAC", await sessionSigner(env), bytes, sessionMessage(expires, env));
}

async function isAuthorized(request, url, env) {
  const key = accessKey(request, url);
  if (key && key === env.NOTE_KEY) return true;
  return await hasCarSession(request, env);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readNotesHtml(kv, { limit = 20 } = {}) {
  const notes = await listNotes(kv);
  const recent = notes.slice(-limit).reverse();
  const items = recent.map(note => {
    const time = note.time ? note.time.slice(0, 16).replace("T", " ") : "";
    const topic = note.topic ? `<p class="topic">${escapeHtml(note.topic)}</p>` : "";
    const timestamp = time
      ? `<time datetime="${escapeHtml(note.time)}">${escapeHtml(time)}</time>`
      : "";
    return `<article><h2>${escapeHtml(note.text)}</h2>${topic}${timestamp}<p class="id">ID: ${escapeHtml(note.id)}</p></article>`;
  }).join("\n");

  const body = recent.length ? items : "<p>(no notes yet)</p>";
  return reply(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">\n  <title>Recent notes</title>
  <style>
    body { max-width: 48rem; margin: 2rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; }
    article { margin: 1rem 0; padding: 1rem; border: 1px solid #bbb; border-radius: .75rem; overflow-wrap: anywhere; }
    h2 { margin: 0 0 .5rem; font-size: 1.1rem; font-weight: 500; white-space: pre-wrap; }
    time, .topic, .id { color: #555; font-size: .9rem; }
    .topic { margin: 0 0 .25rem; }
    .id { margin: .25rem 0 0; }
  </style>
</head>
<body>
  <h1>Recent notes</h1>
  <main>${body}</main>
</body>
</html>`, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
}

function pairPage() {
  return reply(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair car browser</title>
<h1>Pair car browser</h1>
<form method="post" action="/pair">
  <label>Note key <input type="password" name="key" required></label>
  <button type="submit">Pair browser</button>
</form>
</html>`, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

async function pairBrowser(request, url, env) {
  if (request.headers.get("origin") !== url.origin) return reply("Forbidden.", 403);
  if (!env.NOTE_KEY || !env.CAR_SESSION_SECRET) return reply("Pairing is unavailable.", 503);
  const body = await readBody(request);
  if (body === null) return reply("Request body is too large.", 413);
  if (new URLSearchParams(body).get("key") !== env.NOTE_KEY) {
    return reply("Incorrect note key.", 401);
  }
  const expires = Math.floor(Date.now() / 1000) + CAR_SESSION_SECONDS;
  const signature = await crypto.subtle.sign(
    "HMAC", await sessionSigner(env), sessionMessage(expires, env),
  );
  const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  return reply("Paired. This browser can now save notes.", 200, {
    "Set-Cookie": `${CAR_COOKIE}=${expires}.${hex}; Path=/; Max-Age=${CAR_SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict`,
  });
}

function submitPage() {
  const nonce = crypto.randomUUID();
  return reply(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Save note</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #eee; }
  main { width: min(88vw, 42rem); padding: 1rem 0; text-align: center; overflow-wrap: anywhere; }
  h1 { margin: 0 0 1rem; font-size: clamp(2rem, 7vw, 3rem); }
  #note { font-size: 1.25rem; line-height: 1.45; white-space: pre-wrap; }
  #topic { width: fit-content; margin: 0 auto 1rem; padding: .35rem .75rem; border-radius: 1rem; background: #292929; }
  #error { color: #ffb6aa; }
</style>
<main>
  <h1 id="status" role="status">Saving…</h1>
  <p id="topic" hidden></p>
  <p id="note"></p>
  <p id="error" hidden></p>
  <noscript>JavaScript is needed to submit this note.</noscript>
</main>
<script nonce="${nonce}">
  const params = new URLSearchParams(location.search);
  const note = params.get("note");
  const topic = params.get("topic")?.trim();
  const key = params.get("key");
  const status = document.getElementById("status");

  async function submit() {
    if (!note?.trim()) {
      status.textContent = "No note";
      return;
    }

    document.getElementById("note").textContent = note;
    if (topic) {
      const label = document.getElementById("topic");
      label.textContent = topic;
      label.hidden = false;
    }

    const fields = new URLSearchParams({ note });
    if (topic) fields.set("topic", topic);
    if (key) fields.set("key", key);

    try {
      history.replaceState(null, "", location.pathname);
      const response = await fetch("/", { method: "POST", body: fields, credentials: "same-origin" });
      const message = await response.text();
      if (!response.ok || message !== "saved") {
        throw new Error(response.ok ? "The server did not confirm the save." : message || "The request failed.");
      }
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = "Save not confirmed";
      const detail = document.getElementById("error");
      detail.textContent = error.message;
      detail.hidden = false;
    }
  }
  submit();
</script>
</html>`, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

async function readBody(request) {
  const bytes = new Uint8Array(MAX_REQUEST_BYTES);
  const reader = request.body?.getReader();
  if (!reader) return "";

  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return new TextDecoder().decode(bytes.subarray(0, size));
    if (size + value.byteLength > bytes.length) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, size);
    size += value.byteLength;
  }
}

async function saveNote(kv, note, maxBytes, topic = "", responseFormat = "saved") {
  const error = noteTextError(note, maxBytes);
  if (error) return error;

  if (typeof topic !== "string" || /[\r\n]/.test(topic) ||
      new TextEncoder().encode(topic).byteLength > MAX_TOPIC_BYTES) {
    return reply(`Use a single-line topic of up to ${MAX_TOPIC_BYTES} bytes.`, 400);
  }
  const label = topic.trim();

  const now = new Date();
  // KV lists keys alphabetically. Reverse the timestamp for newest first.
  const order = String(NOTE_KEY_TIME_BASE - now.getTime()).padStart(13, "0");
  const id = crypto.randomUUID();
  const entryKey = `${NOTE_PREFIX}${order}:${id}`;
  const entry = { id, time: now.toISOString(), text: note, ...(label ? { topic: label } : {}) };
  await kv.put(entryKey, JSON.stringify(entry));
  if (responseFormat === "saved") return reply("saved");
  const receipt = `${note}\nID: ${id}`;
  if (responseFormat === "notes") return reply(receipt, 201);
  return jsonReply({ ...publicNote(entry), receipt }, 201);
}

async function postNote(request, url, env, responseFormat) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const form = type === "application/x-www-form-urlencoded";
  const plainText = type === "text/plain";
  if (!form && !plainText && type !== "application/json") {
    return reply("Use application/json, text/plain, or application/x-www-form-urlencoded.", 415);
  }

  const key = accessKey(request, url);
  if (!env.NOTE_KEY || (!form && key !== env.NOTE_KEY)) return reply("unauthorized", 401);

  const body = await readBody(request);
  if (body === null) return reply("Request body is too large.", 413);
  const topic = url.searchParams.get("topic") ?? "";

  if (form) {
    const fields = new URLSearchParams(body);
    const formKey = key ?? fields.get("key");
    const paired = url.pathname === "/" && request.headers.get("origin") === url.origin
      && await hasCarSession(request, env);
    if (formKey !== env.NOTE_KEY && !paired) return reply("unauthorized", 401);
    return await saveNote(env.LOG_KV, fields.get("note"), MAX_POST_NOTE_BYTES, fields.get("topic") ?? topic, responseFormat);
  }

  if (plainText) return await saveNote(env.LOG_KV, body, MAX_POST_NOTE_BYTES, topic, responseFormat);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return reply("Invalid JSON.", 400);
  }
  return await saveNote(env.LOG_KV, payload?.note ?? payload?.text, MAX_POST_NOTE_BYTES, payload?.topic ?? topic, responseFormat);
}

/** @type {import("@cloudflare/workers-types").ExportedHandler<WorkerEnv>} */
const worker = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const keyAuthorized = Boolean(env.NOTE_KEY && accessKey(request, url) === env.NOTE_KEY);
    const wantsJson = url.searchParams.get("format") === "json"
      || (request.headers.get("accept") ?? "").includes("application/json");
    try {
      if (path === "/pair") {
        if (method === "GET") return pairPage();
        if (method === "POST") return await pairBrowser(request, url, env);
        return reply("Use GET or POST.", 405, { Allow: "GET, POST" });
      }
      if (path === "/submit") {
        if (method !== "GET") return reply("Use GET.", 405, { Allow: "GET" });
        if (keyAuthorized || await hasCarSession(request, env)) return submitPage();
        return reply("Pair this car browser first at /pair.", 401);
      }

      if (path === "/" && method === "POST") return await postNote(request, url, env, wantsJson ? "json" : "saved");

      if (path === "/update") {
        if (!keyAuthorized) return reply("unauthorized", 401);
        if (method !== "POST" && method !== "PATCH") return reply("Use POST or PATCH.", 405, { Allow: "POST, PATCH" });
        return await updateNote(env.LOG_KV, url);
      }
      if (path === "/delete") {
        if (!keyAuthorized) return reply("unauthorized", 401);
        if (method !== "POST") return reply("Use POST.", 405, { Allow: "POST" });
        const body = await readBody(request);
        if (body === null) return reply("Request body is too large.", 413);

        let data;
        try {
          data = JSON.parse(body);
        } catch {
          return reply("Invalid JSON.", 400);
        }
        if (data?.confirm !== true) return reply('To delete, send {"confirm":true}.', 400);
        const id = data?.id;
        if (typeof id !== "string" || !id.trim()) return reply("Provide a note ID.", 400);

        const note = (await listNotes(env.LOG_KV)).find(entry => entry.id === id.trim());
        if (!note) return reply("Note not found.", 404);
        await env.LOG_KV.delete(note.key);
        return jsonReply({ deleted: true, id: note.id, text: note.text });
      }

      if (path === "/trim") {
        if (!keyAuthorized) return reply("unauthorized", 401);
        if (method !== "GET" && method !== "POST") return reply("Use GET or POST.", 405, { Allow: "GET, POST" });
        return await trimNotes(request, env.LOG_KV, url);
      }

      const month = path.match(/^\/(\d{4})\/(0[1-9]|1[0-2])$/);
      const isReadRoute = method === "GET" && (
        path === "/ids" || path === "/log" || path === "/index" || Boolean(month) ||
        (path === "/" && !url.searchParams.has("t") && !url.searchParams.has("text"))
      );
      if (isReadRoute && !await isAuthorized(request, url, env)) {
        return reply("unauthorized", 401);
      }

      if (path === "/ids") {
        if (method !== "GET") return reply("Use GET.", 405, { Allow: "GET" });
        const ids = (await listNotes(env.LOG_KV)).map(note => note.id);
        return reply(ids.length ? ids.join("\n") + "\n" : "(empty)");
      }

      if (month || path === "/index" || path === "/log") {
        if (method !== "GET") return reply("Use GET.", 405, { Allow: "GET" });
        const wantsHtml = url.searchParams.get("format") === "html"
          || (request.headers.get("accept") ?? "").includes("text/html");
        if (path === "/log") {
          if (wantsHtml) return await readNotesHtml(env.LOG_KV, { limit: 25 });
          return await readNotes(env.LOG_KV);
        }
        if (!month) return await readMonthIndex(env.LOG_KV);
        const prefix = `${month[1]}-${month[2]}-`;
        const entries = (await listNotes(env.LOG_KV)).filter(note => note.time?.startsWith(prefix));
        return jsonReply(entries.map(publicNote));
      }

      const note = url.searchParams.get("t") ?? url.searchParams.get("text");
      const appleNotes = path === "/note" && url.searchParams.get("format") === "notes";
      const responseFormat = appleNotes ? "notes" : path === "/" && !wantsJson ? "saved" : "json";
      if (method === "POST" && note === null) return await postNote(request, url, env, responseFormat);
      if (method !== "GET" && method !== "POST") return reply("Use GET or POST.", 405, { Allow: "GET, POST" });
      if (note !== null && (path !== "/" || note)) {
        if (!keyAuthorized) return reply("unauthorized", 401);
        return await saveNote(env.LOG_KV, note, MAX_GET_NOTE_BYTES, url.searchParams.get("topic") ?? "", responseFormat);
      }
      if (path === "/") {
        const wantsHtml = url.searchParams.get("format") === "html"
          || (request.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) return await readNotesHtml(env.LOG_KV, { limit: 20 });
        return wantsJson
          ? await readMonthIndex(env.LOG_KV)
          : await readNotes(env.LOG_KV, { includeIds: true });
      }
      return reply("Not found.", 404);
    } catch {
      return reply("The note log is unavailable. Check the log before retrying a change.", 503);
    }
  },
};

export default worker;
