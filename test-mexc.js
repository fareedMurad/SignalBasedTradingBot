/**
 * MEXC Integration Test Script
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests every feature of the MexcClient + TradeExecutor + PositionMonitor:
 *   1. Balance fetch
 *   2. Symbol list
 *   3. Price fetch
 *   4. Symbol info (contractSize, maxLeverage)
 *   5. Set leverage (2x)
 *   6. Place a BUY market order ($1 margin, 2x leverage → ultra-small qty)
 *   7. Get positions (verify position opened)
 *   8. Full TradeExecutor.executeTrade() with R:R=2, CTC, holdingCandles
 *   9. PositionMonitor: add position, check candle counter, CTC logic
 *  10. Close position cleanly
 *
 * ⚠️  REAL MONEY — $1 margin, 2x leverage on a cheap liquid pair (DOGEUSDT)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const MexcClient   = require('./src/mexcClient');
const TradeExecutor = require('./src/tradeExecutor');
const PositionMonitor = require('./src/positionMonitor');
const StorageManager  = require('./src/storageManager');
const Logger          = require('./src/logger');

// ── minimal logger that timestamps every line ─────────────────────────────────
const logger = new Logger('debug');

// ── config block (mirrors what dashboard/server.js builds) ──────────────────
const config = {
    mexcApiKey    : process.env.MEXC_API_KEY,
    mexcApiSecret : process.env.MEXC_API_SECRET,
    apiKey        : process.env.MEXC_API_KEY,    // fallback used by MexcClient
    apiSecret     : process.env.MEXC_API_SECRET,
    tradeMode     : 'live',
    useDemoEnv    : false,
    leverage      : 2,
    riskMode      : 'isolated',
    minMarginBalance: 1
};

// ── test symbol ───────────────────────────────────────────────────────────────
// DOGE is cheap and liquid; contractSize = 1 DOGE ≈ $0.22 → 1 contract ≈ $0.22
const TEST_SYMBOL  = 'DOGEUSDT';

// ── helpers ──────────────────────────────────────────────────────────────────
function pass(msg) { console.log(`\n  ✅  ${msg}`); }
function fail(msg, err) { console.error(`\n  ❌  ${msg}`, err?.message || err); }
function section(title) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('═'.repeat(60));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
    const client = new MexcClient(config, logger);

    // ── 1. BALANCE ────────────────────────────────────────────────────────────
    section('1 · Account Balance');
    try {
        const bal = await client.getBalance();
        console.log(`  Available USDT : $${bal.available}`);
        console.log(`  Total USDT     : $${bal.total}`);
        if (bal.available < 1) {
            fail('Insufficient balance — need at least $1 USDT');
            process.exit(1);
        }
        pass(`Balance OK — $${bal.available} available`);
    } catch (e) { fail('getBalance', e); process.exit(1); }

    // ── 2. AVAILABLE SYMBOLS (first 5 USDT pairs) ────────────────────────────
    section('2 · Available Symbols (sample)');
    try {
        const symbols = await client.getAvailableSymbols();
        console.log(`  Total USDT pairs: ${symbols.length}`);
        console.log('  Sample:', symbols.slice(0, 5).map(s => s.symbol).join(', '));
        const found = symbols.find(s => s.symbol === TEST_SYMBOL);
        if (!found) { fail(`${TEST_SYMBOL} not found in symbol list`); process.exit(1); }
        pass(`${TEST_SYMBOL} found`);
    } catch (e) { fail('getAvailableSymbols', e); process.exit(1); }

    // ── 3. CURRENT PRICE ──────────────────────────────────────────────────────
    section(`3 · Price for ${TEST_SYMBOL}`);
    let currentPrice;
    try {
        currentPrice = await client.getPrice(TEST_SYMBOL);
        console.log(`  ${TEST_SYMBOL} mark price: $${currentPrice}`);
        if (!currentPrice || isNaN(currentPrice)) throw new Error('Invalid price returned');
        pass(`Price OK: $${currentPrice}`);
    } catch (e) { fail('getPrice', e); process.exit(1); }

    // ── 4. SYMBOL INFO ────────────────────────────────────────────────────────
    section(`4 · Symbol Info — ${TEST_SYMBOL}`);
    let symbolInfo;
    try {
        symbolInfo = await client.getSymbolInfo(TEST_SYMBOL);
        console.log('  symbolInfo:', JSON.stringify(symbolInfo, null, 4));
        const maxLev = await client.getMaxLeverage(TEST_SYMBOL);
        console.log(`  maxLeverage: ${maxLev}x`);
        pass('getSymbolInfo + getMaxLeverage OK');
    } catch (e) { fail('getSymbolInfo', e); process.exit(1); }

    const contractSize = symbolInfo.contractSize || 1;
    const marginDollar = 1;    // $1 margin
    const leverage     = 2;    // 2x
    const notional     = marginDollar * leverage;  // $2
    const contracts    = Math.max(1, Math.floor(notional / (currentPrice * contractSize)));
    const actualQty    = contracts * contractSize; // base-asset qty
    console.log(`\n  contractSize : ${contractSize}`);
    console.log(`  notional     : $${notional.toFixed(4)}`);
    console.log(`  contracts    : ${contracts}`);
    console.log(`  actualQty    : ${actualQty} DOGE`);

    // ── 5. SET LEVERAGE ───────────────────────────────────────────────────────
    section(`5 · Set Leverage to ${leverage}x — ${TEST_SYMBOL}`);
    try {
        await client.setLeverage(TEST_SYMBOL, leverage);
        pass(`Leverage set to ${leverage}x`);
    } catch (e) { fail('setLeverage', e); /* non-fatal, continue */ }

    // ── 6. PLACE ORDER (raw MexcClient.placeOrder) ────────────────────────────
    section('6 · Place BUY Market Order (raw MexcClient)');
    let openOrderResult;
    try {
        openOrderResult = await client.placeOrder({
            symbol   : TEST_SYMBOL,
            side     : 'BUY',
            type     : 'MARKET',
            quantity : actualQty,
            leverage,
            openType : 1   // isolated
        });
        console.log('  Order result:', JSON.stringify(openOrderResult, null, 4));
        if (!openOrderResult || !openOrderResult.orderId) throw new Error('No orderId returned');
        pass(`Order placed — orderId: ${openOrderResult.orderId}`);
    } catch (e) { fail('placeOrder (BUY market)', e); process.exit(1); }

    // wait for fill
    await sleep(2000);

    // ── 7. GET POSITIONS ──────────────────────────────────────────────────────
    section(`7 · Get Positions — ${TEST_SYMBOL}`);
    let positions;
    try {
        positions = await client.getPositions(TEST_SYMBOL);
        console.log('  Positions:', JSON.stringify(positions, null, 4));
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length === 0) {
            fail('No active position found — order may not have filled yet');
        } else {
            pass(`Active position found: ${active[0].positionAmt} ${TEST_SYMBOL}`);
        }
    } catch (e) { fail('getPositions', e); }

    // ── 8. TRADE EXECUTOR — full executeTrade() with R:R, CTC, holdingCandles ─
    section('8 · TradeExecutor.executeTrade() — signal-provider style signal');

    const executor = new TradeExecutor(client, logger, { ...config, leverage, riskMode: 'isolated' });

    // DOGE_USDT contractSize=100, so 1 contract = 100 DOGE ≈ $10.80 notional
    // At 2x leverage → min margin ≈ $5.40. Use $10 to safely buy 1 contract.
    const testSignal = {
        symbol         : TEST_SYMBOL,
        direction      : 'BUY',         // signal provider field (BUY = LONG)
        stopLoss       : parseFloat((currentPrice * 0.90).toFixed(4)),  // 10% below (allows R:R calc room)
        rr             : 2,             // 1:2 R:R → TP = entry + 2×slDist
        leverage,
        riskMode       : 'isolated',
        marginMode     : 'dollar',
        marginDollar   : 10,            // $10 margin → notional=$20 → floor(20/price/100)*100 ≥ 100
        ctcEnabled     : true,
        ctcTrigger     : 0.4,           // CTC at 40% of TP distance
        holdingCandles : 3,             // force-close after 3 × 3-min candles = 9 min
        orderType      : 'MARKET'
    };

    console.log('\n  Signal payload:\n', JSON.stringify(testSignal, null, 4));

    let execResult;
    try {
        execResult = await executor.executeTrade(testSignal);
        console.log('\n  Executor result:\n', JSON.stringify(execResult, null, 4));
        pass('TradeExecutor.executeTrade() OK');
    } catch (e) {
        fail('TradeExecutor.executeTrade', e);
        // Non-fatal — we skip monitor test but still close position
    }

    // wait for second fill
    await sleep(2000);

    // ── 9. POSITION MONITOR — add position, read live state ──────────────────
    section('9 · PositionMonitor — add position + read state');
    const storage = new StorageManager(config, logger);
    const monitor = new PositionMonitor(client, executor, logger, storage);
    monitor.start();

    if (execResult) {
        const side        = execResult.side || 'LONG';
        const entryPrice  = execResult.price || currentPrice;
        const tp1         = execResult.takeProfit1 || (currentPrice * 1.06);
        const sl          = execResult.stopLoss    || (currentPrice * 0.97);

        monitor.addPosition(TEST_SYMBOL, {
            side,
            entryPrice,
            orderType      : 'MARKET',
            ctcEnabled     : true,
            ctcTrigger     : 0.4,
            holdingCandles : 3,
            tradeStartTime : Date.now() - (2 * 60 * 1000),  // simulate 2 min elapsed
            softwareSLTP   : true,
            stopLoss       : sl,
            takeProfit1    : tp1
        });

        await sleep(1500);   // let monitor tick once

        const status = monitor.getStatus();
        const posData = status.positions.find(p => p.symbol === TEST_SYMBOL);
        console.log('\n  Monitor position state:\n', JSON.stringify(posData, null, 4));

        if (posData) {
            pass(`Monitor tracking ${TEST_SYMBOL} — elapsed candles: ${posData.elapsedCandles} / ${posData.holdingCandles}`);
        } else {
            fail('Position not found in monitor status');
        }

        // ── CTC trigger price check ───────────────────────────────────────────
        if (posData?.ctcTriggerPrice) {
            console.log(`\n  CTC trigger price : $${posData.ctcTriggerPrice}`);
            console.log(`  CTC triggered     : ${posData.ctcTriggered}`);
            pass(`CTC pre-computed at 40% of entry→TP distance`);
        }

        // ── Toggle holding OFF then ON ────────────────────────────────────────
        section('9b · Toggle holdingEnabled OFF / ON');
        try {
            await monitor.setPositionHolding(TEST_SYMBOL, false);
            pass(`${TEST_SYMBOL} holding DISABLED`);
            await sleep(500);
            await monitor.setPositionHolding(TEST_SYMBOL, true);
            pass(`${TEST_SYMBOL} holding RE-ENABLED`);
        } catch (e) { fail('setPositionHolding', e); }

        monitor.removePosition(TEST_SYMBOL);
    }

    monitor.stop();

    // ── 10. CLOSE ALL POSITIONS ───────────────────────────────────────────────
    section('10 · Close All Open Positions (market, reduceOnly)');
    await sleep(1000);
    try {
        const allPositions = await client.getPositions(TEST_SYMBOL);
        const active       = allPositions.filter(p => parseFloat(p.positionAmt) !== 0);
        console.log(`  Active positions to close: ${active.length}`);

        for (const pos of active) {
            const qty     = Math.abs(parseFloat(pos.positionAmt));
            const isLong  = parseFloat(pos.positionAmt) > 0;
            const closeSide = isLong ? 'SELL' : 'BUY';

            console.log(`  Closing ${pos.symbol}: ${closeSide} ${qty}`);
            const closeResult = await client.placeOrder({
                symbol     : pos.symbol,
                side       : closeSide,
                type       : 'MARKET',
                quantity   : qty,
                reduceOnly : true,
                leverage
            });
            console.log('  Close result:', JSON.stringify(closeResult, null, 4));
            pass(`Position ${pos.symbol} closed`);
        }

        if (active.length === 0) {
            console.log('  ℹ️  No active positions to close (may have been closed by monitor)');
            pass('No open positions remain');
        }
    } catch (e) { fail('Close positions', e); }

    // ── FINAL BALANCE ─────────────────────────────────────────────────────────
    section('Final Balance Check');
    try {
        const finalBal = await client.getBalance();
        console.log(`  Final available USDT: $${finalBal.available}`);
        pass('All tests completed — check balance above for P&L');
    } catch (e) { fail('Final balance', e); }

    console.log('\n' + '═'.repeat(60));
    console.log('  🏁  MEXC Integration Test Complete');
    console.log('═'.repeat(60) + '\n');
    process.exit(0);
}

run().catch(err => {
    console.error('\n💥 Unhandled error:', err);
    process.exit(1);
});
