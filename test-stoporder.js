/**
 * Test: exchange-side SL/TP via /stoporder/place
 * Tests the new order/create endpoint and stoporder/place endpoint
 */
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');

const logger = new Logger('info');
const client = new MexcClient({
    mexcApiKey:    process.env.MEXC_API_KEY,
    mexcApiSecret: process.env.MEXC_API_SECRET,
    useDemoEnv:    false,
    riskMode:      'isolated',
    leverage:      2
}, logger);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    console.log('\n═══════════════════════════════════════');
    console.log('  Testing /order/create + /stoporder/place');
    console.log('═══════════════════════════════════════\n');

    // Step 1: Get price
    const price = await client.getPrice('DOGEUSDT');
    console.log(`DOGE price: $${price}`);

    const sl = parseFloat((price * 0.97).toFixed(4));
    const tp = parseFloat((price * 1.06).toFixed(4));
    console.log(`SL: ${sl}  TP: ${tp}\n`);

    // Step 2: Open position via /order/create with SL/TP embedded
    console.log('--- Step 1: Opening position via /order/create ---');
    await client.setLeverage('DOGEUSDT', 2);
    
    let orderId;
    try {
        const res = await client.placeOrder({
            symbol: 'DOGEUSDT',
            side: 'BUY',
            type: 'MARKET',
            quantity: '100',   // 1 contract = 100 DOGE
            stopLossPrice: sl,
            takeProfitPrice: tp
        });
        orderId = res.orderId;
        console.log(`✅ Order placed: ${JSON.stringify(res)}`);
    } catch (e) {
        console.log(`❌ placeOrder failed: ${e.message}`);
        process.exit(1);
    }

    await sleep(1500);

    // Step 3: Get position to find positionId
    console.log('\n--- Step 2: Getting position ---');
    const positions = await client.getPositions('DOGEUSDT');
    const pos = positions.find(p => parseFloat(p.positionAmt) !== 0);
    if (!pos) {
        console.log('❌ No position found');
        process.exit(1);
    }
    console.log(`✅ Position: positionId=${pos._positionId} holdVol=${pos._holdVol} entry=${pos.entryPrice}`);

    // Step 4: Place TP/SL via /stoporder/place (position-level)
    console.log('\n--- Step 3: Testing /stoporder/place ---');
    const stopOrderId = await client.setPositionSLTP(
        pos._positionId,
        pos._holdVol,
        sl,
        tp
    );
    if (stopOrderId) {
        console.log(`✅ Exchange SL/TP placed! stopOrderId=${stopOrderId}`);
        console.log('   → Check MEXC app — SL/TP should now be visible in the position view!\n');
    } else {
        console.log('❌ setPositionSLTP returned null (check logs for error)');
    }

    // Step 5: Get open stop orders to verify
    console.log('\n--- Step 4: Verifying stop orders ---');
    const stopOrders = await client.getStopOrders('DOGEUSDT');
    console.log(`Stop orders (${stopOrders.length}):`, JSON.stringify(stopOrders.slice(0, 2), null, 2));

    // Step 6: Cancel SL/TP and close position
    console.log('\n--- Step 5: Cleanup ---');
    await client.cancelPositionSLTP('DOGEUSDT');
    console.log('Cancelled exchange SL/TP orders');
    
    await sleep(500);
    
    // Close position
    const positions2 = await client.getPositions('DOGEUSDT');
    if (positions2.some(p => parseFloat(p.positionAmt) !== 0)) {
        await client._req('POST', '/api/v1/private/position/close_all', { symbol: 'DOGE_USDT' });
        console.log('✅ Position closed');
    }

    const bal = await client.getBalance();
    console.log(`\nFinal balance: $${bal.available}`);
    console.log('\n🏁 Test complete');
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
