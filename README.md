# Tesla Grok Notes

A self-hosted notes logger for a Tesla/Grok workflow. It runs on a Cloudflare Worker with Workers KV and can be used from Apple Shortcuts or a paired browser.

## Features

- Save notes with unique IDs and timestamps
- Read all notes, IDs only, timestamped logs, and monthly counts
- Show recent notes as simple HTML for browser-based reading; the HTML view automatically refreshes every 10 seconds
- Edit and delete notes by ID
- Preview and apply retention trimming
- Pair a browser once to save notes and read the log without putting the key in the URL

## Deploy your own copy

1. Create a Cloudflare Worker and paste in [worker.mjs](worker.mjs).
2. Create a Workers KV namespace.
3. Add a KV binding named `LOG_KV` and select that namespace.
4. Add Worker secrets:
   - `NOTE_KEY`: a long, random secret (at least 32 URL-safe characters)
   - `CAR_SESSION_SECRET`: a separate long, random secret for paired-browser sessions
5. Deploy the Worker and use the URL Cloudflare gives you.

Each person should use their own Worker, KV namespace, and secrets. Never use someone else's endpoint or credentials.

## Pair the car browser

1. Open `YOUR_WORKER_URL/pair` in the browser you want to pair.
2. Enter your `NOTE_KEY` once.
3. After pairing, that browser can open `YOUR_WORKER_URL/` or `YOUR_WORKER_URL/log` to read notes. A browser normally receives the HTML view automatically; add `?format=html` to request it explicitly. The HTML view reloads every 10 seconds to show new or updated notes while it stays open.
4. To save through the paired browser, open `YOUR_WORKER_URL/submit?note=URL_ENCODED_NOTE`. Add `&topic=URL_ENCODED_TOPIC` if desired.

Pairing is stored in a secure, HTTP-only browser cookie. Keep the paired browser private. The session grants read access to the notes and the existing paired-browser save flow; edit, delete, and trim routes still require the note key.

## Authentication and privacy

API requests can use an `Authorization: Bearer YOUR_NOTE_KEY` header (recommended) or a `?key=YOUR_NOTE_KEY` query parameter. The paired browser can read notes without putting the key in the address. Query-string keys and note text can remain in browser history and request logs.

Anyone with the note key can read, add, edit, and delete notes. Do not share your key. The repository contains no live Worker URL, namespace ID, or secret.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Read IDs and note text; HTML when requested by a browser |
| `/read` | Read-only view; HTML when requested by a browser |
| `/ids` | Read IDs only |
| `/log` | Read timestamped notes; HTML when requested by a browser |
| `/index` | Counts by month |
| `/YYYY/MM` | Notes for a month |
| `/update?id=NOTE_ID&text=...` | Replace a note's text |
| `/delete` | Delete a note (POST with ID and confirmation) |
| `/trim?days=30` | Preview old notes; POST with confirmation to delete |
| `/pair` and `/submit` | Pair a browser and save notes from it |

## Apple Shortcuts

Use **Get Contents of URL**. For writes, use POST with JSON and an Authorization header. To delete a note, POST JSON containing its `id` and Boolean `confirm: true`. The `/ids` route can supply IDs to edit or delete shortcuts.

This is an independent project, not an official Tesla or xAI/Grok integration. The repository is MIT-licensed; see [LICENSE](LICENSE).
