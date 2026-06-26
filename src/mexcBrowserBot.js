/**
 * MEXC Browser Bot — v6
 *
 * APIs:
 *   placeTrade({ direction, marginUsdt, leverage, tpPrice, slPrice })
 *   updateTpSl({ symbol, direction, tpPrice, slPrice })
 *   closeTrade({ symbol, direction })
 *
 * All DOM work runs inside page.evaluate() — confirmed reliable pattern.
 *
 * Selectors (confirmed from live HTML):
 *   Position row:        tr[data-row-key] containing symbol + long/short text
 *   Edit TP/SL icon:     [class*="singleOrderEdit__"] (in position row)
 *   Edit icon in modal:  [class*="TpslRecordAndBtn_edit__"]
 *   EditStopOrder modal: [class*="EditStopOrder_modal"]
 *   TP input:            first  input[placeholder="Trigger Price"] in EditStopOrder modal
 *   SL input:            second input[placeholder="Trigger Price"] in EditStopOrder modal
 *   Confirm btn:         [class*="EditStopOrder_footerWrap"] button.ant-btn-v2-primary
 *   Flash Close:         button[class*="flashCloseBtn"]
 *   Close Long/Short:    button whose text is "Close Long" or "Close Short" in row
 */
'use strict';

const puppeteer = require('puppeteer-core');
const CDP_HTTP  = 'http://127.0.0.1:9222';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class MexcBrowserBot {
    constructor() {
        this.browser          = null;
        this.page             = null;
        this._trading         = false;   // true while placeTrade() is running — suppresses keep-alive
        this._reloading       = false;   // true while KeepAlive page.reload() is in flight
        this._keepAliveTimer  = null;
        this._positionChecker = null;    // optional fn() → bool: true = open position exists
    }

    /**
     * Register a callback that returns true when at least one position is being monitored.
     * The keep-alive will skip page refreshes while any position is open.
     *
     * Usage in server.js (after monitor is created):
     *   mexcBot.setPositionChecker(() => monitor.monitoredPositions.size > 0);
     */
    setPositionChecker(fn) {
        this._positionChecker = fn;
    }

    async connect() {
        let ws;
        try {
            const r = await fetch(`${CDP_HTTP}/json/version`);
            ws = (await r.json()).webSocketDebuggerUrl;
        } catch {
            throw new Error(`Chrome not reachable on ${CDP_HTTP}. Start Chrome with --remote-debugging-port=9222`);
        }
        // protocolTimeout (ms) caps individual CDP calls (page.evaluate, page.$$, etc.).
        // Default is 180_000 (3 min) — exactly what caused the 3-min CTC delay when
        // a page.evaluate() hung.  25s is enough for any real DOM operation;
        // a hung call will now fail fast so the monitor can log "in-memory only"
        // and move on rather than blocking for 3 full minutes.
        this.browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 25_000 });
        const pages  = await this.browser.pages();
        this.page    = pages.find(p => p.url().includes('futures')) || null;
        if (!this.page) throw new Error('No MEXC futures tab found.');
        console.log(`✅ Connected: ${this.page.url()}`);

        // ── Block analytics/tracking at CDP level ──────────────────────────
        // These scripts run permanently in the background consuming V8 heap:
        //   Google Analytics, GTM, Hotjar, Sentry, Clarity, DoubleClick, etc.
        // Blocking them via CDP Network.setBlockedURLs intercepts at the Chromium
        // network stack — they are never fetched, never parsed, never run.
        // Applied on every page reload (keep-alive), not just initial load.
        // ⚠️  Uses a SHORT-LIVED CDP session (created + immediately detached) so
        // it never holds onto the session socket or leaks a listener.
        try {
            const _cdp = await this.page.createCDPSession();
            await _cdp.send('Network.enable');
            await _cdp.send('Network.setBlockedURLs', {
                urls: [
                    '*google-analytics.com*',
                    '*googletagmanager.com*',
                    '*hotjar.com*',
                    '*sentry.io*',
                    '*clarity.ms*',
                    '*amplitude.com*',
                    '*segment.io*',
                    '*seg-api.com*',
                    '*mixpanel.com*',
                    '*datadog*',
                    '*intercomcdn.com*',
                    '*intercom.io*',
                    '*doubleclick.net*',
                    '*adsystem.com*',
                    '*.ads.com*',
                    '*adservice*',
                    '*bat.bing.com*',
                    '*analytics.tiktok.com*'
                ]
            });
            await _cdp.detach();
            console.log('🚫 [Chrome] Analytics / tracking scripts blocked via CDP');
        } catch (cdpErr) {
            console.warn(`⚠️  [Chrome] CDP analytics block failed (non-fatal): ${cdpErr.message}`);
        }

        this.startKeepAlive();   // begin background refresh cycle
        this.startHealthProber(); // proactive CDP health check every 60s

        // Tick the TP/SL checkbox on the CURRENT page immediately at connect —
        // the keep-alive only ticks it AFTER a reload (5-8 min delay), leaving
        // it unchecked until then.  Without this, a signal arriving in the first
        // 5-8 minutes would fire a trade WITHOUT TP/SL fields visible → fail or
        // place a naked position.
        this._enableTpSlCheckbox()
            .then(() => console.log('✅ [Connect] TP/SL checkbox armed on existing page'))
            .catch(e  => console.warn('⚠️  [Connect] Initial TP/SL arm failed (will retry on first trade):', e.message));
    }

    async disconnect() {
        this.stopKeepAlive();
        this.stopHealthProber();
        if (this.browser) { await this.browser.disconnect(); this.browser = null; this.page = null; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Background CDP Health Prober
    //
    //  Runs every 60 seconds while not trading. Performs a trivial page.evaluate()
    //  to confirm the Puppeteer→Chrome CDP WebSocket is still alive.
    //  If it fails (network drop, Chrome restart, stale session), it proactively
    //  calls connect() in the background — so when the next signal arrives the
    //  page is already fresh and connect() never runs on the hot path.
    //
    //  This eliminates the 300–950ms "connect() on signal path" latency seen in
    //  logs at 2026-06-08T14:04 (949ms) and 2026-06-09T20:15 (540ms).
    // ─────────────────────────────────────────────────────────────────────────

    startHealthProber() {
        this.stopHealthProber();
        // Stagger the first probe by 30s so it doesn't fire right after connect().
        this._healthProberTimer = setTimeout(() => this._healthProbeLoop(), 30_000);
    }

    stopHealthProber() {
        if (this._healthProberTimer) {
            clearTimeout(this._healthProberTimer);
            this._healthProberTimer = null;
        }
    }

    async _healthProbeLoop() {
        await this._healthProbe();
        // Reschedule next probe in ~60s (regardless of probe outcome)
        this._healthProberTimer = setTimeout(() => this._healthProbeLoop(), 60_000);
    }

    /**
     * One CDP health-probe cycle.
     * Checks 3 levels of staleness:
     *   1. browser reference gone / browser.connected=false → full connect()
     *   2. page reference gone or page.isClosed()          → full connect()
     *   3. trivial page.evaluate() throws                  → full connect()
     *
     * Skipped entirely while a trade is in progress (_trading=true) or a
     * keep-alive reload is active (_reloading=true) — those already guarantee a
     * live connection.
     */
    async _healthProbe() {
        // Skip during active trading or keep-alive reload — connection is definitely alive
        if (this._trading || this._reloading) {
            console.log('⏭️  [HealthProbe] Skipped — trade/reload in progress');
            return;
        }

        try {
            // Level 1: browser WebSocket liveness
            if (!this.browser || !this.browser.connected) {
                console.warn('🔌 [HealthProbe] browser.connected=false — reconnecting proactively…');
                await this.connect();
                return;
            }

            // Level 2: page object validity
            if (!this.page || this.page.isClosed()) {
                console.warn('🔌 [HealthProbe] page closed/null — reconnecting proactively…');
                await this.connect();
                return;
            }

            // Level 3: live CDP round-trip (catches silent WebSocket drops)
            await this.page.evaluate(() => true);
            console.log('✅ [HealthProbe] CDP connection alive');

        } catch (err) {
            console.warn(`⚠️  [HealthProbe] CDP probe failed (${err.message}) — reconnecting proactively…`);
            try {
                // Clear stale references so connect() does a full fresh attach
                this.browser = null;
                this.page    = null;
                await this.connect();
                console.log('✅ [HealthProbe] Proactive reconnect succeeded — bot ready for next signal');
            } catch (connectErr) {
                console.warn(`⚠️  [HealthProbe] Reconnect failed: ${connectErr.message} — will retry next probe cycle`);
            }
        }
    }

    /**
     * Background keep-alive: reloads the MEXC futures page every 5–8 minutes
     * ONLY when no trade is in progress AND outside the 35s danger window before
     * each 3-minute candle close.
     *
     * Candle-safe gate (NEW):
     *   3-min candles close at :00, :03, :06 … every 3 minutes.
     *   If the reload starts within 35s of a close, the page is still loading
     *   when the signal arrives (reload takes 3-5s + TP/SL checkbox 5-10s) →
     *   detached-frame error or a missed trade.
     *
     *   Fix: if < 35s to close, defer the refresh until 10s AFTER the close
     *   (a tiny wait, not a full 5-8 min reschedule).  The page will finish
     *   loading with ≥30s to spare before the NEXT candle close.
     */
    startKeepAlive() {
        this.stopKeepAlive();

        const MIN_MS = 5 * 60 * 1000;   // 5 minutes
        const MAX_MS = 8 * 60 * 1000;   // 8 minutes
        const delay  = MIN_MS + Math.random() * (MAX_MS - MIN_MS);

        // Pass the original delay for logging only.
        this._keepAliveTimer = setTimeout(() => this._doKeepAlive(delay), delay);
    }

    /**
     * Inner implementation — separated from startKeepAlive() so the candle-safe
     * gate can re-schedule just THIS refresh (tiny defer) without restarting
     * the full 5-8 min interval.
     */
    async _doKeepAlive(logDelay) {
        // ── Candle-safe gate ──────────────────────────────────────────────────
        // Only refresh when there are AT LEAST 35s until the next 3-min close.
        // If inside the danger zone, wait until 10s past the close and try again.
        const CANDLE_MS   = 3 * 60 * 1000;   // 3-minute candle period
        const SAFE_GAP_MS = 35_000;           // reload ~5s + checkbox ~10s; want ≥30s safety margin
        const elapsed     = Date.now() % CANDLE_MS;
        const remaining   = CANDLE_MS - elapsed;

        if (remaining < SAFE_GAP_MS) {
            const waitMs = remaining + 10_000;   // skip past close + 10s buffer
            console.log(
                `⏸️  [KeepAlive] Candle closes in ${Math.round(remaining / 1000)}s — ` +
                `deferring refresh ${Math.round(waitMs / 1000)}s until clear of danger zone`
            );
            this._keepAliveTimer = setTimeout(() => this._doKeepAlive(logDelay), waitMs);
            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        const hasOpenPos = this._positionChecker?.() || false;

        if (!this._trading && !hasOpenPos && this.page && !this.page.isClosed()) {
            const minToClose = Math.floor(remaining / 60000);
            const secToClose = Math.round((remaining % 60000) / 1000);
            console.log(
                `🔄 [KeepAlive] Refreshing MEXC page ` +
                `(~${Math.round((logDelay || 0) / 60000)}m interval, ` +
                `${minToClose}m${secToClose}s to candle close — safe window)…`
            );

            // ── _reloading lock: covers ONLY the reload itself ────────────────
            // Released BEFORE _enableTpSlCheckbox() so a trade arriving mid-checkbox
            // phase is never blocked.  placeTrade ticks the box itself if needed.
            this._reloading = true;
            let reloadOk = false;
            try {
                // domcontentloaded fires as soon as HTML+initial scripts are done
                // (~2-4s for MEXC vs 10-20s for waitUntil:'load').
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
                await sleep(800);   // brief React bootstrap window
                reloadOk = true;
            } catch (e) {
                console.warn('⚠️  [KeepAlive] Refresh failed (will retry next cycle):', e.message);
            } finally {
                this._reloading = false;   // ← clear BEFORE checkbox (unlock for trades)
            }

            if (reloadOk) {
                console.log('✅ [KeepAlive] Page refreshed — frame context is fresh');
                // Checkbox runs outside the lock — a trade arriving now is unblocked
                // and falls back to its own inline checkbox tick if needed.
                this._enableTpSlCheckbox().catch(e =>
                    console.warn('⚠️  [KeepAlive] TP/SL checkbox failed:', e.message)
                );
            }
        } else if (this._trading) {
            console.log('⏭️  [KeepAlive] Trade in progress — skipping refresh');
        } else if (hasOpenPos) {
            console.log('⏭️  [KeepAlive] Open position active — skipping refresh to avoid frame disruption');
        }

        this.startKeepAlive();   // reschedule next 5-8 min cycle
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearTimeout(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }

    /**
     * After every page reload the TP/SL checkbox is unchecked and the input fields
     * are hidden.  This ticks it so the fields are always visible and ready when a
     * signal fires — zero extra delay on trade execution.
     *
     * Uses a poll loop (up to 15 s) rather than a fixed sleep so slow internet
     * connections are handled correctly — we wait until React has actually
     * rendered the checkbox before clicking it.
     *
     * Confirmed HTML structure (MEXC futures):
     *   <div class="OrderFormTpSl_tpslCheckWrap__…">
     *     <label class="ant-checkbox-v2-wrapper …">
     *       <span class="ant-checkbox-v2">
     *         <input class="ant-checkbox-v2-input" type="checkbox">   ← THIS
     *       </span>
     *     </label>
     *   </div>
     */
    /**
     * Helper: one attempt to find + click the TP/SL checkbox label.
     * Returns 'clicked' | 'already' | 'not_found'
     */
    async _clickTpSlOnce() {
        return this.page.evaluate(() => {
            const cb =
                document.querySelector('[class*="tpslCheckWrap"] input[type="checkbox"]') ||
                document.querySelector('[class*="OrderFormTpSl"] input[type="checkbox"]')  ||
                document.querySelector('.ant-checkbox-v2-input[type="checkbox"]')          ||
                document.querySelector('[class*="tpslCheckBoxBtn"] input[type="checkbox"]');

            if (!cb) return 'not_found';
            if (cb.checked) return 'already';

            // Try multiple click approaches so React state definitely updates
            const label = cb.closest('label') || cb.parentElement;

            // 1. Native mousedown/mouseup/click on the label (most reliable for React)
            if (label) {
                ['mousedown','mouseup','click'].forEach(type =>
                    label.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
                );
            }

            // 2. Also try direct input change event as backup
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'checked'
            );
            if (nativeSetter?.set) {
                nativeSetter.set.call(cb, true);
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                cb.click();
            }

            return 'clicked';
        });
    }

    /**
     * After every page reload the TP/SL checkbox resets to unchecked.
     * MEXC also loads user-settings from its API ~2-3s after the page,
     * which can reset the checkbox AGAIN after our first click.
     *
     * Strategy:
     *   1. Poll (up to 15s) until the checkbox exists → click it
     *   2. Wait 4s for MEXC user-settings API to settle
     *   3. Check again — re-click if it got reset (covers the API-reset case)
     *   4. Verify one more time and log the final state
     */
    async _enableTpSlCheckbox() {
        const POLL_INTERVAL_MS = 500;
        const MAX_WAIT_MS      = 15000;
        const started          = Date.now();

        // ── Phase 1: wait until checkbox exists, then click ──────────────────
        let firstClick = false;
        while (Date.now() - started < MAX_WAIT_MS) {
            try {
                const r = await this._clickTpSlOnce();
                if (r === 'clicked') {
                    console.log('✅ [KeepAlive] TP/SL checkbox clicked (phase 1)');
                    firstClick = true;
                    break;
                }
                if (r === 'already') {
                    console.log('ℹ️  [KeepAlive] TP/SL checkbox already checked');
                    firstClick = true;
                    break;
                }
                // not_found — page still loading
            } catch (_) { /* ignore */ }
            await sleep(POLL_INTERVAL_MS);
        }

        if (!firstClick) {
            console.warn('⚠️  [KeepAlive] TP/SL checkbox not found after 15s — trade will tick it on the fly');
            return;
        }

        // ── Phase 2: wait 4s for MEXC user-settings API response ─────────────
        // MEXC fetches saved preferences from its server after the page loads.
        // That response can reset the checkbox back to off.  We wait 4 s then
        // check again and re-click if it was reset.
        await sleep(4000);

        try {
            const r2 = await this._clickTpSlOnce();
            if (r2 === 'clicked') {
                console.log('🔁 [KeepAlive] TP/SL re-clicked after MEXC settings loaded');
            } else if (r2 === 'already') {
                console.log('✅ [KeepAlive] TP/SL still checked after settings loaded — all good');
            } else {
                console.warn('⚠️  [KeepAlive] TP/SL checkbox disappeared after settings load');
            }
        } catch (e) {
            console.warn('⚠️  [KeepAlive] Phase-2 check error:', e.message);
        }

        await sleep(400);   // let React render the TP/SL input fields
    }

    /**
     * Reconnect after a detached frame or stale page context.
     * Reloads the MEXC futures page so Puppeteer gets a fresh execution context.
     * Called automatically by server.js when placeTrade throws 'detached Frame'.
     */
    async reconnect() {
        console.log('🔄 Browser Bot reconnecting (frame detached — reloading MEXC page)…');
        try {
            // Try a soft reload first (keeps the session alive)
            if (this.browser && this.page && !this.page.isClosed()) {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
                await sleep(2000); // let React re-hydrate
                await this._enableTpSlCheckbox();
                console.log('✅ Browser Bot page reloaded');
                return;
            }
        } catch (_) { /* fall through to full reconnect */ }

        // Full reconnect — browser closed or page unreachable
        this.browser = null;
        this.page    = null;
        await this.connect();
        await sleep(2000);
        console.log('✅ Browser Bot fully reconnected');
    }

    // ── Shared: React-safe fill (browser-side function string) ──────────────
    static _fillFn() {
        return `(el, val) => {
            el.focus();
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')
                .set.call(el, String(val));
            el.dispatchEvent(new Event('input',  {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
        }`;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1. PLACE TRADE  (single evaluate round-trip — zero fixed sleeps)
    // ════════════════════════════════════════════════════════════════════════
    /**
     * All DOM work (qty fill, TP/SL fill, button click, popup auto-confirm)
     * runs in ONE page.evaluate() call — no fixed sleep() delays.
     * A 40 ms in-page setTimeout handles the React popup that may appear
     * after clicking the Open button, without blocking the Node.js side.
     *
     * @param {object} p
     * @param {'BUY'|'SELL'} p.direction
     * @param {number}  p.marginUsdt
     * @param {number}  p.leverage    (used for notional qty = marginUsdt × leverage)
     * @param {number}  p.tpPrice
     * @param {number}  p.slPrice
     */
    async placeTrade({ direction, marginUsdt, leverage, tpPrice, slPrice }) {
        if (!this.page) throw new Error('Not connected');

        this._trading = true;   // block keep-alive refresh while trade is executing
        try {

        // ── Wait for any in-progress KeepAlive reload to finish ───────────────
        // Race: KeepAlive timer fires → checks _trading=false → starts page.reload()
        // (async, takes 10-20 s) → signal arrives → _trading=true set here, but
        // page.evaluate() would run on a mid-loading page → timeout / ERR_BAD_RESPONSE.
        // Fix: spin-wait up to 25 s for _reloading to clear before touching the page.
        if (this._reloading) {
            const t0 = Date.now();
            console.log('⏳ [placeTrade] KeepAlive reload in progress — waiting…');
            while (this._reloading && Date.now() - t0 < 25_000) {
                await sleep(200);
            }
            console.log(`✅ [placeTrade] Reload done (${Date.now() - t0}ms wait) — proceeding`);
        }

        // ── CRITICAL: bring tab to front before any page.evaluate() ──────────
        // Chrome throttles JavaScript timers in background tabs: minimum interval
        // rises from 1ms to 1000ms+.  The auto-confirm modal handler runs inside
        // the browser via setTimeout(_tryConfirm, 80) — if the tab is in the
        // background those 80ms retries fire at ~1s each.  With up to 25 retries
        // that means the confirm modal can sit unclicked for 22+ seconds while our
        // bot log only shows "placeTrade DOM: 646ms" (page.evaluate returns as soon
        // as the button is clicked, before the in-page timer fires).
        //
        // bringToFront() un-throttles the tab instantly so all in-page timers run
        // at full speed (<80ms per retry) — exactly what updateTpSl() already does.
        try { await this.page.bringToFront(); } catch (_) {}
        await sleep(100);   // brief render settle after tab switch

        const side         = direction === 'BUY' ? 'LONG' : 'SHORT';
        const quantityUsdt = Math.round(marginUsdt * leverage);
        console.log(`📋 ${direction} | ${marginUsdt}×${leverage}=$${quantityUsdt} | TP=${tpPrice} SL=${slPrice}`);

        // ── STEP A: Fill qty + TP/SL + click Open button ──────────────────────
        // The evaluate returns immediately after the button click — confirm modal
        // polling deliberately moved OUT of the browser and handled in Node.js
        // (STEP B below) so it is never subject to Chrome's background-tab timer
        // throttling (which inflates in-page setTimeout from 80ms → 1000ms+,
        // causing 23-25s confirm delays when Chrome's window is not focused).
        const result = await this.page.evaluate((qty, tp, sl, btnId) => {
            const fill = (el, val) => {
                el.focus();
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
                    .set.call(el, String(val));
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            // ── 1. Qty ──────────────────────────────────────────────────────
            const qtyInput = document.querySelector(
                '#mexc_contract_v_open_position input[inputmode="decimal"]'
            );
            if (!qtyInput) return { ok: false, error: 'Qty input not found — is Market tab selected?' };
            qtyInput.click(); qtyInput.select();
            fill(qtyInput, qty);

            // ── 2. TP/SL ────────────────────────────────────────────────────
            const cb = document.querySelector('[class*="tpslCheckWrap"] input[type="checkbox"]');
            if (cb && !cb.checked) cb.click();
            const tpslInputs = [...document.querySelectorAll('section[class*="stopWrapper"] input.ant-input')];
            if (tpslInputs.length < 2)
                return { ok: false, error: `Only ${tpslInputs.length} TP/SL input(s) found` };
            fill(tpslInputs[0], tp);
            fill(tpslInputs[1], sl);

            // ── 3. Click Open Long / Open Short ─────────────────────────────
            const openBtn = document.querySelector(`[data-testid="${btnId}"]`);
            if (!openBtn) return { ok: false, error: `Open button [${btnId}] not found` };
            openBtn.click();

            // Return immediately — confirm modal handled from Node.js (STEP B)
            return {
                ok: true,
                qty:  qtyInput.value,
                tp:   tpslInputs[0].value,
                sl:   tpslInputs[1].value,
            };
        }, String(quantityUsdt), String(tpPrice), String(slPrice),
           side === 'LONG' ? 'contract-trade-open-long-btn' : 'contract-trade-open-short-btn');

        if (!result.ok) throw new Error(result.error);

        console.log(`  💵 Qty: ${result.qty} USDT`);
        console.log(`  🛡️  TP=${result.tp}  SL=${result.sl}`);
        console.log(`  🚀 ${side === 'LONG' ? 'Open Long' : 'Open Short'} clicked`);

        // ── STEP B: Confirm modal — polled from Node.js side ──────────────────
        // Node.js `await sleep()` calls use the Node event loop, completely
        // unaffected by Chrome's tab/window throttling.  Each poll is a fresh
        // CDP page.evaluate() round-trip (~5-15ms) — the modal query runs
        // synchronously in the browser JS engine with no timer involved.
        //
        // Normal path (no modal, 99% of trades):
        //   → iteration 1: 80ms wait + evaluate → 'none' → done in ~90ms total
        //
        // ForcedReminder / PlanRiskWindow path:
        //   → typically appears within 100-300ms of button click
        //   → caught in iteration 1 or 2 → clicked and done in <250ms total
        //
        // Max coverage: 10 × 80ms = 800ms (+10ms CDP each) ← replaces old 25s cap
        for (let _attempt = 0; _attempt < 10; _attempt++) {
            await sleep(80);   // ← Node.js timer, never throttled by Chrome

            const modalState = await this.page.evaluate(() => {
                // ── Priority: ForcedReminder "Order Confirmation" modal ──────
                const forcedModal = document.querySelector('[class*="ForcedReminder_modal"]');
                if (forcedModal && forcedModal.offsetParent !== null) {
                    // Tick "Never show again" so this modal won't appear on future trades
                    const neverChk = forcedModal.querySelector('input.ant-checkbox-v2-input[type="checkbox"]');
                    if (neverChk && !neverChk.checked) neverChk.click();

                    const confirmBtn = forcedModal.querySelector('button.ant-btn-v2-primary');
                    if (confirmBtn && !confirmBtn.disabled) { confirmBtn.click(); return 'forced_confirmed'; }
                    return 'pending'; // button not yet enabled — retry
                }

                // ── Fallback: PlanRiskWindow / generic ant-modal confirms ────
                const CONFIRM_SELS = [
                    '[class*="PlanRiskWindow_footer"] button.ant-btn-v2-primary',
                    '.ant-modal-content button.ant-btn-v2-primary',
                    '.ant-modal-confirm .ant-btn-primary',
                    '.ant-popconfirm-buttons .ant-btn-primary',
                ];
                for (const sel of CONFIRM_SELS) {
                    const btns = [...document.querySelectorAll(sel)]
                        .filter(b => b.offsetParent !== null && !b.disabled);
                    const btn = btns.find(b => {
                        const t = b.textContent.trim().toLowerCase();
                        return t === 'confirm' || t === 'ok' || t === 'submit'
                            || t.includes('place') || t.includes('open');
                    });
                    if (btn) { btn.click(); return 'confirmed'; }
                }

                return 'none'; // no modal present — order went through directly
            });

            if (modalState === 'none') {
                // No confirm modal — order placed immediately, stop polling
                break;
            }
            if (modalState === 'forced_confirmed' || modalState === 'confirmed') {
                console.log(`  ✅ Confirm modal dismissed (attempt ${_attempt + 1}): ${modalState}`);
                break;
            }
            // modalState === 'pending' — modal visible but button not yet enabled, retry
        }

        console.log(`✅ Done\n`);

        return { success: true, direction, side, leverage, marginUsdt, quantityUsdt, tpPrice, slPrice };
        } finally {
            this._trading = false;   // always re-enable keep-alive after trade
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2. UPDATE TP/SL on existing position
    // ════════════════════════════════════════════════════════════════════════
    /**
     * @param {object} p
     * @param {string}  p.symbol     e.g. 'BTCUSDT'  (partial match OK)
     * @param {'LONG'|'SHORT'} p.direction
     * @param {number}  p.tpPrice    0 or null = skip / clear TP
     * @param {number}  p.slPrice    0 or null = skip / clear SL
     */
    async updateTpSl({ symbol = 'BTC', direction = 'LONG', tpPrice, slPrice }) {
        if (!this.page) throw new Error('Not connected');
        const page = this.page;

        console.log(`📝 Update TP/SL | ${symbol} ${direction} | TP=${tpPrice} SL=${slPrice}`);

        // ── CRITICAL: bring tab to front before ANY page.evaluate() ──────────
        // Chrome throttles background-tab JavaScript execution, causing
        // page.evaluate() calls to hang for 25-180s before timing out.
        // bringToFront() un-throttles the tab instantly → evaluate completes in ms.
        try { await page.bringToFront(); } catch (_) {}
        await sleep(150);   // brief render settle after tab switch

        // ── Step 1: Click the edit icon in the position row ──
        // Retry up to 5× with 1.5 s gaps — MEXC UI can take several seconds
        // to render the position row after a fill.
        let step1 = { ok: false, error: 'timeout' };
        for (let attempt = 1; attempt <= 5; attempt++) {
            step1 = await page.evaluate((sym, dir) => {
                // Helper: fuzzy symbol match — strip underscores/slashes
                const clean = s => s.replace(/[_\/]/g, '').toUpperCase();
                const symClean = clean(sym);

                const rows = [...document.querySelectorAll('tr[data-row-key]')];
                const row  = rows.find(r => {
                    const nameEl = r.querySelector('[class*="symbolNameWrapper"],[class*="symbolName"]');
                    const symMatch = nameEl && clean(nameEl.textContent).includes(symClean);
                    const dirEl   = r.querySelector('[class*="longShortText"],[class*="direction"]');
                    const dirText = (dirEl?.textContent || r.textContent).trim().toLowerCase();
                    const dirMatch = dir === 'LONG' ? dirText.includes('long') : dirText.includes('short');
                    return symMatch && dirMatch;
                });
                if (!row) return { ok: false, error: `Position row not found for ${sym} ${dir}` };

                // Hover over the row + TP/SL cell to reveal hidden pencil icons (CSS hover-only)
                const hover = el => {
                    el.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('mousemove',  { bubbles: true, cancelable: true }));
                };
                hover(row);
                const tpslCell = row.querySelector('[class*="tpslRecord"],[class*="TpslRecord"],[class*="tpslWrapper"]');
                if (tpslCell) hover(tpslCell);
                // Also hover the singleOrderEdit span wrapper if present (even hidden)
                const editWrapper = row.querySelector('[class*="singleOrderEdit__"],[class*="tpslRecordWrapper"],[class*="TpslRecordAndBtn"]');
                if (editWrapper) hover(editWrapper);

                // Now find the edit icon (it may now be visible after hover events)
                const editIcon = row.querySelector('[class*="singleOrderEdit__"],[class*="editTpsl"],[class*="tpslEdit"]');
                if (!editIcon) return { ok: false, error: 'Edit TP/SL icon not found in position row' };
                editIcon.click();
                return { ok: true };
            }, symbol, direction);

            if (step1.ok) break;
            console.log(`  ⏳ Attempt ${attempt}/5 — ${step1.error} — waiting 1.5 s`);
            await sleep(1500);
        }
        if (!step1.ok) throw new Error(step1.error);
        console.log(`  ✅ Clicked position row edit icon`);

        // ── Step 2: Wait for TP/SL settings panel to appear ──
        await sleep(700);

        // ── Step 3: Click the edit pencil icon inside the settings panel (if present) ──
        // Some MEXC UI versions show a settings panel → edit icon → EditStopOrder modal.
        // Others go straight to an edit form after clicking the row pencil icon.
        // We try both paths.
        const step3 = await page.evaluate(() => {
            // Try to find a nested edit button inside any open overlay/modal/panel
            const editBtns = [
                ...document.querySelectorAll('[class*="TpslRecordAndBtn_edit__"],[class*="tpslEdit"],[class*="editTpsl"]')
            ].filter(el => el.offsetParent !== null); // only visible elements
            if (editBtns.length > 0) { editBtns[0].click(); return { ok: true, found: true }; }
            // Not found — might already be on the edit form directly
            return { ok: true, found: false };
        });
        if (step3.found) {
            console.log(`  ✅ Clicked edit icon inside settings panel`);
        } else {
            console.log(`  ℹ️  No secondary edit icon — trying direct input fill`);
        }

        // ── Step 4: Wait for edit form inputs to appear (poll up to 4 s) ──
        let visibleInputHandles = [];
        for (let chk = 0; chk < 20; chk++) {
            const allHandles = await page.$$('input[placeholder="Trigger Price"]');
            const checked = [];
            for (const h of allHandles) {
                const visible = await h.evaluate(el => el.offsetParent !== null).catch(() => false);
                if (visible) checked.push(h);
            }
            if (checked.length >= 2) { visibleInputHandles = checked; break; }
            await sleep(200);
        }
        if (visibleInputHandles.length < 2)
            throw new Error(`Trigger Price inputs not found after edit click (found ${visibleInputHandles.length})`);

        // ── Step 5: Fill TP and SL with Puppeteer native click + keyboard.type() ──
        // ⚠️  WHY NOT page.evaluate() + React native setter here?
        //   The EditStopOrder modal has an extra validation layer: firing a synthetic
        //   Tab keydown (the old approach) moved focus away before React committed the
        //   value, so MEXC's UI kept the original SL.  Puppeteer's real keyboard events
        //   (triple-click to select-all + keyboard.type per char) are treated as genuine
        //   user input — React and MEXC both accept them reliably.
        //
        // Order: tpInput = last-2, slInput = last-1  (same as before)
        const tpHandle = visibleInputHandles[visibleInputHandles.length - 2];
        const slHandle = visibleInputHandles[visibleInputHandles.length - 1];

        // Fill TP only when provided (CTC only sends slPrice — skip TP fill to avoid
        // triggering React re-validation that could reset the SL field)
        if (tpPrice != null && tpPrice > 0) {
            await tpHandle.click({ clickCount: 3 });   // select all existing text
            await sleep(60);
            await page.keyboard.type(String(tpPrice), { delay: 25 });
            await sleep(100);
        }

        // Fill SL (break-even for CTC, or manual update)
        if (slPrice != null && slPrice > 0) {
            await slHandle.click({ clickCount: 3 });   // select all existing text
            await sleep(60);
            await page.keyboard.type(String(slPrice), { delay: 25 });
            await sleep(100);
            // Tab OUT of the SL field so React finalises the value before submit
            await page.keyboard.press('Tab');
            await sleep(150);
        }

        // Read back what was actually entered (for logging + sanity check)
        const readBack = await page.evaluate(() => {
            const all = [...document.querySelectorAll('input[placeholder="Trigger Price"]')]
                .filter(el => el.offsetParent !== null);
            return { tp: all[all.length - 2]?.value, sl: all[all.length - 1]?.value };
        });
        console.log(`  🛡️  Set TP=${readBack.tp}  SL=${readBack.sl}`);

        await sleep(200);

        // ── Step 6a: Submit the EditStopOrder form ──
        // Click the primary "Confirm" button inside the EditStopOrder form.
        // We find it by walking up from the trigger inputs, skipping known bad buttons.
        const step6a = await page.evaluate(() => {
            const triggerInputs = [...document.querySelectorAll('input[placeholder="Trigger Price"]')]
                .filter(el => el.offsetParent !== null);
            if (!triggerInputs.length) return { ok: false, error: 'No trigger inputs visible for submit' };

            const lastInput = triggerInputs[triggerInputs.length - 1];

            // Also dispatch Enter as a fallback
            lastInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
            lastInput.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', keyCode: 13 }));

            // Walk up to find the primary confirm button within the edit form
            const BAD_TEXT = /close long|close short|reverse|flash close|add margin|withdraw|add more/i;
            const BAD_CLS  = /tertiary|secondary|reverseBtn|flashClose/i;
            const seenBtns = new Set();
            const candidates = [];
            let el = lastInput.parentElement;
            for (let d = 0; d < 25 && el && el !== document.body; d++) {
                for (const btn of el.querySelectorAll('button')) {
                    if (seenBtns.has(btn)) continue;
                    seenBtns.add(btn);
                    if (!btn.offsetParent || btn.disabled) continue;
                    const txt = btn.textContent.trim();
                    if (BAD_TEXT.test(txt)) continue;
                    if (BAD_CLS.test(btn.className)) continue;
                    if (/btn-v2-primary|btn-primary|ant-btn-primary/i.test(btn.className)) {
                        candidates.push({ btn, txt, d });
                    }
                }
                el = el.parentElement;
            }
            if (candidates.length > 0) {
                const kw = ['confirm','ok','save','apply','确定','确认'];
                const pref = candidates.find(c => kw.some(k => c.txt.toLowerCase().includes(k))) || candidates[0];
                pref.btn.click();
                return { ok: true, text: pref.btn.textContent.trim() };
            }
            // Enter was dispatched; maybe that was enough
            return { ok: true, text: 'Enter dispatched' };
        });
        if (!step6a.ok) throw new Error(step6a.error);
        console.log(`  ✅ Form submitted: "${step6a.text}"`);

        // ── Step 6b: Handle MEXC "Risk reminder" / "PlanRiskWindow" warning modal ──
        // After submitting the form, MEXC may show a "Risk reminder" popup:
        //   class="ant-modal PlanRiskWindow_modal__IRuyY"
        //   Confirm button: ant-btn-v2-primary inside PlanRiskWindow_footer__D_BsR
        // We poll up to 2 s for it to appear, then click Confirm.
        for (let w = 0; w < 10; w++) {
            await sleep(200);

            const result = await page.evaluate(() => {
                // ── Primary: exact PlanRiskWindow selector (confirmed from live HTML) ──
                const riskModal = document.querySelector('[class*="PlanRiskWindow_modal"]');
                if (riskModal && riskModal.offsetParent !== null) {
                    const confirmBtn = riskModal.querySelector(
                        '[class*="PlanRiskWindow_footer"] button.ant-btn-v2-primary,' +
                        '.ant-modal-footer button.ant-btn-v2-primary,' +
                        'button.ant-btn-v2-primary'
                    );
                    if (confirmBtn && !confirmBtn.disabled) {
                        confirmBtn.click();
                        return { done: true, reason: 'PlanRiskWindow confirm' };
                    }
                }

                // ── Fallback: any ant-modal with a primary confirm button ──
                const allModals = [...document.querySelectorAll('.ant-modal,[class*="_modal"],[class*="Modal_"]')]
                    .filter(m => m.offsetParent !== null);
                for (const modal of allModals) {
                    const btns = [...modal.querySelectorAll('button.ant-btn-v2-primary,button.ant-btn-primary')]
                        .filter(b => b.offsetParent !== null && !b.disabled);
                    const confirmBtn = btns.find(b => {
                        const t = b.textContent.trim().toLowerCase();
                        return t === 'confirm' || t === 'ok' || t === '确定' || t === '确认';
                    });
                    if (confirmBtn) {
                        confirmBtn.click();
                        return { done: true, reason: 'fallback modal confirm' };
                    }
                }

                // ── Check if form already closed (inputs gone) ──
                const openInputs = [...document.querySelectorAll('input[placeholder="Trigger Price"]')]
                    .filter(e => e.offsetParent !== null).length;
                return { done: openInputs === 0, reason: openInputs === 0 ? 'form closed' : 'waiting' };
            });

            if (result.done) {
                if (result.reason === 'form closed') {
                    console.log(`  ✅ Form closed (no warning dialog)`);
                } else {
                    console.log(`  ⚠️  Risk warning handled: ${result.reason}`);
                }
                break;
            }
        }

        await sleep(300);
        console.log(`✅ TP/SL updated\n`);
        return { success: true, symbol, direction, tpPrice, slPrice };
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3. CLOSE POSITION (Flash Close or Close Long/Short)
    // ════════════════════════════════════════════════════════════════════════
    /**
     * @param {object} p
     * @param {string}  p.symbol     e.g. 'BTCUSDT'
     * @param {'LONG'|'SHORT'} p.direction
     * @param {boolean} [p.flash=true]  true = Flash Close (market), false = Close Long/Short button
     */
    async closeTrade({ symbol = 'BTC', direction = 'LONG', flash = true }) {
        if (!this.page) throw new Error('Not connected');
        const page = this.page;

        console.log(`🔴 Close ${symbol} ${direction} | flash=${flash}`);

        const result = await page.evaluate((sym, dir, useFlash) => {
            const rows = [...document.querySelectorAll('tr[data-row-key]')];
            const row  = rows.find(r => {
                const symMatch = r.querySelector('[class*="symbolNameWrapper"]')?.textContent?.includes(sym);
                const dirText  = r.querySelector('[class*="longShortText"]')?.textContent?.trim().toLowerCase();
                const dirMatch = dir === 'LONG' ? dirText?.includes('long') : dirText?.includes('short');
                return symMatch && dirMatch;
            });
            if (!row) return { ok: false, error: `Position row not found for ${sym} ${dir}` };

            if (useFlash) {
                // Flash Close (instant market close)
                const flashBtn = row.querySelector('[class*="flashCloseBtn"]');
                if (flashBtn) { flashBtn.click(); return { ok: true, method: 'flash', text: flashBtn.textContent.trim() }; }
            }

            // Close Long / Close Short button (manual market price close)
            const closeText = dir === 'LONG' ? 'Close Long' : 'Close Short';
            const closeBtn  = [...row.querySelectorAll('button')].find(b =>
                b.textContent.trim() === closeText || b.textContent.trim().includes(closeText)
            );
            if (closeBtn) { closeBtn.click(); return { ok: true, method: 'close', text: closeBtn.textContent.trim() }; }

            return { ok: false, error: `No close button found for ${sym} ${dir}` };
        }, symbol, direction, flash);

        if (!result.ok) throw new Error(result.error);
        console.log(`  🚀 Clicked "${result.text}" [${result.method}]`);

        // Auto-confirm any confirmation dialog
        await sleep(300);
        await page.evaluate(() => {
            for (const sel of ['.ant-modal-confirm .ant-btn-primary','.ant-modal-content .ant-btn-v2-primary','.ant-modal-content .ant-btn-primary','.ant-popconfirm-buttons .ant-btn-primary']) {
                const btn = [...document.querySelectorAll(sel)].find(b => { const t = b.textContent.trim().toLowerCase(); return t.includes('confirm') || t === 'ok' || t.includes('close'); });
                if (btn) { btn.click(); return; }
            }
        });

        console.log(`✅ Position closed\n`);
        return { success: true, symbol, direction, method: result.method };
    }
}

module.exports = MexcBrowserBot;
