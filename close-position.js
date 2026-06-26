// Quick position-close helper — closes all open DOGE positions
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');

const logger = new Logger('debug');
const config = {
    mexcApiKey: process.env.MEXC_API_KEY, mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET,
    useDemoEnv: false, leverage: 2, riskMode: 'isolated'
};
const client = new MexcClient(config, logger);

async function run() {
    console.log('\n--- Current raw position ---');
    const raw = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
    raw.forEach(p => console.log(JSON.stringify({ positionId: p.positionId, holdVol: p.holdVol, frozenVol: p.frozenVol })));

    if (!raw.length || raw[0].holdVol === 0) {
        console.log('No open position.'); return;
    }

    const pos = raw[0];
    console.log(`\n--- Closing vol=${pos.holdVol} contracts via updated placeOrder (positionId auto-lookup) ---`);
    // Use our updated placeOrder which auto-looks up positionId + holdVol
    const r = await client.placeOrder({
        symbol: 'DOGEUSDT', side: 'SELL', type: 'MARKET',
        quantity: pos.holdVol * 100,  // base-asset qty (contracts * contractSize)
        reduceOnly: true, leverage: 2
    });
    console.log('CLOSE result:', JSON.stringify(r));

    await new Promise(res => setTimeout(res, 1500));
    const after = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
    console.log(`Remaining positions: ${after.length}`);
    if (!after.length) console.log('✅ Position fully closed!');
    else after.forEach(p => console.log(JSON.stringify({ holdVol: p.holdVol })));
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
