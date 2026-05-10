# LFBD — Implementation Plan

**Purpose:** A single-user voice AI companion for trauma recovery support. The user opens a link, talks to an AI agent via native voice (no STT/TTS pipeline — both providers handle audio natively end-to-end), and the app stores transcripts between sessions.

**Name:** LFBD

---

## 1. What This Is

A one-page web app that connects the user's microphone directly to either Gemini Live API or Grok Voice Agent API. Both APIs accept raw audio in and produce raw audio out — the model itself "hears" and "speaks" natively. No separate speech-to-text or text-to-speech services are involved. Both APIs also return text transcripts of the conversation alongside the audio, which the app captures and stores.

The user receives a unique URL (e.g., `https://lfbd.example.com/s/abc123`). Bookmarkable. No login. The token in the URL identifies their session store on the backend.

---

## 2. Architecture Overview

```
┌─────────────────────────────────┐
│         Browser (Frontend)       │
│                                  │
│  Mic ──→ PCM capture ──→ WS ────┼──→  Backend (Node.js)
│  Speaker ←── audio playback ←───┼──←  
│  Transcript display              │     │
│  Bottom bar (settings, history)  │     │  WebSocket proxy
└─────────────────────────────────┘     │  (hides API keys)
                                        │
                          ┌─────────────┴──────────────┐
                          │                            │
                    Gemini Live API            Grok Voice Agent API
                    (WebSocket)               (WebSocket)
                    wss://generative          wss://api.x.ai/v1/
                    language.googleapis       realtime?model=
                    .com/...                  grok-voice-think-fast-1.0
```

**Three processes:**

1. **Frontend** — captures mic audio, streams it to the backend via WebSocket, plays back received audio, renders transcript.
2. **Backend** — Node.js server. Proxies audio between the browser and the selected provider's WebSocket API. Holds API keys server-side (never exposed to browser). Stores transcripts in SQLite. Serves the frontend static files.
3. **Provider APIs** — Gemini or Grok. Handle all "understanding" and "speaking" natively. Return audio + text transcript events.

---

## 3. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Vanilla HTML + CSS + JS (no framework) | Maximum simplicity. One HTML file, one JS file, one CSS file. No build step needed. |
| Backend | Node.js + Express + `ws` library | Lightweight. Native WebSocket support. Easy to deploy. |
| Database | SQLite via `better-sqlite3` | Zero-config. Single file. Sufficient for one user's transcripts. |
| Deployment | Fly.io | Docker-based deploy with persistent volumes. HTTPS + custom domain. |
| Audio | Web Audio API + AudioWorklet | Browser-native mic capture and audio playback. No external libraries. |

---

## 4. Data Model (SQLite)

```sql
-- One table. That's it.
CREATE TABLE transcripts (
  id          TEXT PRIMARY KEY,        -- UUID
  session_token TEXT NOT NULL,          -- The unique user token from the URL
  started_at  TEXT NOT NULL,            -- ISO timestamp
  ended_at    TEXT,                     -- ISO timestamp (null if in progress)
  provider    TEXT NOT NULL,            -- "gemini" or "grok"
  turns       TEXT NOT NULL DEFAULT '[]', -- JSON array of {role, text, timestamp}
  system_prompt TEXT,                   -- System prompt used for this session
  message_prompt TEXT                   -- Auto-injected message prompt used
);

CREATE INDEX idx_transcripts_token ON transcripts(session_token);
```

**Turns format:**
```json
[
  {"role": "user", "text": "I've been having trouble sleeping since the accident.", "ts": "2026-05-01T10:00:01Z"},
  {"role": "assistant", "text": "That's really common after what you've been through...", "ts": "2026-05-01T10:00:04Z"}
]
```

---

## 5. API Key Handling

API keys are stored as environment variables on the deployment platform (Fly.io). They never leave the server.

```
GOOGLE_AI_STUDIO_API_KEY=AIza...
XAI_API_KEY=xai-...
```

The backend reads these at startup. The frontend never sees them. The backend's WebSocket proxy authenticates with the provider on behalf of the browser.

**For Gemini:** The backend either proxies the full WebSocket connection, or (preferred) uses the ephemeral token pattern — the backend requests a short-lived token from Gemini using the real API key, hands that token to the frontend, and the frontend connects directly to Gemini. This reduces backend load. The token expires in minutes and is scoped.

