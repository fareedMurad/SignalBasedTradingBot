/**
 * inspect-confirm-modal.js
 *
 * Opens a BTC LONG, navigates to the EditStopOrder form,
 * fills TP/SL, then dumps the DOM JUST BEFORE any confirmation
 * so we can see the exact HTML of the "Liquidation near" warning modal.
 */
'use strict';
require('dotenv').config();
const http      = require('http');
const puppeteer = require('puppeteer-core');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function post(path, body) {
    return new Promise((res, rej) => {
        const b = JSON.stringify(body);
        const r = http.request({
            hostname: 'localhost', port: 3000, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
        }, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(JSON.parse(d))); });
        r.on('error', rej); r.write(b); r.end();
    });
}

async function main() {
    // 1. Place trade
    console.log('Placing $4 BTC LONG...');
    const t = await post('/api/trade', {
        symbol: 'BTCUSDT', direction: 'BUY', slPips: 100, rr: 2,
        leverage: 10, riskMode: 'isolated', marginMode: 'dollar', marginDollar: 4
    });
    if (!t.success) { console.error('Trade failed:', t); process.exit(1); }
    console.log('Trade placed:', t.data.tradeId);
    await sleep(6000); // Let position row render

    // 2. Connect to Chrome
    const cdp = await fetch('http://127.0.0.1:9222/json/version');
    const ws  = (await cdp.json()).webSocketDebuggerUrl;
    const br  = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const pages = await br.pages();
    const pg  = pages.find(p => p.url().includes('futures'));
    if (!pg) throw new Error('No futures tab');

    // 3. Click the edit icon in the position row (with hover events)
    const step1 = await pg.evaluate(() => {
        const clean = s => s.replace(/[_\/]/g,'').toUpperCase();
        const rows = [...document.querySelectorAll('tr[data-row-key]')];
        const row  = rows.find(r => clean(r.querySelector('[class*="symbolNameWrapper"]')?.textContent||'').includes('BTCUSDT')
                                 && r.textContent.toLowerCase().includes('long'));
        if (!row) return { ok: false };
        ['mouseover','mouseenter','mousemove'].forEach(ev =>
            row.dispatchEvent(new MouseEvent(ev, { bubbles: true })));
        const cell = row.querySelector('[class*="TpslRecordAndBtn"],[class*="tpslRecord"]');
        if (cell) ['mouseover','mouseenter','mousemove'].forEach(ev =>
            cell.dispatchEvent(new MouseEvent(ev, { bubbles: true })));
        const icon = row.querySelector('[class*="singleOrderEdit__"]');
        if (!icon) return { ok: false, error: 'edit icon not found' };
        icon.click();
        return { ok: true };
    });
    if (!step1.ok) { console.error('Step1 fail:', step1.error); process.exit(1); }
    console.log('Step 1: Clicked edit icon');
    await sleep(700);

    // 4. Click secondary edit button in settings panel
    await pg.evaluate(() => {
        const btns = [...document.querySelectorAll('[class*="TpslRecordAndBtn_edit__"]')]
            .filter(e => e.offsetParent !== null);
        if (btns.length) btns[0].click();
    });
    console.log('Step 3: Clicked settings panel edit');
    await sleep(1000);

    // 5. Fill TP/SL values
    const priceInput = await pg.evaluate(() =>
        document.querySelectorAll('input[placeholder="Trigger Price"]').length
    );
    console.log('Trigger Price inputs visible:', priceInput);

    await pg.evaluate(() => {
        const fill = (el, v) => {
            el.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v);
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
        };
        const all = [...document.querySelectorAll('input[placeholder="Trigger Price"]')]
            .filter(e => e.offsetParent !== null);
        if (all.length >= 2) {
            fill(all[all.length-2], '90000'); // obviously wrong TP — triggers warning
            fill(all[all.length-1], '70000'); // obviously wrong SL
        }
    });
    console.log('Step 5: Filled TP/SL with test values (90000/70000)');
    await sleep(500);

    // 6. Click form submit / Enter
    await pg.evaluate(() => {
        const all = [...document.querySelectorAll('input[placeholder="Trigger Price"]')]
            .filter(e => e.offsetParent !== null);
        if (all.length) {
            all[all.length-1].dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',keyCode:13}));
        }
        // Also click any primary button in form
        const btns = [...document.querySelectorAll('button')].filter(b =>
            b.offsetParent && !b.disabled && /btn-v2-primary|ant-btn-primary/i.test(b.className)
            && !/tertiary|secondary|close long|close short|flash|reverse|add more|withdraw/i.test(b.className+b.textContent));
        if (btns.length) btns[0].click();
    });
    console.log('Step 6: Submitted form');
    await sleep(800);

    // 7. DUMP all visible modals / dialogs
    const dump = await pg.evaluate(() => {
        const result = {
            bodyHtml: document.body.innerHTML.length,
            modals: []
        };
        // Look for all modal-like elements
        const modalSelectors = [
            '.ant-modal', '.ant-modal-wrap', '.ant-modal-confirm',
            '[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]',
            '[class*="Warning"],[class*="warning"],[class*="Confirm"],[class*="confirm"]'
        ];
        const seen = new Set();
        for (const sel of modalSelectors) {
            for (const el of document.querySelectorAll(sel)) {
                if (seen.has(el)) continue;
                seen.add(el);
                if (!el.offsetParent && getComputedStyle(el).display === 'none') continue;
                result.modals.push({
                    tag:  el.tagName,
                    cls:  (el.className||'').toString().slice(0,100),
                    text: el.textContent.trim().slice(0,200),
                    buttons: [...el.querySelectorAll('button')].map(b => ({
                        cls:  (b.className||'').slice(0,80),
                        text: b.textContent.trim().slice(0,30),
                        vis:  b.offsetParent !== null,
                        dis:  b.disabled
                    }))
                });
            }
        }
        return result;
    });

    console.log('\n════════════════════════════════════════════════════');
    console.log(' VISIBLE MODALS/DIALOGS after form submit');
    console.log('════════════════════════════════════════════════════');
    dump.modals.forEach((m, i) => {
        console.log(`\n[${i}] ${m.tag} class="${m.cls}"`);
        console.log(`    text: "${m.text.replace(/\s+/g,' ')}"`);
        m.buttons.forEach(b => console.log(`    btn  vis=${b.vis} dis=${b.dis} cls="${b.cls}" text="${b.text}"`));
    });

    await br.disconnect();

    // Close position
    console.log('\nClosing position...');
    try {
        const cl = await post('/api/close/BTCUSDT', {});
        console.log('Close:', JSON.stringify(cl));
    } catch(e) { console.log('Close error:', e.message); }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
