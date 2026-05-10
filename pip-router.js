/**
 * Pip — portable Express router. Drop into any Node.js project.
 *
 * Usage:
 *   const { createPipRouter } = require('./pip-router');
 *   app.use(createPipRouter({
 *     projectRoot: __dirname,
 *     cssFile: path.join(__dirname, 'public', 'style.css'),
 *     llmCall: async (system, userPrompt, opts) => '...',
 *   }));
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SCRIBE_SYSTEM_PROMPT = `You are Pip — a quirky, witty AI co-pilot embedded in a developer's project. \
You have dry humor and genuine enthusiasm for good craft. You're like a \
knowledgeable friend, not a manual.

You help users with:
- Understanding the codebase and architecture
- Adjusting settings and configuration
- Troubleshooting issues
- Answering questions about the project
- Executing actions via tool calls when asked

Keep responses short, conversational, and personality-forward.`;

const MASON_SYSTEM_PROMPT = `You are Pip in Mason mode — the engineer, architect, and UI/UX designer. \
You maintain your personality (quirky, dry humor) but your focus shifts to \
building and designing.

You can modify the app's appearance via CSS custom properties injected into \
the page. When the user describes a visual change:
1. Respond with valid JSON only: {"css": "...", "reply": "..."}
2. css = CSS to inject as a live preview (can target :root vars or any selector)
3. reply = short, warm confirmation in your voice

If the request is just conversation (not a change request), return:
{"css": "", "reply": "your conversational response"}

Be concise. Stay in character as Pip.`;

const MASON_INTENT_RE = /(?:change|make|set|update|switch|turn)\s+(?:the\s+)?(?:background|color|font|theme|border|accent|dark|light|ui|css|style|design|radius|shadow)/i;

const SOURCE_EXTENSIONS = new Set([
  '.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.py',
  '.json', '.md', '.yaml', '.yml', '.toml', '.env',
]);

const BINARY_SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.cache', '.pytest_cache',
]);

// ---------------------------------------------------------------------------
// File-access tools
// ---------------------------------------------------------------------------

function safeResolve(projectRoot, relative) {
  const target = path.resolve(projectRoot, relative);
  if (!target.startsWith(path.resolve(projectRoot))) {
    throw new Error(`Path traversal blocked: ${relative}`);
  }
  return target;
}

function listFiles(projectRoot, subdir = '') {
  const base = subdir ? safeResolve(projectRoot, subdir) : path.resolve(projectRoot);
  const results = [];
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return results;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (BINARY_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.relative(path.resolve(projectRoot), full));
      }
      if (results.length >= 200) return;
    }
  }
  walk(base);
  return results.sort();
}

function readProjectFile(projectRoot, relPath) {
  const target = safeResolve(projectRoot, relPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Not found: ${relPath}`);
  }
  let content = fs.readFileSync(target, 'utf8');
  if (content.length > 50000) {
    content = content.slice(0, 50000) + '\n\n... (truncated at 50k chars)';
  }
  return content;
}

function writeProjectFile(projectRoot, relPath, content) {
  const target = safeResolve(projectRoot, relPath);
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, target + '.bak');
  }
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return `Wrote ${content.length} chars to ${relPath}`;
}

function executeFileTool(toolName, args, projectRoot) {
  if (!projectRoot) return 'File access not configured (no projectRoot).';
  try {
    if (toolName === 'list_files') {
      const files = listFiles(projectRoot, args.directory || '');
      return files.length ? files.join('\n') : '(no source files found)';
    }
    if (toolName === 'read_file') {
      return readProjectFile(projectRoot, args.path);
    }
    if (toolName === 'write_file') {
      return writeProjectFile(projectRoot, args.path, args.content);
    }
  } catch (err) {
    return err.message;
  }
  return `Unknown file tool: ${toolName}`;
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

function detectMode(message, explicitMode) {
  if (explicitMode && (explicitMode === 'scribe' || explicitMode === 'mason')) {
    return explicitMode;
  }
  return MASON_INTENT_RE.test(message) ? 'mason' : 'scribe';
}

// ---------------------------------------------------------------------------
// CSS marker helpers
// ---------------------------------------------------------------------------

const CSS_MARKER = '/* === PIP OVERRIDES === */';
const CSS_MARKER_END = '/* === END PIP OVERRIDES === */';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commitCssToFile(cssFilePath, css) {
  let content = fs.existsSync(cssFilePath) ? fs.readFileSync(cssFilePath, 'utf8') : '';
  const block = `${CSS_MARKER}\n${css}\n${CSS_MARKER_END}`;

  if (content.includes(CSS_MARKER)) {
    content = content.replace(
      new RegExp(`${escapeRegex(CSS_MARKER)}[\\s\\S]*?${escapeRegex(CSS_MARKER_END)}`),
      block
    );
  } else {
    content = content + '\n\n' + block + '\n';
  }

  fs.writeFileSync(cssFilePath, content, 'utf8');
  return content;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a self-contained Pip Express router.
 *
 * @param {Object} opts
 * @param {string|null}  opts.projectRoot       - Absolute path. Enables file tools.
 * @param {string|null}  opts.cssFile           - Absolute path to CSS file for commits.
 * @param {string|null}  opts.scribePrompt      - Custom scribe system prompt.
 * @param {string|null}  opts.masonPrompt       - Custom mason system prompt.
 * @param {Function}     opts.llmCall           - async (system, userPrompt, opts?) => string
 * @param {Function|null} opts.extraToolExecutor - async (toolName, args, projectId) => string|null
 * @param {Function|null} opts.onCommit         - async (css, newFileContent) => { pushed, deployed }
 * @param {Function|null} opts.projectContextFn  - (projectId) => string
 * @param {string}       opts.prefix            - Route prefix (default '/api/pip').
 */
function createPipRouter(opts = {}) {
  const {
    projectRoot = null,
    cssFile = null,
    scribePrompt = null,
    masonPrompt = null,
    llmCall = null,
    extraToolExecutor = null,
    onCommit = null,
    projectContextFn = null,
    prefix = '/api/pip',
  } = opts;

  const router = express.Router();
  const _scribe = scribePrompt || SCRIBE_SYSTEM_PROMPT;
  const _mason = masonPrompt || MASON_SYSTEM_PROMPT;

  function requireLlm(res) {
    if (!llmCall) {
      res.status(503).json({ error: 'No LLM provider configured' });
      return false;
    }
    return true;
  }

  function buildContext(projectId) {
    if (projectContextFn) {
      try { return projectContextFn(projectId); }
      catch (_) { return '\n\nNo project context available.'; }
    }
    return '\n\nNo project loaded.';
  }

  function getFileTreeSummary() {
    if (!projectRoot) return '';
    const files = listFiles(projectRoot);
    if (!files.length) return '';
    return '\n\nProject file tree:\n' + files.slice(0, 50).map(f => `  ${f}`).join('\n');
  }

  async function executeTool(toolName, args, projectId) {
    if (['list_files', 'read_file', 'write_file'].includes(toolName)) {
      return executeFileTool(toolName, args, projectRoot);
    }
    if (extraToolExecutor) {
      const result = await extraToolExecutor(toolName, args, projectId);
      if (typeof result === 'string') return result;
    }
    return `Unknown tool: ${toolName}`;
  }

  // ── Health ──

  router.get(prefix + '/health', (req, res) => {
    res.json({
      status: 'ok',
      llm_configured: !!llmCall,
      has_project_root: !!projectRoot,
    });
  });

  // ── Text chat ──

  router.post(prefix + '/text', async (req, res) => {
    if (!requireLlm(res)) return;

    const { message = '', project_id, history, mode: modeHint } = req.body;
    if (!message.trim() && message !== '__greeting__') {
      return res.status(400).json({ error: 'Empty message' });
    }

    const mode = detectMode(message, modeHint);
    const context = buildContext(project_id);
    let system;
    if (mode === 'mason') {
      system = _mason + context + getFileTreeSummary();
    } else {
      system = _scribe + context;
    }

    const prompt = message === '__greeting__'
      ? 'Greet the user briefly. Introduce yourself as Pip. Be warm, witty, and keep it to 1-2 sentences.'
      : message;

    try {
      const raw = await llmCall(system, prompt, { mode, history: history || [] });

      if (mode === 'mason') {
        const jsonMatch = (raw || '').match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            return res.json({
              response: parsed.reply || 'Done!',
              css: parsed.css || '',
              actions: [],
            });
          } catch (_) { /* fall through */ }
        }
        return res.json({ response: raw || "I'm here! What should we build?", css: '', actions: [] });
      }

      return res.json({ response: raw || "I'm here! What can I help you with?", actions: [] });
    } catch (err) {
      console.error('Pip LLM error:', err);
      res.status(502).json({ error: `Pip failed: ${err.message}` });
    }
  });

  // ── CSS commit ──

  router.post(prefix + '/commit', async (req, res) => {
    const { css = '' } = req.body;
    if (!css.trim()) {
      return res.status(400).json({ error: 'No CSS to commit' });
    }

    if (!cssFile) {
      return res.json({ ok: true, note: 'No cssFile configured — preview only.' });
    }

    try {
      const newContent = commitCssToFile(cssFile, css);

      let pushed = false;
      let deployed = false;
      if (onCommit) {
        const result = await onCommit(css, newContent);
        pushed = result?.pushed || false;
        deployed = result?.deployed || false;
      }

      res.json({ ok: true, pushed, deployed });
    } catch (err) {
      res.status(500).json({ error: `CSS commit failed: ${err.message}` });
    }
  });

  // ── File access (REST) ──

  router.get(prefix + '/files', (req, res) => {
    if (!projectRoot) {
      return res.status(400).json({ error: 'No projectRoot configured' });
    }
    try {
      res.json({ files: listFiles(projectRoot, req.query.directory || '') });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get(prefix + '/files/*', (req, res) => {
    if (!projectRoot) {
      return res.status(400).json({ error: 'No projectRoot configured' });
    }
    const filePath = req.params[0];
    try {
      res.json({ path: filePath, content: readProjectFile(projectRoot, filePath) });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post(prefix + '/files/*', (req, res) => {
    if (!projectRoot) {
      return res.status(400).json({ error: 'No projectRoot configured' });
    }
    const filePath = req.params[0];
    const { content = '' } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Empty content' });
    }
    try {
      const msg = writeProjectFile(projectRoot, filePath, content);
      res.json({ ok: true, message: msg });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Summarize ──

  router.post(prefix + '/summarize', async (req, res) => {
    if (!requireLlm(res)) return;

    const { history = [] } = req.body;
    if (!history.length) return res.json({ summary: '' });

    const historyText = history.map(m =>
      `${m.role === 'user' ? 'User' : 'Pip'}: ${m.text || ''}`
    ).join('\n');

    try {
      const summary = await llmCall(
        'You are a concise summarizer.',
        'Summarize the following conversation in 3 concise bullet points. '
        + 'Focus on decisions made and actions taken. '
        + "Start with 'Here\\'s what we covered:'.\n\n" + historyText,
        { temperature: 0.2 }
      );
      res.json({ summary: summary || '' });
    } catch (err) {
      console.error('Pip summarize error:', err);
      res.json({ summary: `(Could not summarize: ${err.message})` });
    }
  });

  return router;
}

module.exports = { createPipRouter, SCRIBE_SYSTEM_PROMPT, MASON_SYSTEM_PROMPT };
