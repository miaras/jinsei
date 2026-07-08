# 人生 (JINSEI) — server

A tiny Express backend for the JINSEI game. It exists for one reason:
your Anthropic API key can't live in the browser, so this holds it
server-side and streams Claude's response through to the page as it's
generated.

## Setup

```bash
npm install
cp .env.example .env
# open .env and paste in your key from https://console.anthropic.com/
npm start
```

Then open **http://localhost:3000**.

## How it fits together

```
browser (public/index.html)
   │  POST /api/turn  { system, messages }
   ▼
server.js
   │  attaches your API key, forwards to Anthropic with stream: true
   ▼
api.anthropic.com/v1/messages
   │  server-sent events, piped straight back through, unbuffered
   ▼
browser renders narration + dialogue live, token by token
```

`server.js` never lets the client set the model, key, or token limit —
it only accepts the conversation content (`system`, `messages`) and
fills in the rest. That's what makes it safe to expose publicly.

## Deploying

This runs anywhere that runs Node ≥18: Render, Fly.io, Railway, a VPS,
etc. Set `ANTHROPIC_API_KEY` (and optionally `PORT`) as environment
variables on whatever platform you use — don't commit `.env`.

If you put it behind a reverse proxy (nginx, etc.), make sure the proxy
doesn't buffer the `/api/turn` response — buffering defeats the whole
point of streaming. The server already sends `X-Accel-Buffering: no`
for nginx; other proxies may need an equivalent setting.

## Files

- `server.js` — the proxy described above
- `public/index.html` — the game itself (static, served as-is)
- `.env.example` — copy to `.env` and fill in your key
