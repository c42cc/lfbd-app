/**
 * Pip UI — self-contained vanilla JS drop-in component.
 *
 * Usage:
 *   <script src="/pip-ui.js"></script>
 *   <script>PipUI.init({ apiBaseUrl: '/api/pip' });</script>
 *
 * Mirrors the API contract of the shared Pip.tsx React component.
 */

const PipUI = (function () {
  'use strict';

  // ── State ──
  let _open = false;
  let _messages = [];
  let _mode = 'scribe';
  let _loading = false;
  let _previewCss = null;
  let _previewStyle = null;
  let _msgId = 0;
  let _opts = {};

  // ── Colors (match Pip.tsx) ──
  const C = {
    accent: '#C4A44A',
    bg: '#F5F0E8',
    bgRaised: '#FAF7F2',
    text: '#2C2A26',
    textSec: '#6B6560',
    textTer: '#9B9590',
    border: '#DDD5C8',
    accentHover: 'rgba(196,164,74,0.15)',
    masonBg: '#2C2A26',
    masonText: '#F5F0E8',
    masonTextSec: '#9B9590',
    masonBorder: '#4A4640',
    masonInput: '#3A3732',
  };

  function mkMsg(role, text) {
    return { id: ++_msgId, role, text };
  }

  // ── DOM creation ──

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && typeof v === 'object') {
          Object.assign(e.style, v);
        } else if (k.startsWith('on') && typeof v === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          e.setAttribute(k, v);
        }
      }
    }
    for (const child of children) {
      if (typeof child === 'string') e.appendChild(document.createTextNode(child));
      else if (child) e.appendChild(child);
    }
    return e;
  }

  // ── API helpers ──

  async function pipFetch(path, opts = {}) {
    const base = _opts.apiBaseUrl || '/api/pip';
    const resp = await fetch(base + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || err.detail || resp.statusText);
    }
    return resp.json();
  }

  // ── Core actions ──

  async function sendMessage(text) {
    if (!text.trim()) return;
    _messages.push(mkMsg('user', text));
    _loading = true;
    render();

    try {
      const data = await pipFetch('/text', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          mode: _mode,
          history: _messages.map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            text: m.text,
          })),
        }),
      });

      const msg = mkMsg('pip', data.response || 'Done!');
      _messages.push(msg);

      if (data.css) {
        _previewCss = data.css;
        injectPreview(data.css);
      }
    } catch (err) {
      _messages.push(mkMsg('pip', `Something went wrong: ${err.message}`));
    } finally {
      _loading = false;
      render();
    }
  }

  async function commitCss() {
    if (!_previewCss) return;
    try {
      const data = await pipFetch('/commit', {
        method: 'POST',
        body: JSON.stringify({ css: _previewCss }),
      });
      _previewCss = null;
      _mode = 'scribe';
      _messages.push(mkMsg('pip', data.note || 'CSS saved. Changes will persist on refresh.'));
    } catch (err) {
      _messages.push(mkMsg('pip', `Deploy failed: ${err.message}`));
    }
    render();
  }

  function revertCss() {
    if (_previewStyle) {
      _previewStyle.remove();
      _previewStyle = null;
    }
    _previewCss = null;
    render();
  }

  function clearHistory() {
    _messages = [mkMsg('system', 'Conversation cleared. Pip is ready for a fresh start.')];
    revertCss();
    render();
  }

  function injectPreview(css) {
    if (!_previewStyle) {
      _previewStyle = document.createElement('style');
      _previewStyle.id = 'pip-preview-css';
      document.head.appendChild(_previewStyle);
    }
    _previewStyle.textContent = css;
  }

  // ── Rendering ──

  let _root = null;
  let _fab = null;

  function render() {
    if (!_open) {
      if (_root) { _root.remove(); _root = null; }
      if (!_fab) createFab();
      _fab.style.display = 'flex';
      return;
    }

    if (_fab) _fab.style.display = 'none';
    if (_root) _root.remove();

    const isMason = _mode === 'mason';
    const bg = isMason ? C.masonBg : C.bgRaised;
    const fg = isMason ? C.masonText : C.text;
    const fgSec = isMason ? C.masonTextSec : C.textSec;
    const bdr = isMason ? C.masonBorder : C.border;
    const inputBg = isMason ? C.masonInput : C.bg;

    const panel = el('div', {
      role: 'dialog',
      'aria-label': 'Pip assistant',
      style: {
        position: 'fixed', bottom: '16px', right: '16px',
        width: '340px', height: '60vh', minHeight: '300px', maxHeight: '80vh',
        zIndex: '9999', borderRadius: '12px 12px 0 12px',
        display: 'flex', flexDirection: 'column',
        background: bg, border: `1px solid ${bdr}`,
        boxShadow: isMason ? '0 2px 16px rgba(0,0,0,0.3)' : '0 2px 12px rgba(44,42,38,0.08)',
        color: fg, fontFamily: 'system-ui, -apple-system, sans-serif',
        animation: 'pipSlideIn 250ms ease-out',
      },
    });

    // Header
    const modeBtn = el('button', {
      style: {
        fontSize: '11px', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase',
        color: isMason ? C.masonText : C.textSec,
        background: isMason ? 'rgba(196,164,74,0.25)' : C.accentHover,
        border: 'none', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer',
      },
      onClick: () => { _mode = isMason ? 'scribe' : 'mason'; render(); },
    }, isMason ? 'Mason' : 'Scribe');

    const resetBtn = el('button', {
      style: { background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', color: fgSec },
      title: 'Clear history & restart',
      onClick: clearHistory,
    }, '\u21BA');

    const closeBtn = el('button', {
      style: { background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', color: C.textTer },
      onClick: () => { _open = false; if (_previewCss) revertCss(); _mode = 'scribe'; render(); },
    }, '\u2715');

    const header = el('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: `1px solid ${bdr}`, flexShrink: '0',
      },
    },
      el('span', { style: { fontWeight: '700', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.1em', color: C.accent } }, 'Pip'),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, modeBtn, resetBtn, closeBtn),
    );
    panel.appendChild(header);

    // Messages
    const msgArea = el('div', { style: { flex: '1', overflowY: 'auto', padding: '10px 12px' } });
    for (const msg of _messages) {
      const isUser = msg.role === 'user';
      const isSystem = msg.role === 'system';
      const bubble = el('div', {
        style: { marginBottom: '8px', textAlign: isUser ? 'right' : 'left' },
      },
        el('span', {
          style: {
            display: 'inline-block', maxWidth: '88%', padding: '6px 10px', borderRadius: '8px',
            fontSize: '13.5px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
            background: isUser
              ? (isMason ? 'rgba(196,164,74,0.2)' : C.accentHover)
              : (isMason ? C.masonInput : C.bg),
            color: isSystem ? fgSec : fg,
            fontStyle: isSystem ? 'italic' : 'normal',
          },
        }, msg.text),
      );
      msgArea.appendChild(bubble);
    }
    if (_loading) {
      msgArea.appendChild(el('div', { style: { fontStyle: 'italic', fontSize: '13px', color: C.textTer } }, 'Pip is thinking\u2026'));
    }

    if (_messages.length === 1 && _messages[0].role === 'pip') {
      const suggestions = el('div', { style: { marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '4px' } });
      ['What can you do?', 'Show me the file tree', 'Change the accent color'].forEach(s => {
        suggestions.appendChild(el('button', {
          style: {
            fontSize: '11.5px', fontStyle: 'italic', color: C.accent,
            background: isMason ? 'rgba(196,164,74,0.15)' : C.accentHover,
            border: 'none', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer',
          },
          onClick: () => sendMessage(s),
        }, s));
      });
      msgArea.appendChild(suggestions);
    }
    panel.appendChild(msgArea);
    setTimeout(() => { msgArea.scrollTop = msgArea.scrollHeight; }, 0);

    // CSS preview actions
    if (_previewCss) {
      const cssActions = el('div', { style: { display: 'flex', gap: '6px', padding: '6px 12px', borderTop: `1px solid ${bdr}`, flexShrink: '0' } });
      cssActions.appendChild(el('button', {
        style: {
          flex: '1', fontSize: '12px', fontWeight: '600', color: C.bg, background: C.accent,
          border: 'none', borderRadius: '6px', padding: '5px 0', cursor: 'pointer',
        },
        onClick: commitCss,
      }, 'Set'));
      cssActions.appendChild(el('button', {
        style: {
          flex: '1', fontSize: '12px', color: fgSec, background: 'none',
          border: `1px solid ${bdr}`, borderRadius: '6px', padding: '5px 0', cursor: 'pointer',
        },
        onClick: revertCss,
      }, 'Revert'));
      panel.appendChild(cssActions);
    }

    // Input
    const inputEl = el('input', {
      style: {
        flex: '1', fontSize: '13.5px', padding: '5px 8px', borderRadius: '6px',
        border: `1px solid ${bdr}`, background: inputBg,
        color: fg, outline: 'none', fontFamily: 'system-ui, -apple-system, sans-serif',
      },
      placeholder: 'Ask Pip anything\u2026',
    });

    const sendBtn = el('button', {
      style: {
        fontSize: '14px', fontWeight: '600', padding: '5px 10px', borderRadius: '6px',
        border: 'none', background: C.accent, color: C.bg, cursor: 'pointer',
      },
      onClick: () => { sendMessage(inputEl.value); inputEl.value = ''; },
    }, '\u2192');

    const form = el('div', { style: { display: 'flex', gap: '6px' } }, inputEl, sendBtn);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sendMessage(inputEl.value); inputEl.value = ''; }
    });

    panel.appendChild(el('div', { style: { padding: '6px 10px', borderTop: `1px solid ${bdr}`, flexShrink: '0' } }, form));

    // Esc to close
    panel.tabIndex = -1;
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { _open = false; if (_previewCss) revertCss(); _mode = 'scribe'; render(); }
    });

    document.body.appendChild(panel);
    _root = panel;
    inputEl.focus();
  }

  function createFab() {
    _fab = el('button', {
      'aria-label': 'Open Pip assistant',
      title: 'Pip',
      style: {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '9999',
        width: '40px', height: '40px', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.accent, border: 'none', cursor: 'pointer',
        boxShadow: '0 2px 12px rgba(44,42,38,0.12)',
        transition: 'transform 150ms ease',
        fontFamily: 'serif', fontStyle: 'italic',
        fontSize: '18px', color: C.bg, fontWeight: '400',
      },
      onClick: () => {
        _open = true;
        if (_messages.length === 0) {
          _messages.push(mkMsg('pip', "Hey! I'm Pip, your AI co-pilot. I can tweak the UI, read your code, answer questions \u2014 just ask."));
        }
        render();
      },
      onMouseenter: (e) => { e.currentTarget.style.transform = 'scale(1.08)'; },
      onMouseleave: (e) => { e.currentTarget.style.transform = 'scale(1)'; },
    }, 'p');
    document.body.appendChild(_fab);
  }

  function ensureKeyframes() {
    if (document.getElementById('pip-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'pip-keyframes';
    style.textContent = `
      @keyframes pipSlideIn {
        from { opacity: 0; transform: scale(0.92) translateY(16px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Public API ──

  function init(opts = {}) {
    _opts = opts;
    ensureKeyframes();
    createFab();
  }

  function destroy() {
    if (_root) { _root.remove(); _root = null; }
    if (_fab) { _fab.remove(); _fab = null; }
    if (_previewStyle) { _previewStyle.remove(); _previewStyle = null; }
    _messages = [];
    _open = false;
  }

  return { init, destroy };
})();
