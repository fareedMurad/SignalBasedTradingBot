// close-btc-test.js — closes the test BTCUSDT position opened by test-capie-payload.js
require('dotenv').config();
const { createExchangeClient } = require('./src/exchangeClient');
const Logger = require('./src/logger');

const logger = new Logger('info');
const config = {
    mexcApiKey:    process.env.MEXC_API_KEY,
    mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey:        process.env.MEXC_API_KEY,
    apiSecret:     process.env.MEXC_API_SECRET,
    tradeMode:     process.env.TRADE_MODE || 'live',
    useDemoEnv:    process.env.USE_DEMO_ENV === 'true'
};
const client = createExchangeClient(config, logger);

(async () => {
    try {
        const positions = await client.getPositions('BTCUSDT');
        const pos = positions.find(p => p.symbol === 'BTCUSDT' && parseFloat(p.positionAmt) !== 0);
        if (!pos) {
            console.log('✅ No open BTCUSDT position — already closed or never opened.');
            return;
        }
        const qty  = Math.abs(parseFloat(pos.positionAmt));
        const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
        const pnl  = parseFloat(pos.unRealizedProfit ?? pos.unrealizedProfit ?? 0);
        console.log(`Found: qty=${qty} side=${side} PnL=$${pnl.toFixed(4)}`);

        await client.cancelAllOrders('BTCUSDT').catch(() => {});
        const r = await client.placeOrder({
            symbol:     'BTCUSDT',
            side,
            type:       'MARKET',
            quantity:   qty.toString(),
            reduceOnly: 'true'
        });
        console.log(`✅ BTCUSDT closed. PnL=$${pnl.toFixed(4)} orderId=${r.orderId}`);
    } catch (e) {
        console.error('❌', e.message);
    }
})();
