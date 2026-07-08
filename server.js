import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/* =====================================================================
   DATABASE — one small SQLite file. Three tables: users, sessions,
   and one save slot per user (this is a single-character-life game,
   so one row per user is enough; ON CONFLICT keeps it that way).
===================================================================== */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'jinsei.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Sweep expired sessions once an hour so the table doesn't grow forever.
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}, 60 * 60 * 1000).unref();

/* ---------------- auth helpers ---------------- */
const SESSION_DAYS = 30;
const COOKIE_NAME = 'jinsei_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expires.toISOString());
  return { token, expires };
}

function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    expires
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  const row = db.prepare(
    `SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row || new Date(row.expiresAt) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Session expired — log in again.' });
  }
  req.user = { id: row.userId, username: row.username };
  next();
}

/* ---------------- auth routes ---------------- */
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username: 3-20 characters, letters/numbers/underscore only.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, new Date().toISOString());
  const { token, expires } = createSession(info.lastInsertRowid);
  setSessionCookie(res, token, expires);
  res.json({ username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const { token, expires } = createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

/* ---------------- save routes (one slot per account) ---------------- */
app.get('/api/save', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data, updated_at AS updatedAt FROM saves WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'No save found.' });
  res.json({ data: JSON.parse(row.data), updatedAt: row.updatedAt });
});

app.put('/api/save', requireAuth, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Save payload must be an object.' });
  }
  const json = JSON.stringify(data);
  if (json.length > 2_000_000) {
    return res.status(413).json({ error: 'Save is too large.' });
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO saves (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.id, json, now);
  res.json({ ok: true, updatedAt: now });
});

app.delete('/api/save', requireAuth, (req, res) => {
  db.prepare('DELETE FROM saves WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* =====================================================================
   GAME TURN — same streaming proxy as before, now gated behind login
   so an anonymous visitor can't spend your Anthropic quota.
===================================================================== */
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

app.post('/api/turn', requireAuth, async (req, res) => {
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
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

