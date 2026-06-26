// Try MEXC dedicated close/flash-close endpoints
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');
const logger = new Logger('warn');
const config = {
    mexcApiKey: process.env.MEXC_API_KEY, mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET
};
const client = new MexcClient(config, logger);

async function run() {
    const raw = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
    if (!raw.length) { console.log('No position.'); return; }
    const pos = raw[0];
    console.log('Position:', JSON.stringify({ positionId: pos.positionId, holdVol: pos.holdVol, leverage: pos.leverage, openType: pos.openType, positionType: pos.positionType }));
    const price = await client.getPrice('DOGEUSDT');
    console.log('Current price:', price);

    const strategies = [
        // MEXC flash close all positions endpoint
        { label: 'POST /position/close_all (symbol)',
          fn: () => client._req('POST', '/api/v1/private/position/close_all', { symbol: 'DOGE_USDT' }) },

        // MEXC position close endpoint
        { label: 'POST /position/close',
          fn: () => client._req('POST', '/api/v1/private/position/close', { symbol: 'DOGE_USDT', positionId: pos.positionId, vol: pos.holdVol }) },

        // Set TP slightly below current price to trigger immediate close
        { label: `Set TP at ${(price * 0.9999).toFixed(4)} (just below market → triggers now)`,
          fn: () => client._req('POST', '/api/v1/private/position/stop_limit_order', {
              symbol: 'DOGE_USDT', positionId: pos.positionId,
              stopLossPrice: 0,  // disable SL
              takeProfitPrice: parseFloat((price * 0.9999).toFixed(4))  // TP just below current = triggers
          }) },

        // Set SL just above current price (for LONG: SL triggers if price falls below SL, so set SL=current to trigger)
        { label: `Set SL at ${(price * 1.001).toFixed(4)} (above market → triggers now for LONG)`,
          fn: () => client._req('POST', '/api/v1/private/position/stop_limit_order', {
              symbol: 'DOGE_USDT', positionId: pos.positionId,
              stopLossPrice: parseFloat((price * 1.001).toFixed(4)),  // SL above current = triggers immediately for LONG
              takeProfitPrice: 0  // disable TP
          }) },

        // Try with position close via risk order
        { label: 'POST /trigger_order (market stop)',
          fn: () => client._req('POST', '/api/v1/private/trigger_order', {
              symbol: 'DOGE_USDT', leverage: pos.leverage, side: 2, type: 5,
              openType: 1, vol: pos.holdVol, triggerType: 1,
              triggerPrice: parseFloat((price * 1.001).toFixed(4)), executeCycle: 1
          }) },

        // One-way mode: try side=3 (open short) as implicit close in one-way mode
        { label: 'side=3 openType=2 (cross short, one-way implicit close)',
          fn: () => client._req('POST', '/api/v1/private/order/submit', {
              symbol: 'DOGE_USDT', vol: pos.holdVol, leverage: pos.leverage,
              side: 3, type: 5, openType: 2
          }) },

        // Try order submit with side=2 but DIFFERENT leverage (matching position more precisely)
        { label: 'side=2 leverage=200 (max leverage override)',
          fn: () => client._req('POST', '/api/v1/private/order/submit', {
              symbol: 'DOGE_USDT', vol: pos.holdVol, leverage: 200,
              side: 2, type: 5, openType: 1, positionId: pos.positionId
          }) },
    ];

    for (const s of strategies) {
        try {
            const r = await s.fn();
            console.log(`\n[SUCCESS] ${s.label}:`, JSON.stringify(r));
            console.log('🎉 FOUND WORKING CLOSE METHOD!');
            return;
        } catch (e) {
            console.log(`[FAIL] ${s.label}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('\n❌ All strategies failed.');
    console.log('Please close the position manually in MEXC app or contract.mexc.com');
}

run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
