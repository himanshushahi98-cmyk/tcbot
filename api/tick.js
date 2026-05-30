// Server-side bot tick — called every minute by cron-job.org
// Stateless: Bybit is the source of truth for open positions
// Uses BYBIT_KEY + BYBIT_SECRET from Vercel environment variables
export const config = { runtime: 'edge' };

const BASE = 'https://api.bybit.com';

// ── EMA calculation ───────────────────────────────────────────────────────────
function calcEMA(arr, p) {
  if (arr.length < p) return arr[arr.length - 1] || 0;
  const k = 2 / (p + 1);
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}

// ── ATR ───────────────────────────────────────────────────────────────────────
function calcATR(cs, p) {
  const trs = [];
  for (let i = 1; i < cs.length; i++) {
    trs.push(Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c)
    ));
  }
  if (trs.length < p) return trs[trs.length - 1] || 0;
  let v = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const al = 1 / p;
  for (let i = p; i < trs.length; i++) v = trs[i] * al + v * (1 - al);
  return v;
}

// ── ADX ───────────────────────────────────────────────────────────────────────
function calcADX(cs, p) {
  if (cs.length < 2 * p + 2) return 0;
  const ups = [], dns = [], trs = [];
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], pr = cs[i - 1];
    const up = c.h - pr.h, dn = pr.l - c.l;
    ups.push(up > dn && up > 0 ? up : 0);
    dns.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - pr.c), Math.abs(c.l - pr.c)));
  }
  const al = 1 / p;
  let at = 0, pd = 0, md = 0;
  for (let i = 0; i < p; i++) { at += trs[i]; pd += ups[i]; md += dns[i]; }
  at /= p; pd /= p; md /= p;
  const dxArr = [];
  for (let i = p; i < ups.length; i++) {
    at = trs[i] * al + at * (1 - al);
    pd = ups[i] * al + pd * (1 - al);
    md = dns[i] * al + md * (1 - al);
    const pdi = at ? (pd / at) * 100 : 0;
    const mdi = at ? (md / at) * 100 : 0;
    const s = pdi + mdi;
    dxArr.push(s ? Math.abs(pdi - mdi) / s * 100 : 0);
  }
  if (dxArr.length < p) return dxArr[dxArr.length - 1] || 0;
  let adx = dxArr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dxArr.length; i++) adx = dxArr[i] * al + adx * (1 - al);
  return adx;
}

// ── Kill zone check (UTC) ─────────────────────────────────────────────────────
function inKillZone() {
  const h = new Date().getUTCHours();
  return (h >= 7 && h < 10) || (h >= 13 && h < 16);
}

// ── Bybit signed request ──────────────────────────────────────────────────────
async function bybitSign(apiKey, apiSecret, body) {
  const ts = Date.now().toString();
  const rw = '5000';
  const str = ts + apiKey + rw + (typeof body === 'string' ? body : JSON.stringify(body));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(str));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { ts, rw, hex };
}

