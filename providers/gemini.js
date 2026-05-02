// Server-side Gemini helpers.
// For now, the Gemini Live API accepts the API key directly in the WS URL.
// If/when Google ships proper ephemeral tokens, swap this out.

async function getEphemeralToken() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  return { token: key, mode: 'api_key' };
}

module.exports = { getEphemeralToken };
