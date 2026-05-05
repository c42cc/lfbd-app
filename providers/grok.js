// Server-side Grok helpers.
// Fetches an ephemeral client secret for direct browser WS connections.

async function getEphemeralToken() {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) throw new Error('XAI_API_KEY or GROK_API_KEY not set');

  const resp = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Grok token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return {
    token: data.client_secret?.value || data.value || data.token,
    mode: 'ephemeral'
  };
}

module.exports = { getEphemeralToken };
