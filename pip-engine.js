const fs = require('fs');
const path = require('path');
const db = require('./db');

const GROK_API_KEY = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'c42cc/lfbd';
const RAILWAY_API_KEY = process.env.RAILWAY_API_KEY;
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENV_ID = process.env.RAILWAY_ENV_ID;

const SYSTEM_PROMPT = `You are Pip, a friendly UI engineer for LFBD, a voice companion web app.
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
{
  "css": ":root { --accent: #FF0000; }",
  "reply": "Done! I changed the accent color to red."
}

css: a string of CSS to inject. Can target :root variables or any selector (e.g. ".logo { font-size: 24px; }").
reply: a short, warm confirmation message.

If the request is just conversation (not a change request), return:
{"css": "", "reply": "your conversational response"}`;

const CHAT_SYSTEM = `You are Pip, a warm and friendly companion for the LFBD app. 
You help the user with questions, offer guidance, and have casual conversations.
Keep responses short, warm, and supportive. You're like a helpful friend, not a therapist.`;

async function processBuildRequest(token, userText) {
  const currentCSS = readFile('public/style.css');
  const currentHTML = readFile('public/index.html');
  const userPrompt = `Current CSS (first 200 lines):\n${currentCSS.split('\n').slice(0, 200).join('\n')}\n\nCurrent HTML:\n${currentHTML}\n\nUser request: ${userText}`;

  const raw = await callBuildLLM(userPrompt);

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (_) {
    parsed = { css: '', reply: raw || 'Sorry, I had trouble understanding that.' };
  }

  return {
    css: parsed.css || '',
    reply: parsed.reply || 'Done!'
  };
}

async function processChatRequest(token, userText) {
  const raw = await callChatLLM(userText);
  return raw || "I'm here! What's on your mind?";
}

async function callBuildLLM(userPrompt) {
  if (ANTHROPIC_API_KEY) {
    try {
      return await callClaude(SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      console.log('Claude failed, falling back:', err.message);
    }
  }
  return await callFallbackLLM(SYSTEM_PROMPT, userPrompt);
}

async function callChatLLM(userText) {
  return await callFallbackLLM(CHAT_SYSTEM, userText);
}

async function callFallbackLLM(system, userPrompt) {
  if (GROK_API_KEY) {
    try { return await callGrok(system, userPrompt); }
    catch (err) {
      console.log('Grok failed:', err.message);
      if (!GEMINI_API_KEY) throw err;
    }
  }
  if (GEMINI_API_KEY) {
    return await callGemini(system, userPrompt);
  }
  throw new Error('No LLM API key configured');
}

async function callClaude(system, userPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function callGrok(system, userPrompt) {
  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'grok-3-fast',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Grok API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(system, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.3 }
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function applyPreview(token, action) {
  db.setTheme(token, { pip_css: action.css, updated_at: new Date().toISOString() });
  return action;
}

async function commitChanges(token) {
  const theme = db.getTheme(token);
  const css = theme.pip_css;
  if (!css) throw new Error('No pending changes to commit');

  const stylePath = path.join(__dirname, 'public', 'style.css');
  let styleContent = fs.readFileSync(stylePath, 'utf8');

  const marker = '/* === PIP OVERRIDES === */';
  const markerEnd = '/* === END PIP OVERRIDES === */';
  const block = `${marker}\n${css}\n${markerEnd}`;

  if (styleContent.includes(marker)) {
    styleContent = styleContent.replace(
      new RegExp(`${escapeRegex(marker)}[\\s\\S]*?${escapeRegex(markerEnd)}`),
      block
    );
  } else {
    styleContent = styleContent + '\n\n' + block + '\n';
  }

  fs.writeFileSync(stylePath, styleContent, 'utf8');

  if (GITHUB_TOKEN) {
    await pushToGitHub('public/style.css', styleContent, 'Pip: apply CSS overrides');
  }

  if (RAILWAY_API_KEY && RAILWAY_PROJECT_ID && RAILWAY_ENV_ID) {
    await triggerRailwayDeploy();
  }

  return { ok: true };
}

async function pushToGitHub(filePath, content, message) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const existing = await fetch(url, {
    headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
  });
  let sha;
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const body = { message, content: Buffer.from(content).toString('base64'), branch: 'main' };
  if (sha) body.sha = sha;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub push failed: ${resp.status} ${text}`);
  }
}

async function triggerRailwayDeploy() {
  const resp = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RAILWAY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation { githubRepoDeploy(input: { projectId: "${RAILWAY_PROJECT_ID}", repo: "${GITHUB_REPO}", branch: "main", environmentId: "${RAILWAY_ENV_ID}" }) }`
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Railway deploy failed: ${resp.status} ${text}`);
  }
}

function readFile(relativePath) {
  try { return fs.readFileSync(path.join(__dirname, relativePath), 'utf8'); }
  catch (_) { return ''; }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { processBuildRequest, processChatRequest, applyPreview, commitChanges };
