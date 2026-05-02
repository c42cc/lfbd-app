# LFBD

A single-user voice companion for recovery support. Opens in a browser, talks via native voice APIs (Gemini Live or Grok Voice), saves transcripts between sessions. No accounts, no passwords — one private link.

## Quick Start (Local)

```bash
cd _misc/LFBD
npm install
# Edit .env with your API keys (see Environment Variables below)
npm start
```

Open `http://localhost:3000/s/YOUR-SESSION-TOKEN` in a browser.

## How It Works

1. User opens their unique URL (`/s/<token>`)
2. First visit shows a welcome screen, then the main app
3. Tap the mic button to start a voice conversation
4. Audio streams directly to Gemini Live or Grok Voice API (no separate STT/TTS)
5. AI responds with its own voice — transcript displays live
6. Grok's thinking/reasoning notes appear as collapsible labels
7. Conversation saves to SQLite on session end
8. Past conversations can be loaded as context for new sessions

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes (for Gemini) | Google AI API key |
| `XAI_API_KEY` or `GROK_API_KEY` | Yes (for Grok) | xAI API key |
| `SESSION_TOKEN` | Recommended | UUID for the user's session URL. Generate with `uuidgen` |
| `ADMIN_TOKEN` | Recommended | Bearer token for the admin API. Any strong random string |
| `PORT` | No | Server port (default: 3000) |
| `DATA_DIR` | No | SQLite storage directory (default: `./data`) |

## Admin API

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` header.

### Health Check

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/health
```

Returns: `{ status, uptime, version, db: { transcripts, settings } }`

### Read Settings

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/settings/$SESSION_TOKEN
```

### Update Settings

```bash
curl -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"system_prompt": "New prompt text", "message_prompt": ""}' \
  https://your-app.up.railway.app/api/admin/settings/$SESSION_TOKEN
```

### List All Transcripts

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/transcripts/$SESSION_TOKEN
```

### Get Single Transcript

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/transcripts/$SESSION_TOKEN/<transcript-id>
```

### Delete Single Transcript

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/transcripts/$SESSION_TOKEN/<transcript-id>
```

### Delete All Transcripts

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/transcripts/$SESSION_TOKEN
```

## Pip (In-App Helper)

Pip is a simple messaging channel between the app user and a helper engineer.

**For the user:** Tap the small "p" button in the lower-right corner. A chat panel opens. Type a message — it goes to the engineer. The engineer replies through the same channel.

**For the engineer:** Read and reply via the admin API:

```bash
# Read all messages
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.up.railway.app/api/admin/pip/$SESSION_TOKEN

# Read new messages since a timestamp
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://your-app.up.railway.app/api/admin/pip/$SESSION_TOKEN?since=2026-05-01T00:00:00Z"

# Reply as Pip
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Done! I updated the color."}' \
  https://your-app.up.railway.app/api/admin/pip/$SESSION_TOKEN
```

The user sees replies from the engineer labeled as "Pip" in the chat panel.

## Build Mode

Inside the Pip panel, there's a "Build Mode" button at the bottom. Pressing it inverts the app's color scheme (dark background, light text). This is a visual indicator that the app is in a development/configuration state. Press again to exit. Purely cosmetic — no functional difference.

## Engineer Workflow

The engineer opens the LFBD repo in Cursor. The `.cursor/rules/engineer.mdc` file defines the workflow:

1. **Read** Pip messages for requests
2. **Plan** the change (2-3 sentences)
3. **Build** it
4. **Deploy** by pushing to `main` (Railway auto-deploys)
5. **Reply** via Pip confirming what was done

**Escalation rule:** If a change touches the database schema, voice providers, auth, default prompts, or adds dependencies — send a Pip message saying "You may want to check in with CC" before proceeding.

## Deploy to Railway

1. Install Railway CLI: `npm i -g @railway/cli`
2. Login: `railway login`
3. Init project: `railway init` (from the `_misc/LFBD/` directory)
4. Add a persistent volume mounted at `/data`
5. Set environment variables:
   ```bash
   railway variables set GEMINI_API_KEY=your-key
   railway variables set XAI_API_KEY=your-key
   railway variables set SESSION_TOKEN=$(uuidgen)
   railway variables set ADMIN_TOKEN=$(openssl rand -hex 24)
   railway variables set DATA_DIR=/data
   ```
6. Deploy: `railway up`
7. Get public URL: `railway domain`
8. Send the link: `https://<your-domain>/s/<SESSION_TOKEN>`

## iOS Home Screen Install

1. Open the session URL in Safari on iPhone
2. Tap the Share button (square with arrow)
3. Tap "Add to Home Screen"
4. The app icon appears on the home screen
5. Launching from the icon opens in standalone mode (no browser chrome)

## File Structure

```
server.js              Express server + all routes (app + admin + pip)
db.js                  SQLite schema + query helpers
providers/
  gemini.js            Gemini ephemeral token helper
  grok.js              Grok ephemeral token helper
public/
  index.html           Single page + welcome overlay + pip panel
  app.js               Frontend orchestration + pip messaging + build mode
  audio.js             Mic capture + PCM playback
  pcm-processor.js     AudioWorklet for PCM resampling
  gemini-provider.js   Gemini Live WebSocket client
  grok-provider.js     Grok Voice WebSocket client
  style.css            All styles (including build mode dark theme)
  manifest.json        PWA manifest
  icon.svg             App icon
.cursor/rules/
  engineer.mdc         Cursor rules for the helper engineer
Procfile               Railway start command
```

## Cost Estimate

- Railway hosting: ~$5/month (Hobby plan)
- Gemini Live API: ~$0.04/min
- Grok Voice: ~$0.05/min
- At 2 sessions/day x 15 min: ~$36-45/month API costs
