/**
 * End-to-End Integration Test
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests the full pipeline:
 *   1.  POST /api/trade   — place a BTC BUY signal ($4 margin, RR 2.0)
 *   2.  GET  /api/positions — verify position appears in monitor
 *   3.  POST /api/positions/:symbol/sl-tp — edit SL and TP
 *   4.  POST /api/close/:symbol — close the position
 *
 * Timing is reported for each step.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE = 'http://localhost:3000';
const SYMBOL = 'BTCUSDT';
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'selfpride@@007';

// ── Helpers ────────────────────────────────────────────────────────────────

let sessionCookie = '';

function ms(n) { return `${n}ms`; }
function tag(label) { return `\x1b[36m[${label}]\x1b[0m`; }
function ok(label)  { return `\x1b[32m✅ ${label}\x1b[0m`; }
function err(label) { return `\x1b[31m❌ ${label}\x1b[0m`; }

async function api(method, path, body, label) {
    const t0 = Date.now();
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(sessionCookie ? { Cookie: sessionCookie } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    };
    const res = await fetch(`${BASE}${path}`, opts);
    const elapsed = Date.now() - t0;

    // Capture session cookie on login
    const setCk = res.headers.get('set-cookie');
    if (setCk && setCk.includes('dash_session')) {
        sessionCookie = setCk.split(';')[0];
    }

    let data;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
        data = await res.json();
    } else {
        data = await res.text();
    }

    return { status: res.status, data, elapsed };
}

function divider(title) {
    const line = '─'.repeat(55);
    console.log(`\n${line}`);
    if (title) console.log(` ${title}`);
    console.log(line);
}

// ── Main test flow ──────────────────────────────────────────────────────────

async function run() {
    console.log('\n\x1b[1m🚀 E2E Integration Test — Signal → Browser Bot → MEXC\x1b[0m');
    console.log(`   Target: ${BASE}   Symbol: ${SYMBOL}   Margin: $4\n`);

    // ── 0. Login ────────────────────────────────────────────────────────────
    divider('STEP 0 — Dashboard login');
    const loginRes = await fetch(`${BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(PASSWORD)}`,
        redirect: 'manual'
    });
    const ck = loginRes.headers.get('set-cookie') || '';
    if (ck.includes('dash_session')) {
        sessionCookie = ck.split(';')[0];
        console.log(ok(`Logged in — session cookie obtained`));
    } else {
        // If dashboard redirected us without a cookie, try the API anyway
        console.log(`  Login status: ${loginRes.status}  (will attempt API anyway)`);
    }

    // ── 1. GET live price ───────────────────────────────────────────────────
    divider('STEP 1 — Get live BTC price');
    const priceRes = await api('GET', `/api/price/${SYMBOL}`, null, 'price');
    if (priceRes.status !== 200 || !priceRes.data?.data?.price) {
        console.log(err(`Could not fetch price: ${JSON.stringify(priceRes.data)}`));
        process.exit(1);
    }
    const currentPrice = parseFloat(priceRes.data.data.price);
    console.log(ok(`BTC price = $${currentPrice.toFixed(2)}  (${ms(priceRes.elapsed)})`));

    // Compute expected SL / TP
    const slPips   = 100;          // $100 distance from entry
    const rr       = 2.0;
    const expectedSL = (currentPrice - slPips).toFixed(2);
    const expectedTP = (currentPrice + slPips * rr).toFixed(2);
    console.log(`   Expected SL ≈ $${expectedSL}  |  Expected TP ≈ $${expectedTP}`);

    // ── 2. Place trade ──────────────────────────────────────────────────────
    divider('STEP 2 — POST /api/trade  (signal payload)');

    const signal = {
        symbol:         SYMBOL,
        direction:      'BUY',       // signal provider direction
        slPips:         slPips,      // SL distance in USDT from entry
        rr:             rr,          // R:R ratio → TP computed automatically
        leverage:       10,
        riskMode:       'isolated',
        marginMode:     'dollar',
        marginDollar:   4,           // $4 margin — hard cap as requested
        ctcEnabled:     true,
        ctcTrigger:     0.4,         // 40% of TP distance
        holdingCandles: 8,           // 8 × 3-min candles = 24 min max hold
        entryTime:      Date.now()
    };

    console.log('   Signal payload:');
    for (const [k, v] of Object.entries(signal)) {
        console.log(`     ${k.padEnd(18)}: ${v}`);
    }
    console.log('');

    const t0Trade = Date.now();
    const tradeRes = await api('POST', '/api/trade', signal, 'trade');
    const tradeElapsed = Date.now() - t0Trade;

    if (tradeRes.status === 200 && tradeRes.data?.success) {
        const d = tradeRes.data.data;
        console.log(ok(`Trade placed  ⏱  ${ms(tradeElapsed)}`));
        console.log(`   tradeId    : ${d.tradeId}`);
        console.log(`   side       : ${d.side}`);
        console.log(`   price      : $${d.price}`);
        console.log(`   stopLoss   : $${d.stopLoss}`);
        console.log(`   takeProfit : $${d.takeProfit1}`);
        console.log(`   ctcEnabled : ${d.ctcEnabled}  trigger=${(d.ctcTrigger*100).toFixed(0)}%`);
        console.log(`   holding    : ${d.holdingCandles} candles`);
    } else {
        console.log(err(`Trade FAILED (HTTP ${tradeRes.status})`));
        console.log('   Response:', JSON.stringify(tradeRes.data, null, 2));
        // Continue anyway — maybe the exchange rejected it but the rest still works
    }

    // ── 3. Check positions ──────────────────────────────────────────────────
    divider('STEP 3 — GET /api/positions  (verify position in monitor)');
    await sleep(2000);   // give MEXC a moment to register the fill

    const posRes = await api('GET', '/api/positions', null, 'positions');
    let ourPos = null;
    if (posRes.status === 200 && posRes.data?.data) {
        ourPos = posRes.data.data.find(p => p.symbol === SYMBOL);
    }

    if (ourPos) {
        console.log(ok(`Position found  ⏱  ${ms(posRes.elapsed)}`));
        console.log(`   side            : ${ourPos.side}`);
        console.log(`   entryPrice      : $${ourPos.entryPrice}`);
        console.log(`   SL              : ${ourPos.stopLoss || 'n/a'}`);
        console.log(`   TP              : ${ourPos.takeProfit1 || 'n/a'}`);
        console.log(`   holdingEnabled  : ${ourPos.holdingEnabled}`);
        console.log(`   ctcEnabled      : ${ourPos.ctcEnabled}`);
    } else {
        console.log(`   ⚠️  ${SYMBOL} not yet visible in positions list — may still be filling`);
        console.log(`   All positions: ${JSON.stringify(posRes.data?.data?.map(p=>p.symbol))}`);
    }

    // ── 4. Edit SL / TP ─────────────────────────────────────────────────────
    divider('STEP 4 — POST /api/positions/:symbol/sl-tp  (edit SL + TP)');
    const newSL = parseFloat((currentPrice - 150).toFixed(2));  // wider SL
    const newTP = parseFloat((currentPrice + 400).toFixed(2));  // wider TP

    console.log(`   Setting  SL=$${newSL}  TP=$${newTP}`);

    const slTpRes = await api('POST', `/api/positions/${SYMBOL}/sl-tp`,
        { stopLoss: newSL, takeProfit1: newTP }, 'sl-tp');

    if (slTpRes.status === 200 && slTpRes.data?.success) {
        console.log(ok(`SL/TP updated  ⏱  ${ms(slTpRes.elapsed)}`));
        console.log('   Response:', JSON.stringify(slTpRes.data.data, null, 2));
    } else {
        console.log(`   ⚠️  SL/TP update returned ${slTpRes.status}: ${JSON.stringify(slTpRes.data)}`);
    }

    // ── 5. Close position ───────────────────────────────────────────────────
    divider('STEP 5 — POST /api/close/:symbol  (manual close)');
    await sleep(1500);

    const closeRes = await api('POST', `/api/close/${SYMBOL}`, {}, 'close');

    if (closeRes.status === 200 && closeRes.data?.success) {
        console.log(ok(`Position closed  ⏱  ${ms(closeRes.elapsed)}`));
        console.log(`   PnL  : $${closeRes.data.pnl?.toFixed(4) ?? 'n/a'}`);
        console.log(`   Fees : $${closeRes.data.fees?.toFixed(4) ?? 'n/a'}`);
    } else {
        console.log(`   ⚠️  Close returned ${closeRes.status}: ${JSON.stringify(closeRes.data)}`);
    }

    // ── Summary timing ──────────────────────────────────────────────────────
    divider('⏱  TIMING SUMMARY');
    console.log(`   Price fetch        : ${ms(priceRes.elapsed)}`);
    console.log(`   Signal → order     : ${ms(tradeElapsed)}   ← key metric`);
    console.log(`   SL/TP update       : ${ms(slTpRes.elapsed)}`);
    console.log(`   Position close     : ${ms(closeRes.elapsed)}`);
    console.log('');
    console.log('\x1b[32m✅ E2E test complete.\x1b[0m\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

run().catch(e => {
    console.error('\x1b[31m💥 Unhandled error:\x1b[0m', e.message);
    process.exit(1);
});
