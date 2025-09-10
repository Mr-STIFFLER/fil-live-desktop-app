/**************************************************************
 * FILECOIN Live — Desktop (Electron)
 *
 * This file implements the renderer process for the FIL live desktop
 * application. It subscribes to live WebSocket feeds for FIL/USD
 * pricing data, falls back to alternative sources when necessary,
 * fetches on‑chain balances on a schedule, computes portfolio
 * statistics (P&L, deltas, highs/lows) and updates the DOM once per
 * second. It also triggers desktop notifications and optional
 * Discord webhook alerts when configured TP/SL thresholds are
 * crossed.
 **************************************************************/

/** ==== USER SETTINGS (edit these) ==== **/
const USE_EXODUS_BALANCE = true;
const FIL_ADDRESSES = [
  // Replace with your Filecoin address(es)
  'f16xgionxc7iowpdlqjjmlx6omzutyqzrwl4k4lti',
];

const PRICE_SOURCE = 'coinbase'; // 'coinbase' preferred (WS)
const FIL_LOTS = [
  // qty = usd / price if qty omitted
  { usd: 100.00, price: 2.481420365016936, ts: '2025-09-09' }
];

const ENABLE_ALERTS      = true;
const ALERT_WEBHOOK      = ''; // Optional: Discord webhook URL
const SL_PRICE           = 2.00;  // set to NaN to disable
const TP_PRICE           = 3.50;  // set to NaN to disable
const ALERT_COOLDOWN_MIN = 60;

/** ==== INTERNAL CONSTANTS ==== **/
const COLOR_POS = 'pos', COLOR_NEG = 'neg', COLOR_NEU = 'neu';
const BUF_MAX_POINTS = 600;       // keep recent data points for delta calc
const CHAIN_REFRESH_MS = 60_000;  // on‑chain balance refresh interval
const STATS_REFRESH_MS = 60_000;  // 24h high/low stats refresh interval

/** ==== STATE ==== **/
let lastPrice = NaN;
let priceBuffer = [];            // array of {t,p}
let lastAlertTs = 0;
let cachedQty = NaN;
let stats24 = { high: NaN, low: NaN };  // 24h high/low from REST
let wsConn = null;
let wsVendor = null;

/** ==== DOM ELEMENTS ==== **/
const elUpdated = document.getElementById('updated');
const elPrice   = document.getElementById('price');
const elDelta   = document.getElementById('delta');
const elHL24    = document.getElementById('hl24');
const elPos     = document.getElementById('position');
const elTargets = document.getElementById('targets');

/** ==== HELPERS ==== **/
const fmt2  = n => Number.isFinite(n) ? Number(n).toFixed(2) : '—';
const fmt6  = n => Number.isFinite(n) ? Number(n).toFixed(6) : '—';
const fmtFIL= n => Number.isFinite(n) ? Number(n).toFixed(4) : '—';
const fmtPct= n => Number.isFinite(n) ? ((n>=0?'+':'') + n.toFixed(2) + '%') : '—';

function setUpdated(note) {
  const d = new Date();
  const s = d.toLocaleString();
  elUpdated.textContent = `${note} • ${s}`;
}

function pushPrice(t, p) {
  priceBuffer.push({ t, p });
  if (priceBuffer.length > BUF_MAX_POINTS) priceBuffer.splice(0, priceBuffer.length - BUF_MAX_POINTS);
}

function pctChangeSinceMs(ms) {
  if (!priceBuffer.length) return NaN;
  const cutoff = Date.now() - ms;
  let ref = priceBuffer[0];
  for (let i = 0; i < priceBuffer.length; i++) {
    if (priceBuffer[i].t >= cutoff) { ref = priceBuffer[i]; break; }
  }
  const last = priceBuffer[priceBuffer.length - 1];
  if (!ref || !last || !Number.isFinite(ref.p) || !Number.isFinite(last.p) || ref.p === 0) return NaN;
  return ((last.p - ref.p) / ref.p) * 100;
}

