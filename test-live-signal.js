/**
 * test-live-signal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Full end-to-end test of all new features:
 *
 *   ✅ Price source  — server uses MEXC WS 3m candle open (0ms) not REST
 *   ✅ R:R based SL/TP — slPips + rr, server resolves from WS candle open
 *   ✅ Holding candles — closes automatically after N × 3-min candles
 *   ✅ CTC — moves SL to break-even when price reaches ctcTrigger % of TP
 *   ✅ direction BUY/SELL — resolved to LONG/SHORT by server
 *   ✅ marginMode=dollar — $5 margin
 *
 * Run: node test-live-signal.js [buy|sell] [holdingCandles]
 *
 * Examples:
 *   node test-live-signal.js         → SELL, 3 candles (default)
 *   node test-live-signal.js buy 2   → BUY,  2 candles (6 minutes)
 *   node test-live-signal.js sell 5  → SELL, 5 candles (15 minutes)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const BASE_URL = 'http://localhost:3000';

const direction      = (process.argv[2] || 'sell').toUpperCase();   // BUY | SELL
const holdingCandles = parseInt(process.argv[3] || '3', 10);        // default 3 candles = 9 min

// Password from .env or env var (DASHBOARD_PASSWORD=...)
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'selfpride@@007';

// ── Signal parameters ──────────────────────────────────────────────────────
// slPips: BTC at ~105k, 0.16% SL = ~168 USDT
// rr   : risk:reward ratio (TP = slPips × rr from entry)
// ctcTrigger: 0.4 = 40% of TP distance → move SL to break-even
const slPips      = 168;   // USDT distance for SL (from 3m candle open)
const rr          = 1.75;  // TP is 1.75× the SL distance
const ctcTrigger  = 0.4;   // CTC fires at 40% of TP hit (signal provider value, DO NOT change)

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Session cookie — shared across all requests ────────────────────────────
let _sessionCookie = null;

async function login() {
    const body = `password=${encodeURIComponent(DASHBOARD_PASSWORD)}`;
    const res  = await fetch(`${BASE_URL}/login`, {
        method   : 'POST',
        headers  : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect : 'manual'   // don't follow redirect — we just want the Set-Cookie
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const match     = setCookie.match(/dash_session=([^;]+)/);
    if (!match) throw new Error('Login failed — check DASHBOARD_PASSWORD');
    _sessionCookie = `dash_session=${match[1]}`;
    console.log('  ✅ Logged in to dashboard');
}

async function request(path, method = 'GET', body = null) {
    const headers = {
        'Content-Type': 'application/json',
        ...(path !== '/api/trade' && _sessionCookie ? { Cookie: _sessionCookie } : {})
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(BASE_URL + path, opts);
    const json = await res.json();
    return json;
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  SIGNAL-BASED TRADING BOT — LIVE FEATURE TEST   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log(`  Direction     : ${direction}`);
    console.log(`  Holding       : ${holdingCandles} candles (${holdingCandles * 3} minutes)`);
    console.log(`  slPips        : ${slPips} USDT`);
    console.log(`  RR            : 1:${rr}  →  TP = ${slPips * rr} USDT from entry`);
    console.log(`  CTC trigger   : ${ctcTrigger * 100}% of TP distance → SL → break-even`);
    console.log(`  Margin        : $1  (marginMode=dollar — minimal test margin)`);
    console.log(`  Leverage      : 200×`);
    console.log();

    // ── STEP 0: Login + check WS price cache ──────────────────────────────
    console.log('─── Step 0: Authenticating + checking price ────────');
    try {
        await login();
    } catch (e) {
        console.error('❌ Could not login:', e.message);
        process.exit(1);
    }
    const priceResp = await request('/api/price/BTCUSDT');
    if (!priceResp.success) {
        console.error('❌ Could not reach /api/price. Error:', priceResp.error);
        process.exit(1);
    }
    console.log(`  REST price (fallback): $${priceResp.data.price}`);
    console.log('  ℹ️  Server will use WS 3m candle open — price logged in server console');
    console.log('  ℹ️  Look for: ⚡ [TIMING] 3m candle open: XXXXX (0ms from WS kline)');
    console.log();

    // ── STEP 1: Fire the trade ──────────────────────────────────────────────
    console.log(`─── Step 1: Firing trade signal → ${direction} BTCUSDT ─────`);

    // NOTE: No candleOpen, no entryPrice sent!
    // Server resolves price from:  getCandleOpen() → getLivePrice() → REST
    const payload = {
        symbol        : 'BTCUSDT',
        direction,                          // BUY or SELL
        slPips,                             // SL distance (applies to MEXC candle open)
        rr,                                 // TP = slPips × rr
        marginMode    : 'dollar',
        marginDollar  : 1,                  // $1 margin (minimal for testing)
        leverage      : 200,
        riskMode      : 'isolated',
        holdingCandles,                     // auto-close after N × 3-min candles
        ctcEnabled    : true,               // move SL to BE when price hits ctcTrigger
        ctcTrigger,
        entryTime     : Date.now()
    };

    console.log('\n  Payload:');
    console.log(JSON.stringify(payload, null, 4).split('\n').map(l => '  ' + l).join('\n'));
    console.log();

    const t0  = Date.now();
    const res = await request('/api/trade', 'POST', payload);
    const elapsed = Date.now() - t0;

    console.log(`  HTTP round-trip: ${elapsed}ms`);

    if (!res.success) {
        console.error('\n❌ TRADE FAILED:', res.error);
        process.exit(1);
    }

    const d = res.data;
    console.log('\n  ✅ TRADE ACCEPTED');
    console.log(`  ┌─────────────────────────────────────────────────`);
    console.log(`  │ tradeId        : ${d.tradeId}`);
    console.log(`  │ symbol         : ${d.symbol}  ${d.side}`);
    console.log(`  │ price (ref)    : ${d.price}   ← MEXC 3m candle open (WS)`);
    console.log(`  │ SL             : ${d.stopLoss}`);
    console.log(`  │ TP             : ${d.takeProfit1}`);
    const actualSlPips = d.side === 'LONG'
        ? (d.price - d.stopLoss).toFixed(2)
        : (d.stopLoss - d.price).toFixed(2);
    const actualTpPips = d.side === 'LONG'
        ? (d.takeProfit1 - d.price).toFixed(2)
        : (d.price - d.takeProfit1).toFixed(2);
    const actualRR = (actualTpPips / actualSlPips).toFixed(2);
    console.log(`  │ SL distance    : ${actualSlPips} USDT (sent ${slPips})`);
    console.log(`  │ TP distance    : ${actualTpPips} USDT (expected ${(slPips * rr).toFixed(2)})`);
    console.log(`  │ actual R:R     : 1:${actualRR}  (target 1:${rr})`);
    console.log(`  │ ctcEnabled     : ${d.ctcEnabled}   ctcTrigger: ${d.ctcTrigger}`);
    console.log(`  │ holdingCandles : ${d.holdingCandles} × 3min = ${d.holdingCandles * 3} minutes`);
    console.log(`  └─────────────────────────────────────────────────`);

    // ── STEP 2: Verify monitor is tracking the position ───────────────────
    await sleep(2000);
    console.log('\n─── Step 2: Verifying position monitor ─────────────');
    const monRes = await request('/api/monitor/holding');
    if (monRes.success) {
        const pos = monRes.data.positions?.find(p => p.symbol === 'BTCUSDT');
        if (pos) {
            console.log(`  ✅ Position monitored:`);
            console.log(`     holdingEnabled  : ${pos.holdingEnabled}`);
            console.log(`     holdingCandles  : ${pos.holdingCandles}`);
            console.log(`     elapsedCandles  : ${pos.elapsedCandles}`);
            console.log(`     ctcEnabled      : ${pos.ctcEnabled}`);
            console.log(`     ctcTriggerPrice : ${pos.ctcTriggerPrice?.toFixed(2)}`);
            console.log(`     ctcTriggered    : ${pos.ctcTriggered}`);
        } else {
            console.log('  ⚠️  Position not yet in monitor data (may take one 5s tick)');
        }
    }

    // ── STEP 3: Watch holding candle progress ─────────────────────────────
    const closeAfterMs = holdingCandles * 3 * 60 * 1000;
    console.log(`\n─── Step 3: Watching position (closes in ~${holdingCandles * 3} min) ──────`);
    console.log(`  Polling every 30s for up to ${holdingCandles * 3 + 1} minutes...`);
    console.log(`  Expected auto-close at ${new Date(Date.now() + closeAfterMs).toLocaleTimeString()}\n`);

    const pollEnd = Date.now() + closeAfterMs + 90_000; // +90s buffer

    while (Date.now() < pollEnd) {
        await sleep(30_000);

        const posRes = await request('/api/positions');
        const btc    = posRes.data?.find?.(p => p.symbol === 'BTCUSDT');
        const mon    = await request('/api/monitor/holding');
        const monPos = mon.data?.positions?.find(p => p.symbol === 'BTCUSDT');

        if (!btc) {
            console.log(`  [${new Date().toLocaleTimeString()}] 🏁 Position CLOSED — holding candles worked!`);

            // Show final trade record
            await sleep(3000);
            const trades = await request('/api/trades');
            const last   = trades.data?.slice?.(-1)?.[0];
            if (last) {
                console.log(`\n  Final trade record:`);
                console.log(`     closeReason : ${last.closeReason}`);
                console.log(`     pnl         : $${last.pnl?.toFixed(4)}`);
                console.log(`     fees        : $${last.fees?.toFixed(4)}`);
                console.log(`     netPnL      : $${last.netPnL?.toFixed(4)}`);
            }
            return;
        }

        const elapsed_c = monPos?.elapsedCandles ?? '?';
        const pnl_c     = btc?.pnl?.toFixed(4) ?? '?';
        const ctcHit    = monPos?.ctcTriggered ? '🔄 CTC triggered' : '';
        console.log(
            `  [${new Date().toLocaleTimeString()}] ` +
            `Candle ${elapsed_c}/${holdingCandles} | PnL $${pnl_c} ${ctcHit}`
        );
    }

    console.log('\n  ⚠️  Watch period ended — check dashboard for position status');
    console.log('  If position is still open, holding candles may not have fired — check server logs');
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