**For Grok:** Same ephemeral token pattern. The backend calls `POST https://api.x.ai/v1/realtime/client_secrets` with the real API key to get a scoped ephemeral token, passes it to the frontend, and the frontend connects directly to `wss://api.x.ai/v1/realtime`.

**Fallback:** If ephemeral tokens prove unreliable during development, fall back to full server-side WebSocket proxying. Both work. Ephemeral tokens are cleaner.

---

## 6. Frontend — Screen Layout

### 6.1 Full-Page Structure

```
┌──────────────────────────────────────────────┐
│                    LFBD                [⚙]   │  ← Tiny header. Name left, gear icon right.
│                                              │     Gear opens system/message prompt editor.
│                                              │
│                                              │
│           ┌──────────────────┐               │
│           │                  │               │
│           │   Transcript     │               │  ← Scrollable 2-way transcript.
│           │   area           │               │     User turns left-aligned, muted color.
│           │                  │               │     AI turns right-aligned.
│           │                  │               │     Auto-scrolls to bottom.
│           │                  │               │
│           │                  │               │
│           └──────────────────┘               │
│                                              │
│              ◉ Speaking...                   │  ← Voice status indicator (pulsing dot)
│                                              │
├──────────────────────────────────────────────┤
│  [🎙 New Chat]  [📝 History]  [💬 Text]     │  ← Bottom bar. Three toggle buttons.
│                                              │
│  ┌─ Text input (collapsed by default) ─────┐│
│  │ [Type or drop file here...]    [Send]    ││  ← Only visible when 💬 is tapped.
│  └──────────────────────────────────────────┘│     Supports text + image/file attachment.
│                                              │
│  ┌─ History (collapsed by default) ─────────┐│
│  │ ☐ May 1, 10:00 AM · Gemini · 12 turns [🗑]││  ← Only visible when 📝 is tapped.
│  │ ☐ Apr 30, 3:15 PM · Grok · 8 turns  [🗑]││     Checkbox selects for context loading.
│  │ ☐ Apr 29, 9:00 AM · Gemini · 20 turns[🗑]││
│  └──────────────────────────────────────────┘│
│                                              │
│        [Gemini ○ ● Grok]                     │  ← Provider toggle. Simple pill switch.
└──────────────────────────────────────────────┘
```

### 6.2 Interaction States

**Idle:** "Tap 🎙 to start" centered in transcript area. Bottom bar visible.

**Active voice session:** Transcript area fills with live turns as they arrive. Pulsing indicator shows connection state (listening / AI speaking / processing). Bottom bar remains visible — history auto-updates if a new session is in progress.

**History panel open:** Slides up from bottom bar. Each past conversation shows: date/time, provider used, turn count, delete button. Checkbox next to each. Checking a box means "include this transcript in the system context when I start the next chat."

**Text input open:** Small input bar with text field + file/image attach button + send. Sends a text message into the active voice session (both APIs support mixed text+audio input). Collapses back down after send.

**Settings (gear icon):** Modal overlay with two text areas:
- "System Prompt" — the persona/behavior instructions sent to the model
- "Message Prompt" — auto-injected text appended to the first user turn of every new session (e.g., context-setting text)
- Save button. Stored in localStorage + synced to backend.

### 6.3 Visual Design

- **Color palette:** Warm off-white background (`#FAF8F5`), soft sage green accents (`#A8B5A0`), warm gray text (`#4A4A4A`), muted rose for the active/recording indicator (`#D4A0A0`).
- **Typography:** Single font. Something calm and readable — `"Nunito"` or `"Karla"` from Google Fonts. 16px base.
- **Rounded corners everywhere.** 12px border-radius minimum.
- **No borders.** Use subtle background color differences to separate areas.
- **Minimal text.** Icons where possible. No labels on the bottom bar buttons — just icons with a subtle tooltip on hover.
- **The transcript area should feel like a gentle journal**, not a chat app. Generous line height (1.7). Wide margins. No chat bubbles — just text with a faint left border for user vs. a faint right border for AI.
- **Animation:** Pulsing dot for active state. Gentle fade-in for new transcript turns. No aggressive motion.

---

## 7. Provider Integration Details

### 7.1 Gemini Live API

**Connection:** WebSocket to `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={EPHEMERAL_TOKEN}`