function minMaxSinceMs(ms) {
  if (!priceBuffer.length) return { hi: NaN, lo: NaN };
  const cutoff = Date.now() - ms;
  const window = priceBuffer.filter(x => x.t >= cutoff);
  const arr = window.length ? window : priceBuffer;
  let hi = -Infinity, lo = Infinity;
  for (const x of arr) {
    if (Number.isFinite(x.p)) {
      if (x.p > hi) hi = x.p;
      if (x.p < lo) lo = x.p;
    }
  }
  return { hi, lo };
}

/** ==== POSITION / LOTS ==== **/
function normalizeLots(lots) {
  const out = [];
  for (const l of lots || []) {
    const price = Number(l.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    let qty, usd;
    if (l.qty != null) {
      qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      usd = qty * price;
    } else if (l.usd != null) {
      usd = Number(l.usd);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      qty = usd / price;
    } else {
      continue;
    }
    out.push({ qty, usd, price, ts: l.ts || null });
  }
  return out;
}

function computePosition(overrideQtyMaybe) {
  const lots = normalizeLots(FIL_LOTS);
  let invested = 0, qtyLots = 0;
  for (const l of lots) { invested += l.usd; qtyLots += l.qty; }
  const qty = Number.isFinite(overrideQtyMaybe) && overrideQtyMaybe > 0 ? overrideQtyMaybe : qtyLots;
  const avg = qty > 0 ? invested / qty : NaN;
  return { lotsCount: lots.length, qty, invested, avgCost: avg };
}

/** ==== ALERTS ==== **/
function maybeAlert(price) {
  if (!ENABLE_ALERTS) return;
  const now = Date.now();
  const cooldownMs = ALERT_COOLDOWN_MIN * 60_000;
  const canAlert = (now - lastAlertTs) >= cooldownMs;
  const needsSL = Number.isFinite(SL_PRICE) && price <= SL_PRICE;
  const needsTP = Number.isFinite(TP_PRICE) && price >= TP_PRICE;
  if ((needsSL || needsTP) && canAlert) {
    const text = needsSL
      ? `🔻 FIL hit stop‑loss: $${fmt2(price)} (≤ $${fmt2(SL_PRICE)})`
      : `✅ FIL hit take‑profit: $${fmt2(price)} (≥ $${fmt2(TP_PRICE)})`;
    // Desktop notification
    try { new Notification('FIL Target Alert', { body: text }); } catch (_) {}
    // Optional Discord webhook
    if (ALERT_WEBHOOK) {
      fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } })
      }).catch(() => {});
    }
    lastAlertTs = now;
  }
}

/** ==== PRICE (WS + REST FALLBACKS) ==== **/
// 1) Coinbase Exchange WS: public ticker
function startCoinbaseWS() {
  try {
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['FIL-USD'], channels: ['ticker'] }));
      wsVendor = 'Coinbase WS';
      setUpdated('Connected (Coinbase WS)');
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data || '{}');
      if (m.type === 'ticker' && m.product_id === 'FIL-USD' && m.price) {
        const px = Number(m.price);
        if (Number.isFinite(px)) {
          lastPrice = px;
          pushPrice(Date.now(), px);
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      setUpdated('Disconnected (Coinbase WS). Falling back…');
      startKrakenWS();
    };
    wsConn = ws;
  } catch {
    startKrakenWS();
  }
}

// 2) Kraken WS fallback
function startKrakenWS() {
  try {
    const ws = new WebSocket('wss://ws.kraken.com/');
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'subscribe', pair: ['FIL/USD'], subscription: { name: 'ticker' } }));
      wsVendor = 'Kraken WS';
      setUpdated('Connected (Kraken WS)');
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data || '{}');
      if (Array.isArray(m) && m[1] && m[1].c && m[1].c[0]) {
        const px = Number(m[1].c[0]);
        if (Number.isFinite(px)) {
          lastPrice = px;
          pushPrice(Date.now(), px);
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      setUpdated('Disconnected (Kraken WS). Falling back to REST…');
      startRESTPolling();
    };
    wsConn = ws;
  } catch {
    startRESTPolling();
  }
}

