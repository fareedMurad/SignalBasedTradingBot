// Debug close variants to find what MEXC accepts
require('dotenv').config();
const MexcClient = require('./src/mexcClient');
const Logger = require('./src/logger');
const logger = new Logger('warn');
const config = {
    mexcApiKey: process.env.MEXC_API_KEY, mexcApiSecret: process.env.MEXC_API_SECRET,
    apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET
};
const client = new MexcClient(config, logger);

const POS_ID = 1367860445;
const variants = [
    { label: 'A: vol=3, posId, openType=1, lev=2',        body: { symbol:'DOGE_USDT', vol:3, leverage:2, side:2, type:5, openType:1, positionId:POS_ID } },
    { label: 'B: vol=3, NO posId, openType=1, lev=2',     body: { symbol:'DOGE_USDT', vol:3, leverage:2, side:2, type:5, openType:1 } },
    { label: 'C: vol=3, posId, openType=2, lev=2',        body: { symbol:'DOGE_USDT', vol:3, leverage:2, side:2, type:5, openType:2, positionId:POS_ID } },
    { label: 'D: vol=1, posId, openType=1, lev=2',        body: { symbol:'DOGE_USDT', vol:1, leverage:2, side:2, type:5, openType:1, positionId:POS_ID } },
    { label: 'E: vol=1, NO posId, openType=1, lev=2',     body: { symbol:'DOGE_USDT', vol:1, leverage:2, side:2, type:5, openType:1 } },
    { label: 'F: vol=3, posId, NO openType, lev=2',       body: { symbol:'DOGE_USDT', vol:3, leverage:2, side:2, type:5, positionId:POS_ID } },
    { label: 'G: vol=3, posId, openType=1, NO lev',       body: { symbol:'DOGE_USDT', vol:3, side:2, type:5, openType:1, positionId:POS_ID } },
    { label: 'H: vol=3, posId, openType=1, price=0, lev=2', body: { symbol:'DOGE_USDT', vol:3, leverage:2, side:2, type:5, openType:1, positionId:POS_ID, price:0 } },
];

async function tryAll() {
    console.log('Testing', variants.length, 'close order variants...\n');
    for (const v of variants) {
        try {
            const r = await client._req('POST', '/api/v1/private/order/submit', v.body);
            console.log('[SUCCESS]', v.label, '->', JSON.stringify(r));
            console.log('\n🎉 WINNER! Body was:', JSON.stringify(v.body));
            return;
        } catch (e) {
            console.log('[FAIL]', v.label, '->', e.message);
        }
        await new Promise(r => setTimeout(r, 400));
    }
    console.log('\n❌ All variants failed.');
}
tryAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
