#!/usr/bin/env node
/**
 * Reset a user's password directly in the database.
 *
 * Usage:
 *   node scripts/reset-password.js <username> <new-password>
 *
 * Run this from the jinsei-server directory (same place as server.js),
 * so it finds data/jinsei.db the same way the server does. This also
 * logs the user out of every existing session, so anyone using the old
 * password (or an old session cookie) is booted immediately.
 */
import path from 'path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'jinsei.db');

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <username> <new-password>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('Password must be at least 8 characters (same rule the app enforces).');
  process.exit(1);
}

const db = new Database(DB_PATH);

const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user found with username "${username}".`);
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 12);
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

// Invalidate existing sessions so old logins/cookies stop working.
const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

console.log(`Password updated for "${username}". ${changes} active session(s) cleared.`);