// 3) REST fallback (poll every 5 seconds)
let restPollTimer = null;
function startRESTPolling() {
  wsConn = null;
  wsVendor = 'REST';
  const poll = async () => {
    try {
      let px = NaN;
      if (PRICE_SOURCE === 'coinbase') {
        px = await getJsonNum('https://api.coinbase.com/v2/prices/FIL-USD/spot', j => j?.data?.amount);
      }
      if (!Number.isFinite(px)) {
        px = await getJsonNum('https://api.kraken.com/0/public/Ticker?pair=FILUSD', j => {
          const k = j && j.result && Object.keys(j.result)[0];
          return k ? j.result[k].c?.[0] : NaN;
        });
      }
      if (!Number.isFinite(px)) {
        px = await getJsonNum('https://api.coingecko.com/api/v3/simple/price?ids=filecoin&vs_currencies=usd', j => j?.filecoin?.usd);
      }
      if (Number.isFinite(px)) {
        lastPrice = Number(px);
        pushPrice(Date.now(), lastPrice);
        setUpdated('REST polling');
      }
    } catch {}
  };
  clearInterval(restPollTimer);
  restPollTimer = setInterval(poll, 5000);
  poll();
}

async function getJsonNum(url, pick) {
  const r = await fetch(url);
  if (!r.ok) return NaN;
  const j = await r.json();
  const v = Number(pick(j));
  return Number.isFinite(v) ? v : NaN;
}

/** ==== 24h STATS ==== **/
async function refresh24hStats() {
  try {
    const r = await fetch('https://api.exchange.coinbase.com/products/FIL-USD/stats');
    if (r.ok) {
      const j = await r.json();
      const high = Number(j.high);
      const low  = Number(j.low);
      if (Number.isFinite(high) && Number.isFinite(low)) stats24 = { high, low };
    }
  } catch {}
}

/** ==== ON-CHAIN BALANCE ==== **/
function attoToFIL(attoStr) {
  let s = String(attoStr).replace(/^0+/, '');
  if (!s.length) return 0;
  if (s.length <= 18) {
    return Number('0.' + s.padStart(18, '0'));
  }
  const intPart = s.slice(0, -18);
  const frac = s.slice(-18);
  return Number(intPart + '.' + frac);
}

async function fetchFILAddressBalance(addr) {
  // 1) GLIF Lotus public RPC
  const payload = { jsonrpc:'2.0', method:'Filecoin.WalletBalance', params:[addr], id:1 };
  const urls = ['https://api.node.glif.io/rpc/v1', 'https://api.node.glif.io'];
  for (const url of urls) {
    try {
      const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.result) return attoToFIL(j.result);
      }
    } catch {}
  }
  // 2) Filfox explorer fallback
  try {
    const r = await fetch('https://filfox.info/api/v1/address/' + encodeURIComponent(addr));
    if (r.ok) {
      const j = await r.json();
      const b = j && (j.balance || j.available || j.balanceString);
      if (b != null) {
        const s = String(b);
        if (/^\d+$/.test(s)) return attoToFIL(s);
        if (/FIL$/i.test(s)) return Number(s.replace(/FIL/i, '').trim());
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
    }
  } catch {}
  return NaN;
}

async function fetchExodusQtyFIL() {
  if (!USE_EXODUS_BALANCE) return NaN;
  const addrs = (FIL_ADDRESSES || []).map(s => String(s || '').trim()).filter(Boolean);
  if (!addrs.length) return NaN;
  let total = 0;
  for (const a of addrs) {
    const q = await fetchFILAddressBalance(a);
    if (Number.isFinite(q)) total += q;
  }
  if (!Number.isFinite(total) || total <= 0) {
    return Number.isFinite(cachedQty) ? cachedQty : NaN;
  }
  cachedQty = total;
  return total;
}

