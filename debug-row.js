/**
 * Dumps the HTML of the BTCUSDT LONG position row so we can
 * figure out the correct selector for the TP/SL edit icon.
 *
 * Run WHILE a BTCUSDT LONG position is open in the MEXC tab.
 */
'use strict';
const puppeteer = require('puppeteer-core');

(async () => {
    const r   = await fetch('http://127.0.0.1:9222/json/version');
    const ws  = (await r.json()).webSocketDebuggerUrl;
    const br  = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const pages = await br.pages();
    const pg  = pages.find(p => p.url().includes('futures'));
    if (!pg) { console.error('No futures tab'); process.exit(1); }

    const info = await pg.evaluate(() => {
        const clean = s => s.replace(/[_\/]/g, '').toUpperCase();
        const rows  = [...document.querySelectorAll('tr[data-row-key]')];
        const row   = rows.find(r => {
            const nameEl = r.querySelector('[class*="symbolNameWrapper"],[class*="symbolName"]');
            const symMatch = nameEl && clean(nameEl.textContent).includes('BTCUSDT');
            const dirText  = (r.querySelector('[class*="longShortText"],[class*="direction"]')?.textContent || r.textContent).toLowerCase();
            return symMatch && dirText.includes('long');
        });
        if (!row) return { found: false, allRowTexts: rows.map(r => r.textContent.slice(0,80).replace(/\s+/g,' ')) };

        // Dump all elements with class names + tag + text
        const elems = [...row.querySelectorAll('*')].map(el => ({
            tag:   el.tagName,
            cls:   el.className.toString().slice(0, 80),
            text:  el.textContent.trim().slice(0, 30),
            title: el.title || el.getAttribute('aria-label') || '',
            type:  el.getAttribute('type') || ''
        })).filter(e => e.cls || e.title);

        return { found: true, html: row.innerHTML.slice(0, 3000), elems };
    });

    if (!info.found) {
        console.log('Row NOT found. All rows:');
        info.allRowTexts?.forEach(t => console.log(' -', t));
    } else {
        console.log('\n=== ELEMENTS IN ROW (with classes/titles) ===\n');
        info.elems.forEach(e =>
            console.log(`${e.tag.padEnd(10)} cls="${e.cls}" title="${e.title}" text="${e.text}"`)
        );
        console.log('\n=== RAW HTML (first 3000 chars) ===\n');
        console.log(info.html);
    }

    await br.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
