/**
 * test-capie-payload.js
 * Tests the /api/trade endpoint with the EXACT payload that capie-mvp
 * signalAlertEngine.computeTradePayload() would send.
 *
 * Run: node test-capie-payload.js
 */

const http = require('http');

// ⚠️  TEST payload — small $4 margin, low leverage to minimise exposure
// Same field structure as computeTradePayload() in signalAlertEngine.js:
//   slPips = spot_entry × slPct  (bot applies to actual futures fill price)
//   rr supplied → bot computes TP = fill ± slPips × rr
const payload = JSON.stringify({
  symbol:         'BTCUSDT',
  direction:      'BUY',          // capie-mvp sends BUY/SELL
  leverage:       10,             // LOW leverage for safe test
  riskMode:       'isolated',
  marginMode:     'dollar',       // dollar margin mode
  marginDollar:   4,              // $4 test margin — MINIMUM safe amount
  slPips:         151.20,         // same distance capie-mvp would send (0.16% of ~94500)
  rr:             1.75,           // R:R → TP = fill + slPips × 1.75
  ctcEnabled:     false,
  ctcTrigger:     0.4,
  holdingCandles: 8
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/trade',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log('\n📤 Sending payload to http://localhost:3000/api/trade:');
console.log(JSON.parse(payload));
console.log('\n⏳ Waiting for response...\n');

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.success) {
        console.log('✅ SUCCESS! Trade executed:');
        const d = parsed.data;
        console.log(`   tradeId:       ${d.tradeId}`);
        console.log(`   symbol:        ${d.symbol}`);
        console.log(`   side:          ${d.side}`);
        console.log(`   price:         ${d.price}`);
        console.log(`   stopLoss:      ${d.stopLoss}  (computed from fill ∓ slPips)`);
        console.log(`   takeProfit1:   ${d.takeProfit1}  (computed from fill ± slPips×rr)`);
        console.log(`   rr:            ${d.rr}`);
        console.log(`   holdingCandles:${d.holdingCandles}`);
        console.log(`   ctcEnabled:    ${d.ctcEnabled}`);
        console.log(`   tradeStartTime:${d.tradeStartTime}`);
      } else {
        console.log('❌ FAILED:');
        console.log(`   error: ${parsed.error}`);
      }
      console.log('\n📥 Full response:');
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log('❌ Could not parse response:', data);
    }
  });
});

req.on('error', (e) => {
  if (e.code === 'ECONNREFUSED') {
    console.log('❌ Connection refused — is the dashboard running on port 3000?');
    console.log('   Run: bash restart-dashboard.sh');
  } else {
    console.log('❌ Request error:', e.message);
  }
});

req.setTimeout(20000, () => {
  console.log('❌ Request timed out after 20s');
  req.destroy();
});

req.write(payload);
req.end();