**Session setup message:**
```json
{
  "setup": {
    "model": "models/gemini-2.5-flash-live-001",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": {
          "prebuiltVoiceConfig": { "voiceName": "Aoede" }
        }
      }
    },
    "systemInstruction": {
      "parts": [{ "text": "{SYSTEM_PROMPT}" }]
    }
  }
}
```

**Audio format:**
- Input: Raw 16-bit PCM, 16kHz, mono, little-endian
- Output: Raw 16-bit PCM, 24kHz, mono, little-endian

**Sending audio:** Base64-encode PCM chunks and send as:
```json
{
  "realtimeInput": {
    "mediaChunks": [{
      "mimeType": "audio/pcm;rate=16000",
      "data": "{base64_pcm}"
    }]
  }
}
```

**Receiving audio:** Listen for `serverContent` messages containing `modelTurn.parts[].inlineData` with base64 PCM at 24kHz. Decode and play.

**Receiving transcript:** The API provides text transcripts in `serverContent.modelTurn.parts[].text` and input transcripts in `serverContent.inputTranscript`. Capture both for the transcript log.

**Barge-in:** Supported natively. User can interrupt at any time.

**Text input during voice session:** Send as:
```json
{
  "clientContent": {
    "turns": [{ "role": "user", "parts": [{ "text": "..." }] }],
    "turnComplete": true
  }
}
```

### 7.2 Grok Voice Agent API

**Connection:** WebSocket to `wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0`

**Authentication:** Either via `Authorization: Bearer {API_KEY}` header (server-side proxy) or ephemeral token via WebSocket subprotocol `xai-client-secret.{token}`.

**Session setup message:**
```json
{
  "type": "session.update",
  "session": {
    "voice": "eve",
    "instructions": "{SYSTEM_PROMPT}",
    "turn_detection": { "type": "server_vad" },
    "input_audio_format": "pcm16",
    "output_audio_format": "pcm16",
    "input_audio_transcription": { "model": "grok-stt" }
  }
}
```

**Audio format:**
- Input: Raw 16-bit PCM, 24kHz, mono
- Output: Raw 16-bit PCM, 24kHz, mono

**Sending audio:** Base64-encode PCM chunks:
```json
{
  "type": "input_audio_buffer.append",
  "audio": "{base64_pcm}"
}
```

**Receiving audio:** Listen for `response.audio.delta` events with base64 PCM. Decode and play.

**Receiving transcript:**
- User transcript: `conversation.item.input_audio_transcription.completed` event
- AI transcript: `response.audio_transcript.delta` / `response.audio_transcript.done` events

**Text input during voice session:**
```json
{
  "type": "conversation.item.create",
  "item": {
    "type": "message",
    "role": "user",
    "content": [{ "type": "input_text", "text": "..." }]
  }
}
```
Followed by `{"type": "response.create"}`.

**Barge-in:** Server VAD handles turn detection automatically.

### 7.3 Provider Abstraction

Create a thin adapter interface so the frontend doesn't care which provider is active:

```javascript
class VoiceProvider {
  async connect(systemPrompt, contextMessages) { }
  sendAudio(base64Pcm) { }
  sendText(text) { }
  onAudioReceived(callback)  { } // callback(base64Pcm)
  onTranscript(callback) { }     // callback({role, text})
  onStateChange(callback) { }    // callback("connecting"|"listening"|"speaking"|"error")
  disconnect() { }
}
```

Two implementations: `GeminiProvider` and `GrokProvider`. The toggle switch swaps which one is active. Switching providers during a live session disconnects the current one and starts fresh.

---

## 8. Backend Endpoints

### 8.1 HTTP Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/s/:token` | Serve the frontend. Token validated against DB. If new token, create session record. |
| `GET` | `/api/token/gemini` | Return an ephemeral Gemini token (server calls Gemini with real API key) |
| `GET` | `/api/token/grok` | Return an ephemeral Grok token (server calls `POST /v1/realtime/client_secrets` with real API key) |
| `GET` | `/api/transcripts/:token` | Return all transcripts for this user, sorted by date desc |
| `POST` | `/api/transcripts/:token` | Save a completed transcript |
| `DELETE` | `/api/transcripts/:token/:id` | Delete a specific transcript |
| `GET` | `/api/settings/:token` | Get system prompt + message prompt |
| `PUT` | `/api/settings/:token` | Update system prompt + message prompt |

