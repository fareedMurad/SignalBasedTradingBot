/**
 * E2E Test Launcher
 * Starts the dashboard server, waits for it, runs all test steps, prints timing.
 */
'use strict';
require('dotenv').config();

const { spawn } = require('child_process');
const http      = require('http');
const https     = require('https');
const path      = require('path');

const BASE     = 'http://localhost:3000';
const SYMBOL   = 'BTCUSDT';
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'selfpride@@007';

// ── HTTP helper ─────────────────────────────────────────────────────────────
function request(method, urlStr, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const u   = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const opts = {
            hostname: u.hostname,
            port:     u.port || (u.protocol === 'https:' ? 443 : 80),
            path:     u.pathname + u.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };
        if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

        const t0  = Date.now();
        const req = mod.request(opts, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                const elapsed = Date.now() - t0;
                // Capture set-cookie
                const ck = res.headers['set-cookie'] || [];
                let cookie = '';
                ck.forEach(c => { if (c.includes('dash_session')) cookie = c.split(';')[0]; });
                let data;
                try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ status: res.statusCode, data, elapsed, cookie, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ── Divider ──────────────────────────────────────────────────────────────────
function divider(title) {
    const line = '─'.repeat(58);
    console.log('\n' + line);
    if (title) console.log(' ' + title);
    console.log(line);
}
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', E = '\x1b[0m', BOLD = '\x1b[1m';

// ── Wait for server ──────────────────────────────────────────────────────────
function waitForServer(url, tries = 20) {
    return new Promise((resolve, reject) => {
        let n = 0;
        const check = () => {
            http.get(url, res => {
                res.resume();
                resolve();
            }).on('error', () => {
                if (++n >= tries) return reject(new Error('Server did not start in time'));
                setTimeout(check, 500);
            });
        };
        check();
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n${BOLD}🚀 E2E Integration Test — Signal → Browser Bot → MEXC${E}`);
    console.log(`   Base: ${BASE}   Symbol: ${SYMBOL}   Margin: $4\n`);

    // Start dashboard server as child process
    const srvPath = path.join(__dirname, 'dashboard', 'server.js');
    const srv = spawn(process.execPath, [srvPath], {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const srvLogs = [];
    srv.stdout.on('data', d => { process.stdout.write(`${B}[SRV]${E} ${d}`); srvLogs.push(d.toString()); });
    srv.stderr.on('data', d => { process.stderr.write(`${Y}[SRV-ERR]${E} ${d}`); });

    // Wait up to 10s for the server to be ready
    try {
        await waitForServer(`${BASE}/api/status`, 20);
        console.log(`\n${G}✅ Dashboard server is up${E}`);
    } catch (e) {
        console.error(`${R}❌ Dashboard server failed to start: ${e.message}${E}`);
        srv.kill();
        process.exit(1);
    }

    let sessionCookie = '';

    // ── STEP 0: Login ─────────────────────────────────────────────────────────
    divider('STEP 0 — Dashboard login');
    const loginUrl  = `${BASE}/login`;
    const loginBody = `password=${encodeURIComponent(PASSWORD)}`;
    const loginOpts = {
        hostname: 'localhost', port: 3000,
        path: '/login', method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(loginBody)
        }
    };
    const loginCookie = await new Promise(res => {
        const req = http.request(loginOpts, r => {
            r.resume();
            const ck = (r.headers['set-cookie'] || []).find(c => c.includes('dash_session')) || '';
            res(ck.split(';')[0]);
        });
        req.on('error', () => res(''));
        req.write(loginBody);
        req.end();
    });
    if (loginCookie) {
        sessionCookie = loginCookie;
        console.log(`${G}✅ Logged in — cookie: ${sessionCookie.slice(0,40)}...${E}`);
    } else {
        console.log(`${Y}⚠️  Login did not return cookie — proceeding (trade endpoint is public)${E}`);
    }

    const authHdr = sessionCookie ? { Cookie: sessionCookie } : {};

    // ── STEP 1: Get price ──────────────────────────────────────────────────────
    divider('STEP 1 — Get live BTC price');
    const priceR = await request('GET', `${BASE}/api/price/${SYMBOL}`, null, authHdr);
    if (!priceR.data?.data?.price) {
        console.error(`${R}❌ Could not get price${E}`, priceR.data);
        srv.kill(); process.exit(1);
    }
    const price = parseFloat(priceR.data.data.price);
    const slPips = 100, rr = 2.0;
    console.log(`${G}✅ BTC = $${price.toFixed(2)}${E}  (${priceR.elapsed}ms)`);
    console.log(`   Expected SL ≈ $${(price - slPips).toFixed(2)}  |  TP ≈ $${(price + slPips*rr).toFixed(2)}`);

    // ── STEP 2: Place trade ────────────────────────────────────────────────────
    divider('STEP 2 — POST /api/trade  ($4 margin, RR 2.0)');
    const signal = {
        symbol: SYMBOL,
        direction: 'BUY',
        slPips,
        rr,
        leverage: 10,
        riskMode: 'isolated',
        marginMode: 'dollar',
        marginDollar: 4,
        ctcEnabled: true,
        ctcTrigger: 0.4,
        holdingCandles: 8,
        entryTime: Date.now()
    };
    console.log('   Payload:');
    Object.entries(signal).forEach(([k,v]) => console.log(`     ${k.padEnd(18)}: ${v}`));
    console.log('');

    const t0 = Date.now();
    const tradeR = await request('POST', `${BASE}/api/trade`, JSON.stringify(signal));
    const tradeMs = Date.now() - t0;

    if (tradeR.status === 200 && tradeR.data?.success) {
        const d = tradeR.data.data;
        console.log(`${G}✅ Trade placed  ⏱  ${tradeMs}ms${E}`);
        console.log(`   tradeId    : ${d.tradeId}`);
        console.log(`   side       : ${d.side}`);
        console.log(`   price      : $${d.price}`);
        console.log(`   stopLoss   : $${d.stopLoss}`);
        console.log(`   takeProfit : $${d.takeProfit1}`);
        console.log(`   ctcEnabled : ${d.ctcEnabled}  trigger=${(d.ctcTrigger*100).toFixed(0)}%`);
        console.log(`   holding    : ${d.holdingCandles} candles  startTime=${new Date(d.tradeStartTime).toISOString()}`);
    } else {
        console.log(`${R}❌ Trade FAILED (HTTP ${tradeR.status})${E}`);
        console.log(JSON.stringify(tradeR.data, null, 2));
    }

    // ── STEP 3: Verify positions ───────────────────────────────────────────────
    divider('STEP 3 — GET /api/positions  (2s after trade)');
    await new Promise(r => setTimeout(r, 2000));
    const posR = await request('GET', `${BASE}/api/positions`, null, authHdr);
    const ourPos = posR.data?.data?.find(p => p.symbol === SYMBOL);
    if (ourPos) {
        console.log(`${G}✅ Position in monitor  ⏱  ${posR.elapsed}ms${E}`);
        console.log(`   side           : ${ourPos.side}`);
        console.log(`   entryPrice     : $${ourPos.entryPrice}`);
        console.log(`   SL             : ${ourPos.stopLoss || 'n/a'}`);
        console.log(`   TP             : ${ourPos.takeProfit1 || 'n/a'}`);
        console.log(`   holdingEnabled : ${ourPos.holdingEnabled}`);
        console.log(`   ctcEnabled     : ${ourPos.ctcEnabled}`);
        console.log(`   unrealisedPnL  : $${ourPos.pnl?.toFixed(4) ?? 'n/a'}`);
    } else {
        console.log(`${Y}⚠️  ${SYMBOL} not in positions yet${E}  (may still be filling)`);
        console.log(`   All open: ${JSON.stringify((posR.data?.data||[]).map(p=>p.symbol))}`);
    }

    // ── STEP 4: Edit SL / TP ──────────────────────────────────────────────────
    divider('STEP 4 — POST /api/positions/:symbol/sl-tp  (widen SL+TP)');
    const newSL = parseFloat((price - 150).toFixed(2));
    const newTP = parseFloat((price + 420).toFixed(2));
    console.log(`   New SL = $${newSL}   New TP = $${newTP}`);

    const slTpR = await request('POST', `${BASE}/api/positions/${SYMBOL}/sl-tp`,
        JSON.stringify({ stopLoss: newSL, takeProfit1: newTP }), authHdr);

    if (slTpR.status === 200 && slTpR.data?.success) {
        console.log(`${G}✅ SL/TP updated  ⏱  ${slTpR.elapsed}ms${E}`);
        console.log('   data:', JSON.stringify(slTpR.data.data));
    } else {
        console.log(`${Y}⚠️  SL/TP returned ${slTpR.status}${E}: ${JSON.stringify(slTpR.data)}`);
    }

    // ── STEP 5: Close ─────────────────────────────────────────────────────────
    divider('STEP 5 — POST /api/close/:symbol  (market close)');
    await new Promise(r => setTimeout(r, 1500));

    const closeR = await request('POST', `${BASE}/api/close/${SYMBOL}`, JSON.stringify({}), authHdr);

    if (closeR.status === 200 && closeR.data?.success) {
        console.log(`${G}✅ Position closed  ⏱  ${closeR.elapsed}ms${E}`);
        console.log(`   realised PnL : $${closeR.data.pnl?.toFixed(4) ?? 'n/a'}`);
        console.log(`   fees est.    : $${closeR.data.fees?.toFixed(4) ?? 'n/a'}`);
    } else {
        console.log(`${Y}⚠️  Close returned ${closeR.status}${E}: ${JSON.stringify(closeR.data)}`);
    }

    // ── Timing summary ────────────────────────────────────────────────────────
    divider('⏱  TIMING SUMMARY');
    console.log(`   ${B}Step${E}                  ${B}Latency${E}`);
    console.log(`   ${'Price fetch'.padEnd(22)} ${priceR.elapsed}ms`);
    console.log(`   ${'Signal → order'.padEnd(22)} ${BOLD}${tradeMs}ms${E}   ← key metric`);
    console.log(`   ${'Positions query'.padEnd(22)} ${posR.elapsed}ms`);
    console.log(`   ${'SL/TP update'.padEnd(22)} ${slTpR.elapsed}ms`);
    console.log(`   ${'Position close'.padEnd(22)} ${closeR.elapsed}ms`);
    console.log('');
    console.log(`${G}${BOLD}✅  E2E test complete.${E}\n`);

    srv.kill();
    process.exit(0);
}

main().catch(e => {
    console.error('\x1b[31m💥 Test crashed:\x1b[0m', e.message);
    process.exit(1);
});
