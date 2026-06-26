/**
 * Opens a $4 BTCUSDT LONG, waits 8 s for the row to render,
 * then dumps ALL classes/titles of elements inside the position row,
 * then closes the position.
 */
'use strict';
require('dotenv').config();

const http      = require('http');
const puppeteer = require('puppeteer-core');

// ── tiny HTTP helper ─────────────────────────────────────────────────────────
function post(path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: 'localhost', port: 3000, path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve(JSON.parse(raw)));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    // 1) Place a $4 BTC LONG trade
    console.log('Placing $4 BTC LONG trade...');
    const t = await post('/api/trade', {
        symbol: 'BTCUSDT', direction: 'BUY', slPips: 100, rr: 2,
        leverage: 10, riskMode: 'isolated', marginMode: 'dollar', marginDollar: 4
    });
    if (!t.success) { console.error('Trade failed:', JSON.stringify(t)); process.exit(1); }
    console.log('Trade placed:', t.data.tradeId, '— waiting 8 s for MEXC UI to render row...');
    await sleep(8000);

    // 2) Connect to Chrome and inspect the position row
    const cdpResp = await fetch('http://127.0.0.1:9222/json/version');
    const ws = (await cdpResp.json()).webSocketDebuggerUrl;
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const pages   = await browser.pages();
    const page    = pages.find(p => p.url().includes('futures'));
    if (!page) { console.error('No MEXC futures tab'); process.exit(1); }

    const dump = await page.evaluate(() => {
        const clean = s => s ? s.replace(/[_\/]/g, '').toUpperCase() : '';

        // Find our BTCUSDT LONG row
        const rows = [...document.querySelectorAll('tr[data-row-key]')];
        let targetRow = null;

        for (const row of rows) {
            const nameEl = row.querySelector('[class*="symbolNameWrapper"],[class*="symbolName"],[class*="Symbol"]');
            const symOk  = nameEl && clean(nameEl.textContent).includes('BTCUSDT');
            const rowTxt = row.textContent.toLowerCase();
            const dirOk  = rowTxt.includes('long');
            if (symOk && dirOk) { targetRow = row; break; }
        }

        if (!targetRow) {
            return {
                found: false,
                totalRows: rows.length,
                allRowsPeek: rows.map(r => r.textContent.slice(0, 80).replace(/\s+/g, ' ').trim())
            };
        }

        // Dump EVERY element in the row with class info
        const allEls = [...targetRow.querySelectorAll('*')].map(el => ({
            tag:   el.tagName,
            cls:   (el.className || '').toString().replace(/\s+/g, ' ').slice(0, 120),
            text:  el.textContent.trim().slice(0, 25),
            title: el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-testid') || ''
        })).filter(e => e.cls.length > 0 || e.title.length > 0);

        return {
            found:    true,
            rowHtml:  targetRow.innerHTML.slice(0, 5000),
            elements: allEls
        };
    });

    if (!dump.found) {
        console.log('\n❌ Row NOT found in MEXC UI! Total rows:', dump.totalRows);
        dump.allRowsPeek?.forEach((r, i) => console.log(`  [${i}]`, r));
    } else {
        console.log('\n═══════════════════════════════════════════════════════');
        console.log(' ALL ELEMENTS in BTCUSDT LONG position row');
        console.log('═══════════════════════════════════════════════════════');
        dump.elements.forEach(e =>
            console.log(`${e.tag.padEnd(8)} | "${e.cls}" | title="${e.title}" | "${e.text}"`)
        );
        console.log('\n═══════════════════════════════════════════════════════');
        console.log(' RAW HTML (first 5000 chars)');
        console.log('═══════════════════════════════════════════════════════');
        console.log(dump.rowHtml);
    }

    await browser.disconnect();

    // 3) Close the position
    console.log('\nClosing position...');
    const cl = await post('/api/close/BTCUSDT', {});
    console.log('Close:', cl.success ? `OK  PnL=$${cl.pnl?.toFixed(4)}` : JSON.stringify(cl));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
