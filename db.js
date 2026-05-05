const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lfbd.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    session_token TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    provider TEXT NOT NULL,
    turns TEXT NOT NULL DEFAULT '[]',
    system_prompt TEXT,
    message_prompt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_token ON transcripts(session_token);

  CREATE TABLE IF NOT EXISTS settings (
    session_token TEXT PRIMARY KEY,
    system_prompt TEXT NOT NULL DEFAULT '',
    message_prompt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS theme (
    session_token TEXT PRIMARY KEY,
    overrides TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS pip_messages (
    id TEXT PRIMARY KEY,
    session_token TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pip_token ON pip_messages(session_token);
`);

const DEFAULT_SYSTEM_PROMPT = `You are a compassionate, patient voice companion helping someone recover from a traumatic accident. Your role is supportive, not clinical.

Guidelines:
- Listen more than you speak. Short, warm responses.
- Never diagnose. Never prescribe. You are not a therapist.
- Validate their feelings. "That makes sense" > "You should..."
- If they mention severe distress, self-harm, or danger, gently suggest they reach out to a professional or call 988 (Suicide & Crisis Lifeline).
- Remember details they've shared (from conversation history) and reference them naturally.
- Keep your tone calm, grounded, warm. Like a trusted friend.
- It's okay to sit in silence. Don't fill every pause.
- Celebrate small wins. Recovery is non-linear. Acknowledge that.`;

module.exports = {
  getTranscripts(token) {
    return db.prepare(
      'SELECT * FROM transcripts WHERE session_token = ? ORDER BY started_at DESC'
    ).all(token);
  },

  saveTranscript(token, data) {
    db.prepare(`
      INSERT INTO transcripts (id, session_token, started_at, ended_at, provider, turns, system_prompt, message_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id, token, data.started_at, data.ended_at || null,
      data.provider, JSON.stringify(data.turns || []),
      data.system_prompt || null, data.message_prompt || null
    );
  },

  deleteTranscript(token, id) {
    const result = db.prepare(
      'DELETE FROM transcripts WHERE id = ? AND session_token = ?'
    ).run(id, token);
    return result.changes > 0;
  },

  deleteAllTranscripts(token) {
    const result = db.prepare(
      'DELETE FROM transcripts WHERE session_token = ?'
    ).run(token);
    return result.changes;
  },

  getTranscript(token, id) {
    const row = db.prepare(
      'SELECT * FROM transcripts WHERE id = ? AND session_token = ?'
    ).get(id, token);
    return row;
  },

  getStats() {
    const transcripts = db.prepare('SELECT COUNT(*) as count FROM transcripts').get().count;
    const settings = db.prepare('SELECT COUNT(*) as count FROM settings').get().count;
    return { transcripts, settings };
  },

  sessionExists(token) {
    return !!db.prepare('SELECT 1 FROM settings WHERE session_token = ?').get(token);
  },

  getSettings(token) {
    let row = db.prepare('SELECT * FROM settings WHERE session_token = ?').get(token);
    if (!row) {
      db.prepare(
        'INSERT INTO settings (session_token, system_prompt, message_prompt) VALUES (?, ?, ?)'
      ).run(token, DEFAULT_SYSTEM_PROMPT, '');
      row = { session_token: token, system_prompt: DEFAULT_SYSTEM_PROMPT, message_prompt: '' };
    }
    return row;
  },

  upsertSettings(token, data) {
    db.prepare(`
      INSERT INTO settings (session_token, system_prompt, message_prompt)
      VALUES (?, ?, ?)
      ON CONFLICT(session_token) DO UPDATE SET
        system_prompt = excluded.system_prompt,
        message_prompt = excluded.message_prompt
    `).run(token, data.system_prompt || '', data.message_prompt || '');
  },

  getTheme(token) {
    const row = db.prepare('SELECT overrides FROM theme WHERE session_token = ?').get(token);
    if (!row) return {};
    try { return JSON.parse(row.overrides); } catch (_) { return {}; }
  },

  setTheme(token, overrides) {
    db.prepare(`
      INSERT INTO theme (session_token, overrides) VALUES (?, ?)
      ON CONFLICT(session_token) DO UPDATE SET overrides = excluded.overrides
    `).run(token, JSON.stringify(overrides));
  },

  getPipMessages(token, since) {
    if (since) {
      return db.prepare(
        'SELECT * FROM pip_messages WHERE session_token = ? AND created_at > ? ORDER BY created_at ASC'
      ).all(token, since);
    }
    return db.prepare(
      'SELECT * FROM pip_messages WHERE session_token = ? ORDER BY created_at ASC'
    ).all(token);
  },

  sendPipMessage(token, sender, text) {
    const id = require('uuid').v4();
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO pip_messages (id, session_token, sender, text, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, token, sender, text, created_at);
    return { id, sender, text, created_at };
  },

  DEFAULT_SYSTEM_PROMPT
};
