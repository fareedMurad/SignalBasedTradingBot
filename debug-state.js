// Check full account state: open orders, position details, account settings
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
    // 1. Open orders
    console.log('\n=== OPEN ORDERS (DOGE_USDT) ===');
    try {
        const orders = await client._req('GET', '/api/v1/private/order/list/open_orders/DOGE_USDT');
        const list = Array.isArray(orders) ? orders : (orders?.resultList ?? []);
        console.log('Count:', list.length);
        list.forEach(o => console.log(JSON.stringify({ orderId: o.orderId||o.id, side: o.side, vol: o.vol, state: o.state, type: o.type })));
    } catch (e) { console.log('Error:', e.message); }

    // 2. All pending orders via different endpoint
    console.log('\n=== ALL PENDING ORDERS ===');
    try {
        const pending = await client._req('GET', '/api/v1/private/order/list/open_orders/DOGE_USDT');
        console.log('Pending (raw):', JSON.stringify(pending));
    } catch (e) { console.log('Error:', e.message); }

    // 3. Position details (full)
    console.log('\n=== POSITION DETAILS ===');
    try {
        const pos = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
        pos.forEach(p => console.log(JSON.stringify({
            positionId: p.positionId, holdVol: p.holdVol, frozenVol: p.frozenVol,
            state: p.state, im: p.im, oim: p.oim, leverage: p.leverage, openType: p.openType
        })));
    } catch (e) { console.log('Error:', e.message); }

    // 4. Account settings (position mode)
    console.log('\n=== ACCOUNT SETTINGS ===');
    try {
        const settings = await client._req('GET', '/api/v1/private/account/setting');
        console.log(JSON.stringify(settings));
    } catch (e) { console.log('Error:', e.message); }

    // 5. Cancel all open orders if any, then retry close
    console.log('\n=== CANCELING ALL OPEN ORDERS ===');
    try {
        const cancelResult = await client._req('DELETE', '/api/v1/private/order/cancel_all', { symbol: 'DOGE_USDT' });
        console.log('Cancel result:', JSON.stringify(cancelResult));
    } catch (e) { console.log('Cancel error:', e.message); }

    await new Promise(r => setTimeout(r, 1000));

    // 6. Retry close after canceling orders
    console.log('\n=== RETRY CLOSE (after cancel) ===');
    try {
        const pos2 = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
        if (!pos2.length) { console.log('No position to close.'); return; }
        const p = pos2[0];
        console.log('Position now:', JSON.stringify({ positionId: p.positionId, holdVol: p.holdVol, frozenVol: p.frozenVol }));

        const body = { symbol: 'DOGE_USDT', vol: p.holdVol, leverage: p.leverage, side: 2, type: 5, openType: p.openType, positionId: p.positionId };
        console.log('Close body:', JSON.stringify(body));
        const r = await client._req('POST', '/api/v1/private/order/submit', body);
        console.log('CLOSE OK:', JSON.stringify(r));
    } catch (e) { console.log('Close error:', e.message); }
}

run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
