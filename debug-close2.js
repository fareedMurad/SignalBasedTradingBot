// Try alternative close strategies for MEXC
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
    const pos = (await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' }))[0];
    if (!pos) { console.log('No position.'); return; }
    console.log('Position:', JSON.stringify({ positionId: pos.positionId, holdVol: pos.holdVol, leverage: pos.leverage, openType: pos.openType }));

    const strategies = [
        // Try API v2 endpoint
        { label: 'v2 submit vol=3 posId',
          fn: () => client._req('POST', '/api/v2/private/order/submit',
            { symbol:'DOGE_USDT', vol:3, leverage:pos.leverage, side:2, type:5, openType:pos.openType, positionId:pos.positionId }) },

        // Try dedicated position close endpoint (MEXC has this in some docs)
        { label: 'POST /position/close_position',
          fn: () => client._req('POST', '/api/v1/private/position/close_position',
            { symbol:'DOGE_USDT', positionId:pos.positionId, vol:pos.holdVol }) },

        // Try positionId as STRING
        { label: 'positionId as STRING vol=3',
          fn: () => client._req('POST', '/api/v1/private/order/submit',
            { symbol:'DOGE_USDT', vol:3, leverage:pos.leverage, side:2, type:5, openType:pos.openType, positionId: String(pos.positionId) }) },

        // Try vol=1 (partial close)
        { label: 'Partial vol=1 posId',
          fn: () => client._req('POST', '/api/v1/private/order/submit',
            { symbol:'DOGE_USDT', vol:1, leverage:pos.leverage, side:2, type:5, openType:pos.openType, positionId:pos.positionId }) },

        // Counter-trade: open SHORT of 3 vol (net flat strategy)
        { label: 'Counter-trade: open SHORT vol=3 (net flatten)',
          fn: () => client._req('POST', '/api/v1/private/order/submit',
            { symbol:'DOGE_USDT', vol:3, leverage:pos.leverage, side:3, type:5, openType:2 }) },

        // priceType=1 (index price based market, if supported)
        { label: 'vol=3 posId priceType=1',
          fn: () => client._req('POST', '/api/v1/private/order/submit',
            { symbol:'DOGE_USDT', vol:3, leverage:pos.leverage, side:2, type:5, openType:pos.openType, positionId:pos.positionId, priceProtect:true }) },

        // Try with externalOid
        { label: 'vol=3 posId + externalOid',
          fn: () => client._req('POST', '/api/v1/private/order/submit',
            { symbol:'DOGE_USDT', vol:3, leverage:pos.leverage, side:2, type:5, openType:pos.openType, positionId:pos.positionId, externalOid: Date.now().toString() }) },
    ];

    for (const s of strategies) {
        try {
            const r = await s.fn();
            console.log(`[SUCCESS] ${s.label}:`, JSON.stringify(r));
            console.log('\n🎉 WORKING STRATEGY FOUND!');
            return;
        } catch (e) {
            console.log(`[FAIL] ${s.label}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('\n❌ All strategies failed. Likely an API KEY PERMISSION issue.');
    console.log('→ Please check MEXC Account → API Management → ensure "Contract Close Order" permission is enabled');
    console.log('→ Or close the position manually in MEXC app and re-test.');
}

run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
