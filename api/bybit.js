// Vercel Edge Function — signs and executes live orders on Bybit mainnet
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
    const { apiKey, apiSecret, symbol, side, qty, sl, tp, posMode } = await req.json();

    if (!apiKey || !apiSecret) return json({ retCode: -1, retMsg: 'Missing API credentials' }, 401);
    if (!side || !qty) return json({ retCode: -1, retMsg: 'Missing side or qty' }, 400);

    // positionIdx: one-way=0, hedge-buy=1, hedge-sell=2
    const isHedge = posMode === 'hedge';
    const positionIdx = isHedge ? (side === 'BUY' ? 1 : 2) : 0;

    const BASE = 'https://api.bybit.com';
    const recvWindow = '5000';
    const timestamp = Date.now().toString();

    const orderPayload = {
      category: 'linear',
      symbol: symbol || 'BTCUSDT',
      side: side === 'BUY' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: String(qty),
      positionIdx,
      tpslMode: 'Full',
    };

    // Only attach TP/SL if valid values provided
    if (sl && parseFloat(sl) > 0) orderPayload.stopLoss = String(sl);
    if (tp && parseFloat(tp) > 0) orderPayload.takeProfit = String(tp);
    if (sl) orderPayload.slTriggerBy = 'MarkPrice';
    if (tp) orderPayload.tpTriggerBy = 'MarkPrice';

    const orderBody = JSON.stringify(orderPayload);

    // Bybit V5 HMAC-SHA256: sign( timestamp + apiKey + recvWindow + body )
    const signStr = timestamp + apiKey + recvWindow + orderBody;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw', encoder.encode(apiSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(signStr));
    const hexSig = Array.from(new Uint8Array(sigBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const res = await fetch(`${BASE}/v5/order/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': hexSig,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      body: orderBody,
    });

    const data = await res.json();

    // Surface actionable hints for common error codes
    if (data.retCode !== 0) {
      const hints = {
        10004: 'Invalid signature — check API key/secret',
        10003: 'API key not found or expired',
        110007: 'Insufficient margin balance',
        110017: 'No position found',
        110025: 'Wrong positionIdx for this account mode',
        110084: 'Wrong position mode — switch One-Way/Hedge in CONN tab',
        110043: 'Set leverage on this symbol first in Bybit app',
      };
      data._hint = hints[data.retCode] || '';
    }

    return json(data);

  } catch (e) {
    return json({ retCode: -1, retMsg: e.message }, 500);
  }
}
