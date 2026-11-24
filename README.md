# Tesla Grok Notes

A self-hosted notes logger for capturing Tesla/Grok notes from Apple Shortcuts and a paired car browser. It runs on Cloudflare Workers with Workers KV.

## Features

- Save notes with unique IDs and timestamps
- View all notes, IDs only, timestamped logs, or month-by-month counts
- Edit and delete notes by ID
- Preview and apply retention trimming
- Optional paired-browser submission flow

## Deploy your own copy

1. Create a Cloudflare Worker and paste in [worker.mjs](worker.mjs).
2. Create a Workers KV namespace.
3. Add a KV binding named `LOG_KV` and select that namespace.
4. Add Worker secrets:
   - `NOTE_KEY`: a long, random secret (at least 32 URL-safe characters)
   - `CAR_SESSION_SECRET`: a separate long, random secret for paired-browser sessions
5. Deploy the Worker and use the URL Cloudflare gives you.

Each user should deploy their own Worker, KV namespace, and secrets. Do not use someone else's endpoint or credentials.

## Authentication

Requests can use an `Authorization: Bearer YOUR_NOTE_KEY` header (recommended) or a `?key=YOUR_NOTE_KEY` query parameter. Query-string keys can remain in browser history and request logs. Anyone with the key can read, add, edit, and delete notes.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | List IDs and note text |
| `/ids` | List IDs only |
| `/log` | Timestamped notes |
| `/index` | Counts by month |
| `/YYYY/MM` | Notes for a month |
| `/update?id=NOTE_ID&text=...` | Replace a note's text |
| `/delete` | Delete a note (POST with ID and confirmation) |
| `/trim?days=30` | Preview old notes; POST with confirmation to delete |
| `/pair` and `/submit` | Optional paired-browser flow |

Management routes require authentication.

## Apple Shortcuts

Use **Get Contents of URL** with your Worker URL. For writes, use POST with JSON and an Authorization header. To delete a note, POST JSON containing its `id` and Boolean `confirm: true`. The `/ids` route can supply IDs to edit or delete shortcuts.

## Safety

- Never commit real keys, notes, browser exports, `.dev.vars`, or private Worker URLs.
- Keep a backup before using delete or trim.
- Use a separate KV namespace and fresh secrets for every installation.
- This repository currently has no license. Public visibility by itself does not grant permission to reuse or modify the code; add a license before inviting public reuse.
