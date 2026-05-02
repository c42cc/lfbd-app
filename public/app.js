// LFBD — Main application logic

(function () {
  'use strict';

  // -- State --
  const state = {
    token: null,
    provider: 'gemini',         // 'gemini' | 'grok'
    activeSession: null,        // { id, provider, startedAt, turns, voiceProvider, systemPrompt, messagePrompt }
    settings: { system_prompt: '', message_prompt: '' },
    selectedTranscriptIds: new Set(),
    transcripts: []
  };

  // -- Extract token from URL path /s/:token --
  function getToken() {
    const m = window.location.pathname.match(/\/s\/([a-f0-9-]{36})/i);
    return m ? m[1] : null;
  }

  // -- DOM helpers --
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function toggle(el) { el.classList.toggle('hidden'); }

  function showToast(msg, duration = 3000) {
    const toast = $('#toast');
    toast.textContent = msg;
    show(toast);
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => hide(toast), duration);
  }

  // -- Transcript rendering --
  function addTurn(role, text) {
    const container = $('#transcript-turns');
    const empty = $('#transcript-empty');
    if (empty) hide(empty);

    const div = document.createElement('div');
    div.className = `turn turn-${role}`;

    const label = document.createElement('span');
    label.className = 'turn-label';
    label.textContent = role === 'user' ? 'You' : 'AI';

    const content = document.createElement('span');
    content.textContent = text;

    div.appendChild(label);
    div.appendChild(content);
    container.appendChild(div);

    // auto-scroll
    const area = $('#transcript-area');
    area.scrollTop = area.scrollHeight;

    return div;
  }

  function addThinkingNote(text) {
    const container = $('#transcript-turns');
    const empty = $('#transcript-empty');
    if (empty) hide(empty);

    const boldMatch = text.match(/\*\*(.+?)\*\*/);
    const label = boldMatch ? boldMatch[1] : 'Thinking...';
    const body = text.replace(/\*\*(.+?)\*\*/g, '').trim();

    const wrapper = document.createElement('div');
    wrapper.className = 'thinking-note collapsed';

    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.textContent = label;
    header.addEventListener('click', () => {
      wrapper.classList.toggle('collapsed');
    });

    const content = document.createElement('div');
    content.className = 'thinking-body';
    content.textContent = body;

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    container.appendChild(wrapper);

    const area = $('#transcript-area');
    area.scrollTop = area.scrollHeight;
  }

  function clearTranscript() {
    $('#transcript-turns').innerHTML = '';
    show($('#transcript-empty'));
  }

  function renderTranscript(turns) {
    clearTranscript();
    if (turns && turns.length > 0) {
      turns.forEach(t => addTurn(t.role, t.text));
    }
  }

  // -- Voice status --
  function setVoiceStatus(text) {
    if (text) {
      $('#voice-status-text').textContent = text;
      show($('#voice-status'));
    } else {
      hide($('#voice-status'));
    }
  }

  // -- Retry helper --
  async function withRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // -- API calls --
  async function api(method, path, body) {
    return withRetry(async () => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const resp = await fetch(path, opts);
      if (!resp.ok) {
        let detail = `API error ${resp.status}`;
        try {
          const errBody = await resp.json();
          if (errBody.error) detail = errBody.error;
        } catch (_) {}
        throw new Error(detail);
      }
      return resp.json();
    });
  }

  async function loadSettings() {
    state.settings = await api('GET', `/api/settings/${state.token}`);
    $('#setting-system-prompt').value = state.settings.system_prompt || '';
    $('#setting-message-prompt').value = state.settings.message_prompt || '';
  }

  async function saveSettings() {
    const data = {
      system_prompt: $('#setting-system-prompt').value,
      message_prompt: $('#setting-message-prompt').value
    };
    await api('PUT', `/api/settings/${state.token}`, data);
    state.settings = data;
    hide($('#settings-modal'));
    showToast('Settings saved');
  }

  async function loadTranscripts() {
    state.transcripts = await api('GET', `/api/transcripts/${state.token}`);
    renderHistoryList();
  }

  async function deleteTranscript(id) {
    await api('DELETE', `/api/transcripts/${state.token}/${id}`);
    state.selectedTranscriptIds.delete(id);
    await loadTranscripts();
  }

  async function saveCurrentTranscript() {
    if (!state.activeSession || state.activeSession.turns.length === 0) return;
    const s = state.activeSession;
    await api('POST', `/api/transcripts/${state.token}`, {
      started_at: s.startedAt,
      ended_at: new Date().toISOString(),
      provider: s.provider,
      turns: s.turns,
      system_prompt: s.systemPrompt || null,
      message_prompt: s.messagePrompt || null
    });
    await loadTranscripts();
  }

  // -- Theme overrides (persisted by engineer via admin API) --
  async function loadTheme() {
    try {
      const overrides = await api('GET', `/api/theme/${state.token}`);
      applyTheme(overrides);
    } catch (_) {}
  }

  function applyTheme(overrides) {
    if (!overrides || typeof overrides !== 'object') return;
    const root = document.documentElement;
    const map = {
      bg: '--bg',
      bg_secondary: '--bg-secondary',
      accent: '--accent',
      accent_hover: '--accent-hover',
      text: '--text',
      text_muted: '--text-muted',
      rose: '--rose'
    };
    for (const [key, cssVar] of Object.entries(map)) {
      if (overrides[key]) {
        root.style.setProperty(cssVar, overrides[key]);
      }
    }
  }

  // -- History rendering --
  function renderHistoryList() {
    const list = $('#history-list');
    const empty = $('#history-empty');
    list.innerHTML = '';

    if (state.transcripts.length === 0) {
      show(empty);
      return;
    }
    hide(empty);

    state.transcripts.forEach(t => {
      const turns = Array.isArray(t.turns) ? t.turns : JSON.parse(t.turns || '[]');
      const date = new Date(t.started_at);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

      const item = document.createElement('div');
      item.className = 'history-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selectedTranscriptIds.has(t.id);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedTranscriptIds.add(t.id);
        else state.selectedTranscriptIds.delete(t.id);
      });

      const info = document.createElement('div');
      info.className = 'history-item-info';
      info.innerHTML = `
        <div class="history-item-date">${dateStr}</div>
        <div class="history-item-meta">${t.provider} · ${turns.length} turns</div>
      `;
      info.addEventListener('click', () => {
        renderTranscript(turns);
        hide($('#history-panel'));
        $('#btn-history').classList.remove('active');
      });
      info.style.cursor = 'pointer';

      const del = document.createElement('button');
      del.className = 'history-item-delete';
      del.textContent = '×';
      del.title = 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTranscript(t.id);
      });

      item.appendChild(cb);
      item.appendChild(info);
      item.appendChild(del);
      list.appendChild(item);
    });
  }

  // -- Context building for history injection --
  function buildContextFromSelected() {
    const selected = state.transcripts.filter(t => state.selectedTranscriptIds.has(t.id));
    if (selected.length === 0) return '';

    let totalWords = 0;
    const MAX_WORDS = 4000;
    const chunks = [];

    for (const t of selected) {
      const turns = Array.isArray(t.turns) ? t.turns : JSON.parse(t.turns || '[]');
      const date = new Date(t.started_at);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      let chunk = `[Previous conversation from ${dateStr}]\n`;
      for (const turn of turns) {
        const role = turn.role === 'user' ? 'User' : 'Assistant';
        const line = `${role}: ${turn.text}\n`;
        const words = line.split(/\s+/).length;
        if (totalWords + words > MAX_WORDS) {
          chunk += '[Earlier portion omitted for brevity]\n';
          break;
        }
        chunk += line;
        totalWords += words;
      }
      chunk += '[End of previous conversation]\n\n';
      chunks.push(chunk);
      if (totalWords >= MAX_WORDS) break;
    }

    return chunks.join('');
  }

  // -- Voice session management --
  let audioManager = null;

  async function startVoiceSession() {
    if (state.activeSession) {
      await endVoiceSession();
      return;
    }

    try {
      setVoiceStatus('Connecting...');
      $('#btn-new-chat').classList.add('recording');
      clearTranscript();
      hide($('#transcript-empty'));

      const systemPrompt = state.settings.system_prompt || '';
      const messagePrompt = state.settings.message_prompt || '';
      const context = buildContextFromSelected();

      let fullSystemPrompt = systemPrompt;
      if (messagePrompt) fullSystemPrompt += '\n\n' + messagePrompt;
      if (context) fullSystemPrompt += '\n\n' + context;

      // Get ephemeral token
      const tokenResp = await api('GET', `/api/token/${state.provider}`);
      if (!tokenResp.token) throw new Error('Failed to get provider token');

      // Create provider
      let voiceProvider;
      let inputSampleRate;

      if (state.provider === 'gemini') {
        voiceProvider = new GeminiProvider();
        inputSampleRate = 16000;
      } else {
        voiceProvider = new GrokProvider();
        inputSampleRate = 24000;
      }

      state.activeSession = {
        id: crypto.randomUUID(),
        provider: state.provider,
        startedAt: new Date().toISOString(),
        turns: [],
        voiceProvider,
        systemPrompt,
        messagePrompt
      };

      // Set up provider callbacks
      voiceProvider.onStateChange((status) => {
        const labels = {
          connecting: 'Connecting...',
          listening: 'Listening...',
          speaking: 'AI speaking...',
          processing: 'Processing...',
          error: 'Error',
          disconnected: null
        };
        setVoiceStatus(labels[status] || status);
      });

      voiceProvider.onTranscript(({ role, text }) => {
        if (!text || !text.trim()) return;
        if (!state.activeSession) return;
        addTurn(role, text);
        state.activeSession.turns.push({
          role,
          text,
          ts: new Date().toISOString()
        });
      });

      voiceProvider.onThinking((text) => {
        if (!text || !text.trim()) return;
        addThinkingNote(text);
      });

      voiceProvider.onAudioReceived((base64Pcm) => {
        if (audioManager) {
          audioManager.playPcmChunk(base64Pcm, 24000);
        }
      });

      // Start audio capture
      audioManager = new AudioManager();
      await audioManager.startCapture(inputSampleRate, (base64Pcm) => {
        if (state.activeSession && state.activeSession.voiceProvider) {
          state.activeSession.voiceProvider.sendAudio(base64Pcm);
        }
      });

      // Connect to provider
      await voiceProvider.connect(tokenResp.token, fullSystemPrompt);

      // Auto-reconnect on unexpected WS close
      voiceProvider._origOnClose = voiceProvider.ws?.onclose;
      const origWs = voiceProvider.ws;
      if (origWs) {
        const origOnClose = origWs.onclose;
        origWs.onclose = async (ev) => {
          if (origOnClose) origOnClose.call(origWs, ev);
          if (state.activeSession && state.activeSession.voiceProvider === voiceProvider && !ev.wasClean) {
            showToast('Connection lost. Reconnecting...', 5000);
            try {
              await withRetry(async () => {
                const newToken = await api('GET', `/api/token/${state.activeSession.provider}`);
                await voiceProvider.connect(newToken.token, fullSystemPrompt);
              });
              showToast('Reconnected');
            } catch (retryErr) {
              showToast('Connection lost. Tap mic to retry.');
              await endVoiceSession();
            }
          }
        };
      }

    } catch (err) {
      console.error('Failed to start voice session:', err);
      let msg = err.message;
      if (err.name === 'NotAllowedError' || err.message.includes('Permission')) {
        msg = 'Microphone permission denied. Please allow mic access and try again.';
      } else if (err.name === 'NotFoundError') {
        msg = 'No microphone found. Please connect a mic and try again.';
      }
      showToast(msg, 5000);
      setVoiceStatus(null);
      $('#btn-new-chat').classList.remove('recording');
      state.activeSession = null;
    }
  }

  async function endVoiceSession() {
    if (!state.activeSession) return;

    const session = state.activeSession;
    state.activeSession = null;

    if (session.voiceProvider) session.voiceProvider.disconnect();
    if (audioManager) {
      audioManager.stopCapture();
      audioManager.stopPlayback();
      audioManager = null;
    }

    setVoiceStatus(null);
    $('#btn-new-chat').classList.remove('recording');

    if (session.turns && session.turns.length > 0) {
      try {
        await api('POST', `/api/transcripts/${state.token}`, {
          started_at: session.startedAt,
          ended_at: new Date().toISOString(),
          provider: session.provider,
          turns: session.turns,
          system_prompt: session.systemPrompt || null,
          message_prompt: session.messagePrompt || null
        });
        await loadTranscripts();
        showToast('Conversation saved');
      } catch (err) {
        console.error('Failed to save transcript:', err);
        showToast('Failed to save conversation');
      }
    }
  }

  function sendTextMessage() {
    const input = $('#text-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    if (state.activeSession && state.activeSession.voiceProvider) {
      state.activeSession.voiceProvider.sendText(text);
      addTurn('user', text);
      state.activeSession.turns.push({
        role: 'user',
        text,
        ts: new Date().toISOString()
      });
    } else {
      showToast('Start a voice session first');
    }
  }

  // -- Provider toggle --
  function setProvider(provider) {
    state.provider = provider;
    $$('.provider-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.provider === provider);
    });
  }

  // -- Event wiring --
  function init() {
    state.token = getToken();
    if (!state.token) {
      const area = $('#transcript-area');
      area.innerHTML = '<div class="empty-state"><p>Invalid session link. Please use the link you were given.</p></div>';
      return;
    }

    // Settings modal
    $('#btn-settings').addEventListener('click', () => show($('#settings-modal')));
    $('#btn-close-settings').addEventListener('click', () => hide($('#settings-modal')));
    $('#btn-save-settings').addEventListener('click', saveSettings);
    $('#settings-modal').addEventListener('click', (e) => {
      if (e.target === $('#settings-modal')) hide($('#settings-modal'));
    });

    // Bottom bar toggles
    $('#btn-history').addEventListener('click', () => {
      hide($('#text-input-panel'));
      $('#btn-text').classList.remove('active');
      toggle($('#history-panel'));
      $('#btn-history').classList.toggle('active');
    });

    $('#btn-text').addEventListener('click', () => {
      hide($('#history-panel'));
      $('#btn-history').classList.remove('active');
      toggle($('#text-input-panel'));
      $('#btn-text').classList.toggle('active');
      if (!$('#text-input-panel').classList.contains('hidden')) {
        $('#text-input').focus();
      }
    });

    // Text input
    $('#btn-send-text').addEventListener('click', sendTextMessage);
    $('#text-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendTextMessage();
    });

    // New chat / stop
    $('#btn-new-chat').addEventListener('click', startVoiceSession);

    // Provider toggle
    $$('.provider-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const prov = btn.dataset.provider;
        if (state.activeSession && state.activeSession.provider !== prov) {
          endVoiceSession().then(() => setProvider(prov));
        } else {
          setProvider(prov);
        }
      });
    });

    // Toast dismiss
    $('#toast').addEventListener('click', () => hide($('#toast')));

    // Load initial data
    loadSettings();
    loadTranscripts();
    loadTheme();
  }

  // -- Pip messaging --
  let pipPollTimer = null;
  let pipLastSeen = null;

  function initPip() {
    if (!state.token) return;

    const fab = document.getElementById('btn-pip');
    const panel = document.getElementById('pip-panel');
    const closeBtn = document.getElementById('btn-pip-close');
    const sendBtn = document.getElementById('btn-pip-send');
    const input = document.getElementById('pip-input');
    const buildBtn = document.getElementById('btn-build-mode');

    fab.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        loadPipMessages();
        startPipPolling();
        input.focus();
      } else {
        stopPipPolling();
      }
    });

    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      stopPipPolling();
    });

    sendBtn.addEventListener('click', sendPipMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendPipMessage();
    });

    buildBtn.addEventListener('click', () => {
      document.body.classList.toggle('build-mode');
      buildBtn.textContent = document.body.classList.contains('build-mode')
        ? 'Exit Build Mode' : 'Build Mode';
    });

    const setBtn = document.getElementById('btn-pip-set');
    if (setBtn) {
      setBtn.addEventListener('click', commitPipChanges);
    }
  }

  async function loadPipMessages() {
    try {
      const msgs = await api('GET', `/api/pip/${state.token}`);
      renderPipMessages(msgs);
      if (msgs.length > 0) {
        pipLastSeen = msgs[msgs.length - 1].created_at;
      }
    } catch (err) {
      console.error('Failed to load pip messages:', err);
    }
  }

  async function pollPipMessages() {
    try {
      const url = pipLastSeen
        ? `/api/pip/${state.token}?since=${encodeURIComponent(pipLastSeen)}`
        : `/api/pip/${state.token}`;
      const msgs = await api('GET', url);
      if (msgs.length > 0) {
        appendPipMessages(msgs);
        pipLastSeen = msgs[msgs.length - 1].created_at;
      }
    } catch (_) {}
  }

  function startPipPolling() {
    stopPipPolling();
    pipPollTimer = setInterval(pollPipMessages, 3000);
  }

  function stopPipPolling() {
    if (pipPollTimer) { clearInterval(pipPollTimer); pipPollTimer = null; }
  }

  function renderPipMessages(msgs) {
    const container = document.getElementById('pip-messages');
    container.innerHTML = '';
    msgs.forEach(m => appendPipMessage(m));
  }

  function appendPipMessages(msgs) {
    msgs.forEach(m => appendPipMessage(m));
  }

  function appendPipMessage(m) {
    const container = document.getElementById('pip-messages');
    const div = document.createElement('div');
    div.className = `pip-msg pip-msg-${m.sender}`;
    div.textContent = m.text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  async function sendPipMessage() {
    const input = document.getElementById('pip-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    const isBuild = document.body.classList.contains('build-mode');
    const body = isBuild ? { text, mode: 'build' } : { text, mode: 'chat' };

    stopPipPolling();

    try {
      const resp = await api('POST', `/api/pip/${state.token}`, body);

      const msgs = resp.messages || [resp];
      msgs.forEach(m => appendPipMessage(m));
      const last = msgs[msgs.length - 1];
      if (last && last.created_at) pipLastSeen = last.created_at;

      if (resp.preview && resp.preview.css) {
        injectPreviewCSS(resp.preview.css);
        showSetButton();
      }
    } catch (err) {
      showToast('Failed to send message');
    }

    startPipPolling();
  }

  function injectPreviewCSS(css) {
    // Exit build mode so the preview colors aren't overridden by the dark theme
    document.body.classList.remove('build-mode');
    const buildBtn = document.getElementById('btn-build-mode');
    if (buildBtn) buildBtn.textContent = 'Build Mode';

    let tag = document.getElementById('pip-preview-css');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'pip-preview-css';
      document.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  function showSetButton() {
    const btn = document.getElementById('btn-pip-set');
    if (btn) btn.classList.remove('hidden');
  }

  async function commitPipChanges() {
    const btn = document.getElementById('btn-pip-set');
    if (btn) {
      btn.textContent = 'Deploying...';
      btn.disabled = true;
    }
    try {
      await api('POST', `/api/pip/${state.token}/set`);
      appendPipMessage({ sender: 'pip', text: 'Changes are now permanent! The app will redeploy in about a minute.' });
      if (btn) btn.classList.add('hidden');
    } catch (err) {
      showToast('Deploy failed: ' + err.message);
    } finally {
      if (btn) {
        btn.textContent = 'Set';
        btn.disabled = false;
      }
    }
  }

  // -- Welcome overlay --
  function initWelcome() {
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;
    if (localStorage.getItem('lfbd-welcomed')) {
      overlay.remove();
      return;
    }
    document.getElementById('btn-welcome-start').addEventListener('click', () => {
      localStorage.setItem('lfbd-welcomed', '1');
      overlay.classList.add('dismissed');
      setTimeout(() => overlay.remove(), 400);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initWelcome(); init(); initPip(); });
  } else {
    initWelcome();
    init();
    initPip();
  }
})();
