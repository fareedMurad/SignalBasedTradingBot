/**
 * Trade Flow Test Script
 * Tests BUY and SELL signals with R:R, dollar margin, software SL/TP
 */
require('dotenv').config();
const http = require('http');

function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'localhost', port: 3000, path, method,
            headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
        };
        const r = http.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    console.log('\n══════════════════════════════════════════');
    console.log('  TRADE EXECUTOR TEST — ', new Date().toISOString());
    console.log('══════════════════════════════════════════\n');

    // Status check
    const status = await req('GET', '/api/status');
    if (!status.success) { console.error('Server not running!'); process.exit(1); }
    console.log(`✅ Server up | mode: ${status.data.tradeMode} | balance: $${status.data.balance.available}`);

    // Get price
    const priceRes = await req('GET', '/api/price/BTCUSDT');
    const price = priceRes.data.price;
    console.log(`📈 BTC price: ${price}`);

    // ── Close any existing BTCUSDT position ──────────
    const posRes = await req('GET', '/api/positions');
    const existing = (posRes.data || []).find(p => p.symbol === 'BTCUSDT');
    if (existing) {
        console.log(`\n⚠️  Existing ${existing.side} position — closing...`);
        const cl = await req('POST', '/api/close/BTCUSDT');
        console.log(`  Closed: ${cl.success} PnL=${cl.pnl}`);
        await sleep(2000);
    }

    // ── TEST 1: BUY with R:R + dollar margin ────────
    console.log('\n── TEST 1: BUY LONG (direction=BUY, rr=2.5, $100 margin) ─');
    const buySL = parseFloat((price - 1500).toFixed(1));
    const buyResult = await req('POST', '/api/trade', {
        symbol: 'BTCUSDT', direction: 'BUY', stopLoss: buySL, rr: 2.5,
        leverage: 10, riskMode: 'isolated',
        marginMode: 'dollar', marginDollar: 100,
        ctcEnabled: true, ctcTrigger: 0.4, holdingCandles: 10
    });
    if (buyResult.success) {
        const r = buyResult.data;
        console.log(`  ✅ LONG trade executed`);
        console.log(`  orderId:     ${r.orderId}`);
        console.log(`  side:        ${r.side}`);
        console.log(`  quantity:    ${r.quantity} BTC`);
        console.log(`  entry:       $${r.price}`);
        console.log(`  SL:          $${r.stopLoss}`);
        console.log(`  TP1:         $${r.takeProfit1?.toFixed(2)}`);
        console.log(`  TP2:         $${r.takeProfit2?.toFixed(2)}`);
        console.log(`  TP3:         $${r.takeProfit3?.toFixed(2)}`);
        console.log(`  R:R:         1:${r.rr}`);
        console.log(`  CTC:         ${r.ctcEnabled} @ ${(r.ctcTrigger*100).toFixed(0)}%`);
        console.log(`  holdingC:    ${r.holdingCandles}`);
        console.log(`  softwareSLTP:${r.softwareSLTP}`);
    } else {
        console.log(`  ❌ FAILED: ${buyResult.error}`);
    }

    await sleep(2000);

    // ── Check positions to confirm software SL/TP ──
    console.log('\n── POSITIONS (software SL/TP from monitor) ─');
    const pos = await req('GET', '/api/positions');
    (pos.data || []).forEach(p => {
        console.log(`  ${p.symbol} ${p.side}`);
        console.log(`    SL:          ${p.stopLoss}`);
        console.log(`    TP1:         ${p.takeProfit1?.toFixed(2)}`);
        console.log(`    TP2:         ${p.takeProfit2?.toFixed(2)}`);
        console.log(`    TP3:         ${p.takeProfit3?.toFixed(2)}`);
        console.log(`    RR:          ${p.riskReward}`);
        console.log(`    softwareSLTP:${p.softwareSLTP}`);
        console.log(`    CTC trigger: ${p.ctcTriggerPrice?.toFixed(2)}`);
        console.log(`    Holding:     ${p.holdingCandles}c, elapsed ${p.elapsedCandles}c`);
        console.log(`    PnL:         $${p.pnl?.toFixed(2)}`);
    });

    // ── Close BUY before SELL ───────────────────────
    console.log('\n── Closing LONG ─');
    const cl1 = await req('POST', '/api/close/BTCUSDT');
    console.log(`  ${cl1.success ? `Closed PnL=${cl1.pnl}` : cl1.error}`);
    await sleep(3000);

    // ── TEST 2: SELL with R:R + dollar margin ───────
    const p2 = await req('GET', '/api/price/BTCUSDT');
    const price2 = p2.data.price;
    console.log(`\n── TEST 2: SELL SHORT (direction=SELL, rr=2.0, $50 margin) ─`);
    const sellSL = parseFloat((price2 + 1500).toFixed(1));
    console.log(`  BTC: ${price2} | SHORT SL: ${sellSL}`);
    const sellResult = await req('POST', '/api/trade', {
        symbol: 'BTCUSDT', direction: 'SELL', stopLoss: sellSL, rr: 2.0,
        leverage: 5, riskMode: 'isolated',
        marginMode: 'dollar', marginDollar: 50,
        ctcEnabled: false, holdingCandles: 5
    });
    if (sellResult.success) {
        const r = sellResult.data;
        console.log(`  ✅ SHORT trade executed`);
        console.log(`  side:        ${r.side}`);
        console.log(`  SL:          $${r.stopLoss}`);
        console.log(`  TP1:         $${r.takeProfit1?.toFixed(2)}`);
        console.log(`  TP3:         $${r.takeProfit3?.toFixed(2)}`);
        console.log(`  softwareSLTP:${r.softwareSLTP}`);
    } else {
        console.log(`  ❌ FAILED: ${sellResult.error}`);
    }

    await sleep(2000);

    // ── Positions after SHORT ─────────────────────
    console.log('\n── POSITIONS after SHORT ─');
    const pos2 = await req('GET', '/api/positions');
    (pos2.data || []).forEach(p => {
        console.log(`  ${p.symbol} ${p.side} | SL:${p.stopLoss} TP1:${p.takeProfit1?.toFixed(0)} TP3:${p.takeProfit3?.toFixed(0)} | software:${p.softwareSLTP} | RR:${p.riskReward}`);
    });

    // ── Close SHORT ───────────────────────────────
    console.log('\n── Closing SHORT ─');
    const cl2 = await req('POST', '/api/close/BTCUSDT');
    console.log(`  ${cl2.success ? `Closed PnL=${cl2.pnl}` : cl2.error}`);

    console.log('\n══════════════════════════════════════════');
    console.log('  ALL TESTS COMPLETE ✅');
    console.log('══════════════════════════════════════════\n');
    process.exit(0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
