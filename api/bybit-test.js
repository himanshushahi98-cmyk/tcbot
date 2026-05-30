// Vercel Edge Function — verify Bybit mainnet API keys (read-only, no trade)
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  try {
    const { apiKey, apiSecret } = await req.json();
    if (!apiKey || !apiSecret) return json({ ok: false, msg: 'Missing credentials' }, 401);

    const BASE = 'https://api.bybit.com';
    const recvWindow = '5000';
    const timestamp = Date.now().toString();

    // Sign a GET request for wallet balance — read-only, zero risk
    const queryString = 'accountType=UNIFIED';
    const signStr = timestamp + apiKey + recvWindow + queryString;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw', encoder.encode(apiSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(signStr));
    const hexSig = Array.from(new Uint8Array(sigBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const res = await fetch(`${BASE}/v5/account/wallet-balance?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': hexSig,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    });

    const data = await res.json();

    if (data.retCode !== 0) {
      // Unified account might not exist — try CONTRACT account type
      const qs2 = 'accountType=CONTRACT';
      const sig2Str = timestamp + apiKey + recvWindow + qs2;
      const sig2Buf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(sig2Str));
      const hex2 = Array.from(new Uint8Array(sig2Buf)).map(b => b.toString(16).padStart(2,'0')).join('');

      const res2 = await fetch(`${BASE}/v5/account/wallet-balance?${qs2}`, {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': hex2,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
        },
      });
      const data2 = await res2.json();
      if (data2.retCode === 0) return json({ ok: true, data: data2 });

      const hints = {
        10004: 'Invalid signature — re-check API secret (no extra spaces)',
        10003: 'API key not found or IP restricted',
        10005: 'Permission denied — enable Read permission on the key',
      };
      return json({ ok: false, code: data2.retCode, msg: data2.retMsg, hint: hints[data2.retCode] || '' });
    }

    return json({ ok: true, data });

  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}
