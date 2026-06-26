/**
 * Test lower-fee TP strategies for MEXC:
 *  1. SET native position TP via /position/stop_limit_order  (exchange-side limit TP)
 *  2. SET plan/trigger order with limit type at TP price
 *  3. Use Post-Only close order if option 1/2 fail
 *
 * Goal: pay maker fee (~0.02%) instead of taker fee (~0.06%) on TP hits.
 */
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');

const logger = new Logger('info');
const config = {
    mexcApiKey: process.env.MEXC_API_KEY, mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET,
    useDemoEnv: false, leverage: 2, riskMode: 'isolated'
};
const client = new MexcClient(config, logger);

async function run() {
    // 1. Check current state
    const price0 = await client.getPrice('DOGEUSDT');
    console.log(`\nCurrent price: $${price0}`);

    // 2. Open a fresh small long position
    console.log('\n=== Opening fresh DOGE LONG (1 contract = 100 DOGE) ===');
    await client.setLeverage('DOGEUSDT', 2);
    const openResult = await client.placeOrder({
        symbol: 'DOGEUSDT', side: 'BUY', type: 'MARKET', quantity: 100,
        leverage: 2, openType: 1
    });
    console.log('Opened:', JSON.stringify(openResult));
    await new Promise(r => setTimeout(r, 1500));

    // Get the position
    const positions = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
    const pos = positions[0];
    if (!pos) { console.log('No position found!'); return; }
    const price = await client.getPrice('DOGEUSDT');
    console.log(`Position: positionId=${pos.positionId} holdVol=${pos.holdVol} entry=${pos.openAvgPrice}`);
    console.log(`Current price: $${price}`);

    const slPrice   = parseFloat((price * 0.92).toFixed(4));  // 8% below (SL)
    const tpPrice   = parseFloat((price * 1.08).toFixed(4));  // 8% above (TP)
    const tpLimitPx = parseFloat((price * 1.09).toFixed(4));  // limit slightly above TP trigger

    console.log(`\nSL=${slPrice}  TP=${tpPrice}  TP-limit=${tpLimitPx}`);

    // Strategy 1: Native position stop_limit_order (sets TP+SL directly on position)
    console.log('\n--- Strategy 1: /position/stop_limit_order ---');
    try {
        const r = await client._req('POST', '/api/v1/private/position/stop_limit_order', {
            symbol: 'DOGE_USDT',
            positionId: pos.positionId,
            stopLossPrice: slPrice,
            takeProfitPrice: tpPrice
        });
        console.log('[SUCCESS] stop_limit_order:', JSON.stringify(r));
        console.log('✅ Exchange-native TP set at', tpPrice, '→ MEXC will close at TP price (limit fill)');
        // This is the preferred method — clear it for next test
        await client._req('POST', '/api/v1/private/position/stop_limit_order', {
            symbol: 'DOGE_USDT', positionId: pos.positionId,
            stopLossPrice: 0, takeProfitPrice: 0  // clear it
        });
        console.log('  (Cleared TP/SL for next test)');
    } catch (e) {
        console.log('[FAIL] stop_limit_order:', e.message);
    }
    await new Promise(r => setTimeout(r, 600));

    // Strategy 2: Plan/trigger order — limit close at TP price (genuine maker fee)
    console.log('\n--- Strategy 2: /planorder/place — limit close at TP ---');
    try {
        const r = await client._req('POST', '/api/v1/private/planorder/place', {
            symbol: 'DOGE_USDT',
            leverage: pos.leverage,
            side: 2,                // close long
            type: 1,                // LIMIT order = maker fee
            vol: pos.holdVol,
            openType: pos.openType,
            positionId: pos.positionId,
            triggerType: 1,         // trigger when price >=
            triggerPrice: tpPrice,
            price: tpPrice,
            executeCycle: 87600     // valid for 3650 days
        });
        console.log('[SUCCESS] planorder/place (limit close):', JSON.stringify(r));
        console.log('✅ Limit TP plan order placed at', tpPrice, '→ maker fee when filled');
        // Cancel plan order
        try {
            await client._req('DELETE', '/api/v1/private/planorder/cancel', {
                symbol: 'DOGE_USDT', orderId: r
            });
            console.log('  (Plan order cancelled)');
        } catch (_) {}
    } catch (e) {
        console.log('[FAIL] planorder/place (limit):', e.message);
    }
    await new Promise(r => setTimeout(r, 600));

    // Strategy 3: Plan/trigger order — MARKET close at TP trigger (still avoids slippage)
    console.log('\n--- Strategy 3: /planorder/place — market close at TP trigger ---');
    try {
        const r = await client._req('POST', '/api/v1/private/planorder/place', {
            symbol: 'DOGE_USDT',
            leverage: pos.leverage,
            side: 2,                // close long
            type: 5,                // MARKET
            vol: pos.holdVol,
            openType: pos.openType,
            positionId: pos.positionId,
            triggerType: 1,
            triggerPrice: tpPrice,
            executeCycle: 87600
        });
        console.log('[SUCCESS] planorder/place (market close at TP):', JSON.stringify(r));
        console.log('✅ Market TP plan order placed → triggers at', tpPrice);
        try {
            await client._req('DELETE', '/api/v1/private/planorder/cancel', {
                symbol: 'DOGE_USDT', orderId: r
            });
            console.log('  (Plan order cancelled)');
        } catch (_) {}
    } catch (e) {
        console.log('[FAIL] planorder/place (market):', e.message);
    }
    await new Promise(r => setTimeout(r, 600));

    // Strategy 4: Post-Only close order (type=2 = post-only = always maker)
    console.log('\n--- Strategy 4: order/submit type=2 post-only limit close ---');
    try {
        const r = await client._req('POST', '/api/v1/private/order/submit', {
            symbol: 'DOGE_USDT',
            vol: pos.holdVol,
            leverage: pos.leverage,
            side: 2,                // close long
            type: 2,                // POST-ONLY limit = guaranteed maker fee
            openType: pos.openType,
            positionId: pos.positionId,
            price: tpPrice
        });
        console.log('[SUCCESS] post-only limit close at TP:', JSON.stringify(r));
        console.log('✅ Guaranteed maker fee close at', tpPrice);
    } catch (e) {
        console.log('[FAIL] post-only limit close:', e.message);
    }

    // Close the position (cleanup)
    console.log('\n=== Cleanup: close_all ===');
    await new Promise(r => setTimeout(r, 800));
    try {
        await client._req('POST', '/api/v1/private/position/close_all', { symbol: 'DOGE_USDT' });
        console.log('✅ Position closed');
    } catch (e) {
        console.log('Close failed:', e.message);
    }

    const finalBalance = await client.getBalance();
    console.log(`\nFinal balance: $${finalBalance.available}`);
}

run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