/** ==== RENDER LOOP (1s) ==== **/
function render() {
  // Price
  const prev = priceBuffer.length > 1 ? priceBuffer[priceBuffer.length - 2].p : lastPrice;
  const priceClass = Number.isFinite(lastPrice) ? (lastPrice >= prev ? COLOR_POS : COLOR_NEG) : COLOR_NEU;
  elPrice.textContent = Number.isFinite(lastPrice) ? `$${fmt2(lastPrice)}` : '—';
  elPrice.className = `value ${priceClass}`;
  // Deltas
  const ch1h  = pctChangeSinceMs(1 * 3600 * 1000);
  const ch24h = pctChangeSinceMs(24 * 3600 * 1000);
  elDelta.innerHTML = `<span class="${(ch1h>=0)?'pos':'neg'}">${fmtPct(ch1h)}</span> / <span class="${(ch24h>=0)?'pos':'neg'}">${fmtPct(ch24h)}</span>`;
  // High/Low (prefer REST stats; fallback to buffer)
  const mm = minMaxSinceMs(24 * 3600 * 1000);
  const hi = Number.isFinite(stats24.high) ? stats24.high : mm.hi;
  const lo = Number.isFinite(stats24.low)  ? stats24.low  : mm.lo;
  elHL24.textContent = `$${fmt2(hi)} / $${fmt2(lo)}`;
  // Position & P&L
  const pos = computePosition(cachedQty);
  const value = Number.isFinite(lastPrice) ? pos.qty * lastPrice : NaN;
  const pnlUSD = Number.isFinite(value) ? (value - pos.invested) : NaN;
  const pnlPct = (pos.invested > 0 && Number.isFinite(value)) ? (pnlUSD / pos.invested) * 100 : NaN;
  const fromAvgPct = (Number.isFinite(pos.avgCost) && pos.avgCost > 0 && Number.isFinite(lastPrice))
    ? ((lastPrice - pos.avgCost) / pos.avgCost) * 100 : NaN;
  const qtyLabel = USE_EXODUS_BALANCE ? 'Qty (on‑chain)' : 'Qty';
  elPos.innerHTML = [
    `Lots <b>${pos.lotsCount}</b>`,
    `${qtyLabel} <b>${fmtFIL(pos.qty)} FIL</b>`,
    `Cost <b>$${fmt2(pos.invested)}</b> @ Avg <b>$${fmt6(pos.avgCost)}</b>`,
    `Value <b>$${fmt2(value)}</b>`,
    `P&L <b>$${fmt2(pnlUSD)} (${fmtPct(pnlPct)})</b>`,
    `From Avg <b>${fmtPct(fromAvgPct)}</b>`
  ].join(' • ');
  // Targets
  const tps = Number.isFinite(TP_PRICE) && Number.isFinite(lastPrice) ? `TP $${fmt2(TP_PRICE)} (${fmtPct(((TP_PRICE / lastPrice) - 1) * 100)})` : null;
  const sls = Number.isFinite(SL_PRICE) && Number.isFinite(lastPrice) ? `SL $${fmt2(SL_PRICE)} (${fmtPct(((SL_PRICE / lastPrice) - 1) * 100)})` : null;
  elTargets.innerHTML = [tps, sls].filter(Boolean).join(' • ') || '—';
  // Alerts
  if (Number.isFinite(lastPrice)) maybeAlert(lastPrice);
}

/** ==== INIT ==== **/
function init() {
  // Start price stream
  startCoinbaseWS();
  // Fetch initial stats and schedule updates
  refresh24hStats();
  setInterval(refresh24hStats, STATS_REFRESH_MS);
  // On‑chain qty schedule
  const refreshQty = async () => { cachedQty = await fetchExodusQtyFIL(); };
  refreshQty();
  setInterval(refreshQty, CHAIN_REFRESH_MS);
  // UI loop (1 Hz)
  setInterval(() => {
    render();
    setUpdated(wsVendor ? `Live (${wsVendor})` : 'Live');
  }, 1000);
}

document.addEventListener('DOMContentLoaded', init);
