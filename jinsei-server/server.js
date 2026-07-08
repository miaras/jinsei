import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.warn(
    '⚠️  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, ' +
    'or /api/turn will fail on every request.'
  );
}

/**
 * The game's frontend sends { system, messages, stream } and expects the
 * raw Anthropic SSE stream back. This route is the only thing standing
 * between the browser and the API key, so it never trusts the client
 * with anything except the conversation content.
 */
app.post('/api/turn', async (req, res) => {
  const { system, messages } = req.body || {};

  if (typeof system !== 'string' || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request must include "system" (string) and "messages" (array).' });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system,
        messages,
        stream: true
      })
    });
  } catch (err) {
    console.error('Could not reach Anthropic:', err);
    return res.status(502).json({ error: 'Could not reach the Anthropic API.' });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('Anthropic API error:', upstream.status, detail);
    return res.status(upstream.status).json({ error: 'Anthropic API returned an error.', detail });
  }

  // Pipe the SSE stream straight through, unbuffered, so the browser sees
  // tokens as they're generated instead of waiting for the full reply.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // in case this ever sits behind nginx
  });

  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    console.error('Stream interrupted:', err);
  } finally {
    res.end();
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(API_KEY) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`人生 (JINSEI) server running → http://localhost:${PORT}`);
});
