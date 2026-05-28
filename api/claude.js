// Vercel serverless function — proxies Anthropic API calls, handles CORS
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  try {
    const body = await req.text();
    const apiKey = req.headers.get('x-api-key');

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'No API key' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: e.message } }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }
}
