# 人生 (JINSEI) — server

A small Express + SQLite backend for the JINSEI game. It does three
things: holds your Anthropic API key server-side (streaming Claude's
response through to the page as it's generated), gives each player an
account so their life is saved on the server instead of one browser,
and generates a background image for every turn with Flux Schnell.

## Setup

```bash
npm install
cp .env.example .env
# open .env and paste in your key from https://console.anthropic.com/
npm start
```

Then open **http://localhost:3000**, register an account, and play.
Log back in from any device to pick up the same life.

## How it fits together

```
browser (public/index.html)
   │  register/login/turn/save — cookie-authenticated JSON
   ▼
server.js
   │  bcrypt-hashes passwords, issues session tokens (SQLite),
   │  attaches your API key, forwards /api/turn to Anthropic
   ▼
api.anthropic.com/v1/messages           data/jinsei.db (SQLite)
   │  SSE, piped straight back through     users · sessions · one
   ▼  unbuffered                           save row per account
browser renders narration + dialogue live, token by token
```

`server.js` never lets the client set the model, key, or token limit —
only the conversation content. `/api/turn` and `/api/save` both
require a valid session, so a stranger can't spend your API quota or
read someone else's save just by finding the URL.

### The database

One file: `data/jinsei.db` (created automatically on first run, and
already excluded via `.gitignore`). Three tables:

- `users` — username + bcrypt password hash
- `sessions` — random session tokens, 30-day expiry, swept hourly
- `saves` — one row per user (their current life, as JSON)

There's no admin UI for this — it's small enough that `sqlite3
data/jinsei.db` on the server is enough if you ever need to look at
or edit it directly.

### Resetting a password

If someone's locked out (or you just need to set one manually):

```bash
node scripts/reset-password.js <username> <new-password>
```

Run it from this directory (same place as `server.js`), with the
server stopped or running — either is fine, it talks to the database
file directly. It hashes the new password the same way the app does,
and clears any existing sessions for that user, so old logins stop
working immediately.

## Environment variables

| Variable            | Required | Notes                                                       |
|----------------------|----------|--------------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | yes      | from console.anthropic.com                                   |
| `PORT`                | no       | defaults to 3000                                              |
| `COOKIE_SECURE`       | no       | set `true` once you're serving over HTTPS (e.g. behind Caddy) |

## Environment variables

| Variable               | Required | Notes                                                       |
|-------------------------|----------|--------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | yes      | from console.anthropic.com                                   |
| `REPLICATE_API_TOKEN`   | no       | from replicate.com/account/api-tokens — powers scene images  |
| `PORT`                  | no       | defaults to 3000                                              |
| `COOKIE_SECURE`         | no       | set `true` once you're serving over HTTPS (e.g. behind Caddy) |

### Scene images

Every turn, the game master also writes a short, purely visual
description of the current setting (no people in it, by instruction).
`/api/image` sends that to Flux Schnell on Replicate and the image
appears above the narration once it's ready — the text stream never
waits on it, so a slow or failed image never blocks play.

Two things worth knowing:

- **"No people" is best-effort, not guaranteed.** Flux Schnell has no
  negative-prompt input (unlike SDXL-style models), so the "empty of
  people" instruction is baked into the positive prompt on both the
  game-master side (it's told never to describe people in the scene
  text) and the server side (an explicit suffix is appended before
  sending to Replicate). Occasionally a figure or silhouette will
  still slip through — that's a real model limitation, not a bug.
- **This costs money per turn.** Flux Schnell is cheap (a fraction of
  a cent per image on Replicate), but it's not free, and it's called
  automatically every turn once `REPLICATE_API_TOKEN` is set. Leave
  it unset if you'd rather the game ran text-only — everything else
  works identically either way.

## Deploying

Runs anywhere with Node ≥18: Render, Fly.io, Railway, a Hetzner box,
etc. Set the env vars above on whatever platform you use — don't
commit `.env`, and make sure `data/` persists across deploys/restarts
(it's just a file — a persistent disk/volume is enough, no external
DB service needed).

If you put it behind a reverse proxy (Caddy, nginx, etc.), make sure
the proxy doesn't buffer the `/api/turn` response — buffering defeats
the whole point of streaming. Caddy's `reverse_proxy` doesn't buffer
by default. The server also sends `X-Accel-Buffering: no` for nginx.

## Files

- `server.js` — auth, sessions, saves, and the Anthropic proxy
- `public/index.html` — the game itself (static, served as-is)
- `data/jinsei.db` — created on first run, not checked in
- `.env.example` — copy to `.env` and fill in your key

