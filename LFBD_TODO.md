# LFBD — Open Work

- **L1: Pip voice mode exposes API key to browser** — `GET /api/token/gemini` returns the raw Gemini API key in the WS URL. Acceptable for single-user; risk if shared publicly. Complexity: M.
- **L2: Grok model ID hardcoded in browser** — `grok-provider.js` hardcodes `grok-voice-think-fast-1.0` and voice `eve`. Unlike Gemini (now server-configurable), Grok model/voice are still browser-side constants. Should mirror the Gemini pattern (server returns model/voice in token response). Complexity: S.
- ~~**L4: Railway volume for DB persistence**~~ — Resolved. Fly.io volume mounted at `/data` via `fly.toml`.