### 8.2 WebSocket Route (fallback if ephemeral tokens don't work)

| Path | Purpose |
|------|---------|
| `ws://host/ws/:token/:provider` | Full proxy mode. Backend opens a WS to the provider, relays audio both directions. |

### 8.3 Retry Logic

Every HTTP and WebSocket connection to a provider API wraps in retry logic:

```javascript
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(1000 * attempt); // 1s, 2s, 3s backoff
    }
  }
}
```

On the frontend, if all 3 retries fail, show a small toast: "Connection lost. Tap to retry." No modal, no panic. Just a calm notification.

For WebSocket reconnection during a voice session: if the WS drops, auto-retry 3 times with 1s/2s/3s delays. If all fail, show the toast and stop the session gracefully (save whatever transcript exists).

---

## 9. Transcript Context Loading (History as Memory)

When the user checks past transcripts in the history panel and starts a new voice session, those transcripts are injected into the session setup as context.

**For Gemini:** Prepend the selected transcripts as text in the system instruction or as initial conversation turns before voice begins.

**For Grok:** Send as `conversation.item.create` messages (role: user / assistant pairs) before the first audio, then send `response.create` to start the live session.

**Format for injection:**
```
[Previous conversation from May 1, 2026]
User: I've been having trouble sleeping since the accident.
Assistant: That's really common after what you've been through...
[End of previous conversation]
```

**Limit:** Cap injected context at ~4000 words total (roughly 5k tokens). If selected transcripts exceed this, take the most recent ones first and truncate older ones with a note: "[Earlier portion omitted for brevity]".

---

## 10. Default System Prompt

Ship with this default (user can edit):

```
You are a compassionate, patient voice companion helping someone recover 
from a traumatic accident. Your role is supportive, not clinical.

Guidelines:
- Listen more than you speak. Short, warm responses.
- Never diagnose. Never prescribe. You are not a therapist.
- Validate their feelings. "That makes sense" > "You should..."
- If they mention severe distress, self-harm, or danger, gently suggest 
  they reach out to a professional or call 988 (Suicide & Crisis Lifeline).
- Remember details they've shared (from conversation history) and reference 
  them naturally.
- Keep your tone calm, grounded, warm. Like a trusted friend.
- It's okay to sit in silence. Don't fill every pause.
- Celebrate small wins. Recovery is non-linear. Acknowledge that.
```

---

## 11. File Structure

```
lfbd/
├── server.js              # Express + WS backend (~300 lines)
├── db.js                  # SQLite setup + query helpers (~80 lines)
├── providers/
│   ├── gemini.js           # Gemini ephemeral token + proxy logic
│   └── grok.js             # Grok ephemeral token + proxy logic
├── public/
│   ├── index.html          # Single page (~150 lines)
│   ├── app.js              # All frontend logic (~500 lines)
│   ├── audio.js            # AudioWorklet mic capture + playback (~200 lines)
│   ├── gemini-provider.js  # Gemini WebSocket client
│   ├── grok-provider.js    # Grok WebSocket client
│   └── style.css           # All styles (~200 lines)
├── package.json
├── .env                    # API keys (not committed)
├── .env.example            # Template
├── data/                   # SQLite file lives here (gitignored)
│   └── lfbd.db
└── README.md
```

Total: ~6 files of substance. ~1500 lines of code.

---

## 12. Deployment Steps

1. **Create a GitHub repo** with the above structure.
2. **Install Fly CLI:** `brew install flyctl` and `flyctl auth login`.
3. **Set secrets** via `flyctl secrets set -a lfbd-app`.
4. **Deploy:** `flyctl deploy -a lfbd-app` (or `./deploy.sh`).
5. **Custom domain** `lfbd.org` configured via Unstoppable Domains DNS.
6. **Send her the link:** `https://lfbd.org/s/{SESSION_TOKEN}`

She bookmarks it. Done. On mobile, she can "Add to Home Screen" for one-tap access.

---

## 13. Implementation Sequence (for the engineer)

### Phase 1: Skeleton (Day 1)
1. Set up Node.js project with Express, `ws`, `better-sqlite3`.
2. Create the SQLite schema.
3. Build the static HTML page with the layout described in §6.
4. Implement the `/s/:token` route that serves the frontend.
5. Implement the settings GET/PUT and transcripts CRUD endpoints.
6. Verify: page loads, settings save/load, transcript list works with dummy data.

