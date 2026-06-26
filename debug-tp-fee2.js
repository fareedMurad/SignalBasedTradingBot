/**
 * Second round of lower-fee TP tests — planorder variants without positionId,
 * and stop_limit_order with alternate URL paths.
 */
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');
const logger = new Logger('warn');
const config = {
    mexcApiKey: process.env.MEXC_API_KEY, mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET,
    useDemoEnv: false
};
const client = new MexcClient(config, logger);

async function run() {
    // Open small position
    await client.setLeverage('DOGEUSDT', 2);
    const openR = await client._req('POST', '/api/v1/private/order/submit', {
        symbol: 'DOGE_USDT', vol: 1, leverage: 2, side: 1, type: 5, openType: 1
    });
    console.log('Opened orderId:', openR);
    await new Promise(r => setTimeout(r, 1500));

    const positions = await client._req('GET', '/api/v1/private/position/open_positions', { symbol: 'DOGE_USDT' });
    const pos = positions[0];
    if (!pos) { console.log('No position!'); return; }
    const price = await client.getPrice('DOGEUSDT');
    const tpPrice = parseFloat((price * 1.08).toFixed(4));
    const slPrice = parseFloat((price * 0.92).toFixed(4));
    console.log(`pos=${pos.positionId} vol=${pos.holdVol} price=${price} tp=${tpPrice} sl=${slPrice}`);

    const variants = [
        // planorder WITHOUT positionId
        { label: 'planorder market NO positionId',
          url: '/api/v1/private/planorder/place',
          body: { symbol:'DOGE_USDT', leverage:2, side:2, type:5, vol:1, openType:1,
                  triggerType:1, triggerPrice:tpPrice, executeCycle:87600 } },

        // planorder limit WITHOUT positionId
        { label: 'planorder limit NO positionId',
          url: '/api/v1/private/planorder/place',
          body: { symbol:'DOGE_USDT', leverage:2, side:2, type:1, vol:1, openType:1,
                  triggerType:1, triggerPrice:tpPrice, price:tpPrice, executeCycle:87600 } },

        // stop_limit_order alternate URL paths
        { label: 'POST /position/stop_limit_order/change',
          url: '/api/v1/private/position/stop_limit_order/change',
          body: { symbol:'DOGE_USDT', positionId:pos.positionId, stopLossPrice:slPrice, takeProfitPrice:tpPrice } },

        { label: 'POST /position/change_stop_limit',
          url: '/api/v1/private/position/change_stop_limit',
          body: { symbol:'DOGE_USDT', positionId:pos.positionId, stopLossPrice:slPrice, takeProfitPrice:tpPrice } },

        { label: 'POST /position/change_sl_tp',
          url: '/api/v1/private/position/change_sl_tp',
          body: { symbol:'DOGE_USDT', positionId:pos.positionId, stopLossPrice:slPrice, takeProfitPrice:tpPrice } },

        // trigger order - alternate URL
        { label: 'POST /trigger_order/place',
          url: '/api/v1/private/trigger_order/place',
          body: { symbol:'DOGE_USDT', leverage:2, side:2, type:5, vol:1, openType:1,
                  triggerType:1, triggerPrice:tpPrice, executeCycle:87600 } },

        // MEXC v2 plan order
        { label: 'POST v2/planorder/place market',
          url: '/api/v2/private/planorder/place',
          body: { symbol:'DOGE_USDT', leverage:2, side:2, type:5, vol:1, openType:1,
                  triggerType:1, triggerPrice:tpPrice, executeCycle:87600 } },
    ];

    for (const v of variants) {
        try {
            const r = await client._req('POST', v.url, v.body);
            console.log(`[SUCCESS] ${v.label}:`, JSON.stringify(r));
            // Cancel if it's a plan/trigger order
            if (r && (v.url.includes('planorder') || v.url.includes('trigger'))) {
                try { await client._req('DELETE', '/api/v1/private/planorder/cancel', { symbol:'DOGE_USDT', orderId: r }); } catch(_){}
            }
        } catch (e) {
            console.log(`[FAIL] ${v.label}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 400));
    }

    // Cleanup
    await client._req('POST', '/api/v1/private/position/close_all', { symbol: 'DOGE_USDT' });
    console.log('\n✅ Position closed');
    const bal = await client.getBalance();
    console.log(`Balance: $${bal.available}`);
}

run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
