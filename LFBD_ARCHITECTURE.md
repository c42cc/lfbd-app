# LFBD Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                    Browser (iOS/Desktop)              │
│                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ AudioMgr │  │ GeminiProv / │  │    app.js       │ │
│  │ + Worklet │──│ GrokProvider │──│ (UI + state)    │ │
│  └────┬─────┘  └──────┬───────┘  └───────┬────────┘ │
│       │ PCM           │ WS               │ REST      │
└───────┼───────────────┼──────────────────┼───────────┘
        │               │                  │
        │     ┌─────────▼────────┐         │
        │     │  Gemini Live API │         │
        │     │  or Grok Voice   │         │
        │     │  (wss://...)     │         │
        │     └──────────────────┘         │
        │                                  │
        │         ┌────────────────────────▼─────┐
        │         │        Express Server         │
        │         │  ┌──────┐  ┌───────────────┐  │
        │         │  │ db.js│  │ providers/*.js │  │
        │         │  └──┬───┘  └───────────────┘  │
        │         │     │                          │
        │         │  ┌──▼───┐                      │
        │         │  │SQLite│                      │
        │         │  └──────┘                      │
        │         └────────────────────────────────┘
        │
  (mic audio never hits the server — direct browser-to-provider WS)
```

Audio flows directly between the browser and the voice provider via WebSocket.
The Express server only handles REST (settings, transcripts, ephemeral tokens, admin).

## Components

### server.js (~130 lines)

Express HTTP server. Three route groups:
- **App routes** — session entry (`/s/:token`), transcript CRUD, settings CRUD, ephemeral token fetch
- **Admin routes** — same data operations behind bearer token auth (`/api/admin/*`)
- **Static** — serves `public/` as-is

### db.js (~110 lines)

SQLite via better-sqlite3. WAL mode. Two tables, five query functions + three admin helpers.

### providers/gemini.js + grok.js (~50 lines total)

Server-side token helpers. Gemini returns `{ token, mode, model, voice }` — the model and voice are configurable via `GEMINI_LIVE_MODEL` and `GEMINI_LIVE_VOICE` env vars so the browser never hardcodes model IDs. Grok calls `POST /v1/realtime/client_secrets` to get an ephemeral token.

### public/gemini-provider.js + grok-provider.js (~200 lines each)

Browser-side WebSocket clients. Identical interface:

```
connect(token, systemPrompt, opts)  → opens WS, sends setup (opts: {model, voice})
sendAudio(base64Pcm)                → streams mic audio to provider
sendText(text)                      → sends text message mid-session
onAudioReceived(callback)           → AI audio chunks for playback
onTranscript(callback)              → user/AI speech transcripts
onThinking(callback)                → Grok reasoning notes (Gemini: no-op)
onStateChange(callback)             → state: connecting/listening/speaking/error/fatal/disconnected
disconnect()                        → closes WS
resetFailures()                     → clears failure counter + fatal lock (for resume)
```

**Failure protection:** Both providers track a failure counter (`MAX_FAILURES = 3`). On WebSocket `onerror` or unclean `onclose`, the counter increments. At 3 failures, the provider enters `"fatal"` state and locks — `connect()` rejects immediately until `resetFailures()` is called by an explicit user action. No automatic reconnection.

### public/audio.js (~155 lines)

`AudioManager` class. Handles mic capture via AudioWorklet + gapless PCM playback + silence detection.

Capture: browser native rate (48kHz) → worklet decimates to target (16kHz Gemini / 24kHz Grok) → base64 → provider.
Playback: base64 PCM → Int16 → Float32 → scheduled AudioBufferSource nodes for gapless output.

**Silence detection:** Computes RMS energy on each PCM chunk. If RMS stays below `NOISE_FLOOR_RMS` (400) for a configurable threshold (default 10s), fires `onSilence` callback once. Audio transmission is squelched after 2s of silence to avoid burning API quota on empty frames. Timer resets when sound is detected.

### public/pcm-processor.js (~35 lines)

AudioWorklet processor. Runs in a separate thread. Decimates from 48kHz to the target rate, accumulates 100ms chunks, posts Int16 PCM buffers to the main thread.

### public/app.js (~950 lines)

All frontend logic. State machine, DOM rendering, API calls, voice session lifecycle (start/pause/resume/end/fatal), history context builder, provider toggle, thinking note renderer, Pip messaging, build mode.

## Data Model

### transcripts

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| session_token | TEXT | Links to user session |
| started_at | TEXT | ISO timestamp |
| ended_at | TEXT | ISO timestamp |
| provider | TEXT | "gemini" or "grok" |
| turns | TEXT | JSON array of `{role, text, ts}` |
| system_prompt | TEXT | Prompt used for this session |
| message_prompt | TEXT | Message prompt used |

Index: `idx_token` on `session_token`.

### settings

| Column | Type | Description |
|---|---|---|
| session_token | TEXT PK | Links to user session |
| system_prompt | TEXT | AI persona instructions |
| message_prompt | TEXT | Auto-injected per-session context |

Default system prompt seeds on first access.

## Voice Pipeline

```
Mic → getUserMedia (48kHz)
    → AudioWorkletNode (pcm-processor.js)
       → decimate to 16kHz (Gemini) or 24kHz (Grok)
       → Int16 PCM chunks (100ms each)
       → postMessage to main thread
    → RMS energy check (NOISE_FLOOR_RMS = 400)
       → if sound: reset silence timer, send chunk
       → if silent > 2s: squelch (skip sending)
       → if silent > 29s: fire onSilence → pause session
    → base64 encode (when not squelched)
    → provider.sendAudio(base64)
    → WebSocket to Gemini/Grok

Provider WS response:
    → onAudioReceived(base64Pcm)
    → AudioManager.playPcmChunk(base64, 24kHz)
       → decode base64 → Int16 → Float32
       → AudioBufferSourceNode scheduled for gapless playback

    → onTranscript({role, text})
       → addTurn() in transcript area

    → onThinking(text) [Grok only]
       → addThinkingNote() — collapsible label
```

## Session Lifecycle

1. User opens `/s/<token>` — server validates UUID format, ensures settings row exists, serves `index.html`
2. `app.js` extracts token from URL, loads settings + transcript history from REST API
3. User taps mic → `startVoiceSession()`:
   a. Fetch ephemeral token + model/voice config from server (`/api/token/gemini` or `/api/token/grok`)
   b. Create provider instance (GeminiProvider or GrokProvider)
   c. Start AudioManager capture at provider's sample rate, wire silence callback
   d. Connect provider WS with system prompt + message prompt + selected history context
   e. Wire callbacks: transcript, thinking, audio, state
4. Conversation runs — audio bidirectional, transcripts accumulate in memory
5. **Silence auto-pause:** if no sound detected for 10s, `pauseVoiceSession()`:
   a. Disconnect provider WS + stop mic capture + stop playback
   b. Turns and session state preserved in memory
   c. Show persistent "Continue" button (fixed, lower-left)
6. User taps Continue → `resumeVoiceSession()`:
   a. Fetch fresh token from server
   b. Create new provider instance, wire callbacks
   c. Build system prompt with accumulated turns as `[Conversation so far]` context
   d. Reconnect WS — conversation continues from where it left off
7. User taps mic during active session → `endVoiceSession()`:
   a. Disconnect provider WS
   b. Stop mic capture + playback
   c. POST accumulated turns to `/api/transcripts/:token`

### Fatal State (3-Strike Abort)

If the WebSocket connection fails 3 times (counted per-provider instance), the provider enters `"fatal"` state:

1. Red persistent error banner shown (not auto-dismissed)
2. Mic and Continue buttons disabled
3. User must dismiss the error, then tap Continue to retry
4. `resetFailures()` clears the lock — fresh 3-strike counter

No exponential backoff, no automatic reconnection, no retry loops.

## Pip Messaging

Pip is a simple async text channel between the app user and a helper engineer.

```
User (browser)                    Engineer (curl/Cursor)
     │                                  │
     │  POST /api/pip/:token            │
     │  {text, sender:"user"}           │
     │──────────────► SQLite ◄──────────│
     │                                  │  GET /api/admin/pip/:token
     │                                  │  POST /api/admin/pip/:token
     │  GET /api/pip/:token?since=...   │  {text, sender:"pip"}
     │◄──────────────────────────────── │
     │  (polls every 3s when open)      │
```

Data model: `pip_messages` table with `id`, `session_token`, `sender` ("user" or "pip"), `text`, `created_at`. Ordered by `created_at ASC`.

The user-facing routes (`/api/pip/*`) require no auth beyond having the session token in the URL. The engineer routes (`/api/admin/pip/*`) require ADMIN_TOKEN bearer auth.

## Build Mode

A CSS-only dark theme toggle. When active, CSS custom properties are overridden on `body.build-mode` to invert the color scheme (dark background, light text, muted green accent). No functional difference — it's a visual signal that the user is in a configuration mindset.

Toggled via a button inside the Pip panel. State is not persisted (resets on page reload).

## Security Model

- **Session access**: UUID in URL is the sole credential. No login, no cookies. Anyone with the link has access.
- **Admin API**: Bearer token auth via `ADMIN_TOKEN` env var. All `/api/admin/*` routes require it.
- **Provider tokens**: Gemini uses the API key directly in WS URL. Grok uses server-generated ephemeral tokens (short-lived, browser-safe).
- **Data at rest**: SQLite on server filesystem. No encryption. Secured by hosting provider access controls.

## Design Decisions

- **No build step.** Vanilla HTML/CSS/JS. Files served as-is from `public/`.
- **No frontend framework.** DOM manipulation, event listeners, fetch calls. ~550 lines total.
- **No authentication system.** UUID-as-access-control for a single-user app.
- **No WebSocket proxy.** Audio goes browser → provider directly. Server only does REST + token fetch.
- **SQLite for storage.** Single file, zero ops, perfect for single-user persistent data.
- **Two provider files, one interface.** Adding a third provider means implementing 7 methods.