### Phase 2: Gemini Integration (Day 2)
1. Implement the Gemini ephemeral token endpoint.
2. Build `gemini-provider.js` on the frontend — WebSocket connection, session setup, audio send/receive.
3. Build `audio.js` — AudioWorklet for mic capture at 16kHz PCM, AudioContext for playback at 24kHz.
4. Wire up: tap "New Chat" → get ephemeral token → connect to Gemini → stream mic audio → receive and play audio → capture transcripts → display in transcript area.
5. On session end (user taps stop or disconnects), POST the transcript to the backend.
6. Verify: full voice conversation works with Gemini. Transcript saves.

### Phase 3: Grok Integration (Day 3)
1. Implement the Grok ephemeral token endpoint.
2. Build `grok-provider.js` — same interface as Gemini provider but with Grok's event types.
3. Note: Grok uses 24kHz for both input and output (vs. Gemini's 16kHz in / 24kHz out). The AudioWorklet needs to handle both sample rates based on active provider.
4. Wire up the provider toggle. Switching providers mid-session disconnects and reconnects.
5. Verify: full voice conversation works with Grok. Transcript saves. Toggle works.

### Phase 4: History + Context Loading (Day 4)
1. Wire up the history panel — load from backend, render with checkboxes and delete buttons.
2. Implement the context injection: when starting a new chat with checked transcripts, format them and include in the session setup.
3. Implement the text input panel — send text messages into active sessions.
4. Implement file/image attachment — encode as base64 and send (Gemini supports images in content; Grok supports text extraction from uploaded files).
5. Verify: checking old transcripts and starting a new chat correctly loads context.

### Phase 5: Polish + Deploy (Day 5)
1. Apply the visual design from §6.3. Colors, typography, animations.
2. Add the retry logic (§8.3) to all provider connections.
3. Add the error toast UI.
4. Test on mobile (iOS Safari, Android Chrome) — mic permissions, audio playback, bottom bar usability.
5. Deploy to Fly.io.
6. Generate the session token, configure it, send the link.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Ephemeral tokens not working for one provider** | Fall back to full server-side WebSocket proxy. Both patterns are in the plan. |
| **Audio playback issues on mobile Safari** | Safari requires a user gesture to start AudioContext. The "New Chat" button tap satisfies this. Test early. |
| **Provider API down** | Retry 3x. If still down, the other provider is one toggle away. Show which provider is available. |
| **SQLite persistence** | Fly.io persistent volume mounted at `/data`. Survives deploys. |
| **Transcript too large for context injection** | Capped at ~4000 words (§9). Oldest content truncated. |
| **Session token guessable** | Use a 128-bit UUID. Brute-forcing is impractical. For a personal demo tool, this is sufficient. |
| **Gemini/Grok API changes** | Both APIs are GA or near-GA. Pin to specific model versions in the session setup. |

---

## 15. What This Plan Does NOT Include

- User authentication (not needed — unique URL is the access control)
- Multiple users (single user tool)
- Encryption at rest (the SQLite file is on a server you control)
- Analytics
- Payment / billing
- Offline support
- Push notifications
- Any STT or TTS service — both providers handle voice natively

---

## 16. Cost Estimate

| Item | Cost |
|------|------|
| Fly.io hosting | ~$5/month |
| Gemini Live API | Free tier available; paid at ~$0.04/min audio |
| Grok Voice Agent API | ~$0.05/min |
| Domain (optional) | ~$10/year if you want a custom domain |

At 2 sessions/day × 15 min each × 30 days = ~900 minutes/month ≈ $36-45/month in API costs. Manageable for a demo.

---

## 17. Voice Selection Guidance

**Gemini voices** (for trauma recovery context, recommend warm/calm):
- `Aoede` — warm, conversational
- `Kore` — gentle, measured

**Grok voices:**
- `Eve` — natural, warm
- `Ara` — calm, clear

Hardcode a sensible default per provider. The user doesn't need a voice picker for this use case — keep it simple.

---

## Summary

Six files. One database table. Two provider adapters. A calm UI. Deploy to Fly.io, send a link. She talks to an AI that listens, responds with its own voice, and remembers what was said last time.
