// Server-side Gemini helpers.
// For now, the Gemini Live API accepts the API key directly in the WS URL.
// If/when Google ships proper ephemeral tokens, swap this out.

const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || 'Aoede';

async function getEphemeralToken() {
  const key = process.env.GOOGLE_AI_STUDIO_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');
  return { token: key, mode: 'api_key', model: GEMINI_LIVE_MODEL, voice: GEMINI_LIVE_VOICE };
}

module.exports = { getEphemeralToken };
