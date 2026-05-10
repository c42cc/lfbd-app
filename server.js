require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const db = require('./db');
const gemini = require('./providers/gemini');
const grok = require('./providers/grok');
const { createPipRouter } = require('./pip-router');

// ---------------------------------------------------------------------------
// Pip LLM fallback chain (Claude -> Grok -> Gemini)
// ---------------------------------------------------------------------------

const GROK_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
const GOOGLE_AI_STUDIO_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function pipLlmCall(system, userPrompt) {
  if (ANTHROPIC_API_KEY) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.content?.[0]?.text || '';
      }
      console.log('Claude failed:', resp.status);
    } catch (err) {
      console.log('Claude failed, falling back:', err.message);
    }
  }
  if (GROK_API_KEY) {
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-3-fast',
          messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
          temperature: 0.3,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      }
      console.log('Grok failed:', resp.status);
    } catch (err) {
      console.log('Grok failed:', err.message);
    }
  }
  if (GOOGLE_AI_STUDIO_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_STUDIO_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('No LLM API key configured');
}

// ---------------------------------------------------------------------------
// Pip commit hook (GitHub push + deploy)
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'c42cc/lfbd-app';
const FLY_APP = process.env.FLY_APP || 'lfbd-app';

async function pipOnCommit(css, newFileContent) {
  let pushed = false;
  let deployed = false;

  if (GITHUB_TOKEN) {
    const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/public/style.css`;
    const existing = await fetch(ghUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
    let sha;
    if (existing.ok) sha = (await existing.json()).sha;

    const body = { message: 'Pip: apply CSS overrides', content: Buffer.from(newFileContent).toString('base64'), branch: 'main' };
    if (sha) body.sha = sha;

    const resp = await fetch(ghUrl, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`GitHub push failed: ${resp.status}`);
    pushed = true;
  }

  try {
    const { execSync } = require('child_process');
    execSync(`flyctl deploy -a ${FLY_APP} --remote-only`, { stdio: 'pipe', timeout: 300000 });
    deployed = true;
  } catch (err) {
    console.error('Fly deploy failed:', err.message);
  }

  return { pushed, deployed };
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const BUILD_DATE = new Date().toISOString().slice(0, 10).replace(/-/g, '');

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/build-date', (req, res) => res.json({ date: BUILD_DATE }));

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

// -- Pip AI assistant (modular router) --
app.use(createPipRouter({
  projectRoot: __dirname,
  cssFile: path.join(__dirname, 'public', 'style.css'),
  llmCall: pipLlmCall,
  onCommit: pipOnCommit,
  masonPrompt: `You are Pip, a friendly UI engineer for LFBD, a voice companion web app.
The user will ask you to change colors, text, layout, or other visual aspects of the app.

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.

The app uses CSS custom properties on :root:
  --bg (background, default #FAF8F5)
  --bg-secondary (panels, default #F0EDE8)
  --accent (buttons/links, default #A8B5A0)
  --accent-hover (hover state, default #95a58d)
  --text (main text, default #4A4A4A)
  --text-muted (secondary text, default #8A8A8A)
  --rose (recording indicator, default #D4A0A0)

Response format:
{"css": ":root { --accent: #FF0000; }", "reply": "Done! I changed the accent color to red."}

If the request is just conversation (not a change request), return:
{"css": "", "reply": "your conversational response"}`,
  scribePrompt: `You are Pip, a warm and friendly companion for the LFBD app.
You help the user with questions, offer guidance, and have casual conversations.
Keep responses short, warm, and supportive. You're like a helpful friend, not a therapist.`,
}));

// -- Pip messaging (engineer channel, DB-backed) --
app.get('/api/pip/messages/:token', (req, res) => {
  const since = req.query.since || null;
  res.json(db.getPipMessages(req.params.token, since));
});

app.post('/api/pip/messages/:token', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });
  const msg = db.sendPipMessage(req.params.token, 'user', text.trim());
  res.json(msg);
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
