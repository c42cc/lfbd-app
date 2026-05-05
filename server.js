require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const gemini = require('./providers/gemini');
const grok = require('./providers/grok');
const pipEngine = require('./pip-engine');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());

// -- Root: landing page only, never expose the session token --
app.get('/', (req, res) => {
  if (process.env.SESSION_TOKEN) {
    return res.redirect(302, '/s/' + process.env.SESSION_TOKEN);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// -- Session entry point --
app.get('/s/:token', (req, res) => {
  const { token } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(token)) {
    return res.status(400).send('Invalid session link.');
  }
  db.getSettings(token); // ensures settings row exists
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -- Transcript CRUD --
app.get('/api/transcripts/:token', (req, res) => {
  const rows = db.getTranscripts(req.params.token);
  res.json(rows.map(r => ({ ...r, turns: JSON.parse(r.turns) })));
});

app.post('/api/transcripts/:token', (req, res) => {
  const data = { id: uuidv4(), ...req.body };
  try {
    db.saveTranscript(req.params.token, data);
    res.json({ ok: true, id: data.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/transcripts/:token/:id', (req, res) => {
  const deleted = db.deleteTranscript(req.params.token, req.params.id);
  res.json({ ok: deleted });
});

// -- Settings --
app.get('/api/settings/:token', (req, res) => {
  res.json(db.getSettings(req.params.token));
});

app.put('/api/settings/:token', (req, res) => {
  db.upsertSettings(req.params.token, req.body);
  res.json({ ok: true });
});

// -- Admin API (bearer token auth) --
function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/health', adminAuth, (req, res) => {
  const stats = db.getStats();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: require('./package.json').version,
    db: stats
  });
});

app.get('/api/admin/settings/:token', adminAuth, (req, res) => {
  res.json(db.getSettings(req.params.token));
});

app.put('/api/admin/settings/:token', adminAuth, (req, res) => {
  db.upsertSettings(req.params.token, req.body);
  res.json({ ok: true });
});

app.get('/api/admin/transcripts/:token', adminAuth, (req, res) => {
  const rows = db.getTranscripts(req.params.token);
  res.json(rows.map(r => ({ ...r, turns: JSON.parse(r.turns) })));
});

app.get('/api/admin/transcripts/:token/:id', adminAuth, (req, res) => {
  const row = db.getTranscript(req.params.token, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, turns: JSON.parse(row.turns) });
});

app.delete('/api/admin/transcripts/:token/:id', adminAuth, (req, res) => {
  const deleted = db.deleteTranscript(req.params.token, req.params.id);
  res.json({ ok: deleted });
});

app.delete('/api/admin/transcripts/:token', adminAuth, (req, res) => {
  const count = db.deleteAllTranscripts(req.params.token);
  res.json({ ok: true, deleted: count });
});

// -- Theme (user-facing: read only) --
app.get('/api/theme/:token', (req, res) => {
  res.json(db.getTheme(req.params.token));
});

// -- Theme (admin: read/write) --
app.get('/api/admin/theme/:token', adminAuth, (req, res) => {
  res.json(db.getTheme(req.params.token));
});

app.put('/api/admin/theme/:token', adminAuth, (req, res) => {
  db.setTheme(req.params.token, req.body);
  res.json({ ok: true, applied: req.body });
});

// -- Pip messaging (user-facing) --
app.get('/api/pip/:token', (req, res) => {
  const since = req.query.since || null;
  res.json(db.getPipMessages(req.params.token, since));
});

app.post('/api/pip/:token', async (req, res) => {
  const { text, mode } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });

  const userMsg = db.sendPipMessage(req.params.token, 'user', text.trim());

  if (mode === 'build') {
    try {
      const action = await pipEngine.processBuildRequest(req.params.token, text.trim());
      pipEngine.applyPreview(req.params.token, action);
      const pipReply = db.sendPipMessage(req.params.token, 'pip', action.reply);
      return res.json({ messages: [userMsg, pipReply], preview: { css: action.css } });
    } catch (err) {
      console.error('Pip build error:', err);
      const errReply = db.sendPipMessage(req.params.token, 'pip', `Sorry, I hit an error: ${err.message}`);
      return res.json({ messages: [userMsg, errReply], preview: null });
    }
  }

  if (mode === 'chat') {
    try {
      const reply = await pipEngine.processChatRequest(req.params.token, text.trim());
      const pipReply = db.sendPipMessage(req.params.token, 'pip', reply);
      return res.json({ messages: [userMsg, pipReply] });
    } catch (err) {
      console.error('Pip chat error:', err);
      const errReply = db.sendPipMessage(req.params.token, 'pip', `Sorry, something went wrong.`);
      return res.json({ messages: [userMsg, errReply] });
    }
  }

  res.json({ messages: [userMsg] });
});

app.post('/api/pip/:token/set', async (req, res) => {
  try {
    await pipEngine.commitChanges(req.params.token);
    db.sendPipMessage(req.params.token, 'pip', 'Changes are now permanent! The app will redeploy in about a minute.');
    res.json({ ok: true, status: 'deploying' });
  } catch (err) {
    console.error('Pip commit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -- Pip messaging (engineer via admin) --
app.get('/api/admin/pip/:token', adminAuth, (req, res) => {
  const since = req.query.since || null;
  res.json(db.getPipMessages(req.params.token, since));
});

app.post('/api/admin/pip/:token', adminAuth, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });
  const msg = db.sendPipMessage(req.params.token, 'pip', text.trim());
  res.json(msg);
});

// -- Session-gated ephemeral token endpoints --
function requireSession(req, res, next) {
  const { token } = req.params;
  if (!token || !/^[a-f0-9-]{36}$/i.test(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!db.sessionExists(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/token/:token/gemini', requireSession, async (req, res) => {
  try {
    res.json(await gemini.getEphemeralToken());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/token/:token/grok', requireSession, async (req, res) => {
  try {
    res.json(await grok.getEphemeralToken());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Fallback: serve the app for any unmatched route --
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`LFBD running on http://localhost:${PORT}`);
  if (process.env.SESSION_TOKEN) {
    console.log(`Session URL: http://localhost:${PORT}/s/${process.env.SESSION_TOKEN}`);
  }
});