async function bybitGet(apiKey, apiSecret, path, params) {
  const qs = new URLSearchParams(params).toString();
  const ts = Date.now().toString(), rw = '5000';
  const str = ts + apiKey + rw + qs;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(str));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  const r = await fetch(`${BASE}${path}?${qs}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': hex,
      'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': rw,
    }
  });
  return r.json();
}

async function bybitPost(apiKey, apiSecret, path, payload) {
  const body = JSON.stringify(payload);
  const { ts, rw, hex } = await bybitSign(apiKey, apiSecret, body);
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': hex,
      'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': rw,
    },
    body,
  });
  return r.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req) {
  const json = (data, s = 200) =>
    new Response(JSON.stringify(data), { status: s, headers: { 'Content-Type': 'application/json' } });

  // Simple token guard — set TICK_SECRET in Vercel env vars, same value in cron-job.org header
  const secret = req.headers.get('x-tick-secret');
  if (secret !== (globalThis.TICK_SECRET || process?.env?.TICK_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const apiKey    = globalThis.BYBIT_KEY    || process?.env?.BYBIT_KEY;
  const apiSecret = globalThis.BYBIT_SECRET || process?.env?.BYBIT_SECRET;
  if (!apiKey || !apiSecret) return json({ error: 'No Bybit credentials in env' }, 500);

  try {
    // 1 — Check if already in a position (Bybit is source of truth)
    const posRes = await bybitGet(apiKey, apiSecret, '/v5/position/list',
      { category: 'linear', symbol: 'BTCUSDT' });
    const positions = posRes?.result?.list || [];
    const openPos = positions.find(p => parseFloat(p.size) > 0);
    if (openPos) {
      return json({
        action: 'watching',
        side: openPos.side,
        size: openPos.size,
        entry: openPos.avgPrice,
        pnl: openPos.unrealisedPnl,
      });
    }

    // 2 — Check kill zone
    if (!inKillZone()) return json({ action: 'skip', reason: 'outside kill zone' });

    // 3 — Check daily realized PnL (enforce $8 max daily loss)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const pnlRes = await bybitGet(apiKey, apiSecret, '/v5/position/closed-pnl',
      { category: 'linear', symbol: 'BTCUSDT', limit: '50' });
    const todayTrades = (pnlRes?.result?.list || []).filter(t => {
      const d = new Date(parseInt(t.updatedTime)).toISOString().slice(0, 10).replace(/-/g, '');
      return d === today;
    });
    const dayLoss = todayTrades.reduce((sum, t) => {
      const p = parseFloat(t.closedPnl);
      return p < 0 ? sum + Math.abs(p) : sum;
    }, 0);
    if (dayLoss >= 8.0) return json({ action: 'skip', reason: `day loss limit $${dayLoss.toFixed(2)}` });

    // 4 — Fetch 1m candles
    const kRes = await fetch(
      'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit=200'
    );
    const kData = await kRes.json();
    const raw = (kData?.result?.list || []).reverse();
    // raw[i] = [time, open, high, low, close, volume, turnover]
    const cs = raw.map(c => ({
      o: parseFloat(c[1]), h: parseFloat(c[2]),
      l: parseFloat(c[3]), c: parseFloat(c[4]),
    }));

    // Use closed candles (drop last in-progress bar)
    const closed = cs.slice(0, -1);
    if (closed.length < 50) return json({ action: 'skip', reason: 'not enough candles' });

    const last   = closed[closed.length - 1];
    const closes = closed.map(c => c.c);
    const e9     = calcEMA(closes, 9);
    const e15    = calcEMA(closes, 15);
    const atr    = calcATR(closed, 14);
    const adx    = calcADX(closed, 14);

    if (adx < 20) return json({ action: 'skip', reason: `ADX ${adx.toFixed(1)} < 20` });

    const bull   = e9 > e15, bear = e9 < e15;
    const zTop   = Math.max(e9, e15), zBot = Math.min(e9, e15);
    const inZone = last.c >= zBot && last.c <= zTop;
    const body   = Math.abs(last.c - last.o);
    const range  = last.h - last.l;
    const ratio  = range > 0 ? body / range : 0;
    const mid    = (last.h + last.l) / 2;
    const goodSz = ratio >= 0.15 && ratio <= 0.70;

    const longC  = last.c > last.o && goodSz && last.c > mid && last.c >= zBot;
    const shortC = last.c < last.o && goodSz && last.c < mid && last.c <= zTop;

    let signal = null;
    if (bull && inZone && longC)  signal = 'BUY';
    if (bear && inZone && shortC) signal = 'SELL';
    if (!signal) return json({ action: 'skip', reason: 'no signal', e9: e9.toFixed(1), e15: e15.toFixed(1), adx: adx.toFixed(1) });

    // 5 — Calculate SL / TP / qty
    const SL_BUF = 0.10, RR = 2.0, MAX_RISK = 2.0, COMMISSION_RATE = 0.00055;
    const sl = signal === 'BUY'
      ? last.l - SL_BUF * atr
      : last.h + SL_BUF * atr;
    const dist = Math.abs(last.c - sl);
    const tp = signal === 'BUY'
      ? last.c + dist * RR
      : last.c - dist * RR;
    const totalCost = dist + (last.c + Math.abs(sl)) * COMMISSION_RATE;
    const rawQty = MAX_RISK / totalCost;
    const qty = Math.max(0.001, Math.round(rawQty / 0.001) * 0.001).toFixed(3);

    // 6 — Place order (Bybit manages SL/TP automatically)
    const side = signal === 'BUY' ? 'Buy' : 'Sell';
    const orderRes = await bybitPost(apiKey, apiSecret, '/v5/order/create', {
      category:     'linear',
      symbol:       'BTCUSDT',
      side,
      orderType:    'Market',
      qty:          String(qty),
      stopLoss:     parseFloat(sl).toFixed(1),
      takeProfit:   parseFloat(tp).toFixed(1),
      slTriggerBy:  'MarkPrice',
      tpTriggerBy:  'MarkPrice',
      tpslMode:     'Full',
    });

    return json({
      action:  'order_placed',
      signal,
      qty,
      entry:   last.c,
      sl:      parseFloat(sl).toFixed(1),
      tp:      parseFloat(tp).toFixed(1),
      adx:     adx.toFixed(1),
      dayLoss: dayLoss.toFixed(2),
      bybit:   orderRes,
    });

  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
