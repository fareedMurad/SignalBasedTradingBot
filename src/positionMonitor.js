/**
 * Position Monitor Module
 *
 * MEXC Browser Bot mode  (MEXC_BROWSER_MODE=true):
 *   • softwareSLTP MUST be FALSE — MEXC handles TP/SL via its own stop orders
 *     placed by the browser bot UI.  Software SL/TP must NEVER fire a REST
 *     market-close because MEXC REST market orders get a drastically worse fill
 *     than the exchange's own TP/limit order (caused the -$37 bleed vs -$6 expected).
 *   • Register a UI close handler via setUICloseHandler() so holding-candle
 *     closes are routed through Puppeteer (Flash Close 🖥️) not the REST API.
 *
 * Other modes (Binance live / testnet):
 *   • softwareSLTP=true activates software SL/TP checks every 5 s.
 *   • Safety watcher re-places missing exchange SL orders.
 */

const CANDLE_INTERVAL_MS = 3 * 60 * 1000; // 3-minute candles

class PositionMonitor {
    constructor(binanceClient, tradeExecutor, logger, storageManager) {
        this.client     = binanceClient;
        this.executor   = tradeExecutor;
        this.logger     = logger;
        this.storage    = storageManager;

        this.monitoredPositions = new Map();   // symbol → position data
        this.pendingLimitOrders = new Map();   // symbol → pending limit order

        /**
         * Optional browser-UI close handler for MEXC browser-bot mode.
         * Signature: async (symbol, side) → void
         * Registered via setUICloseHandler().
         * When set, ALL forced closes (holding-candles, emergency) call this
         * instead of executor.closePosition() — avoids REST market slippage.
         */
        this._uiCloseHandler = null;

        /**
         * Optional browser-UI TP/SL update handler for MEXC browser-bot mode.
         * Signature: async (symbol, direction, tpPrice, slPrice) → void
         * Registered via setUIUpdateTpSlHandler().
         * When set, ALL SL/TP updates (CTC break-even moves, etc.) go through
         * Puppeteer instead of MEXC REST API — guarantees no REST calls are made.
         */
        this._uiUpdateTpSlHandler = null;
    }

    /**
     * Register a browser-UI close function for MEXC browser-bot mode.
     *
     * Usage in server.js:
     *   monitor.setUICloseHandler((symbol, side) =>
     *     mexcBot.closeTrade({ symbol, direction: side, flash: true })
     *   );
     *
     * With this registered:
     *   • softwareSLTP should be FALSE (MEXC handles TP/SL natively)
     *   • Holding-candle closes use Puppeteer Flash Close (correct fill price)
     *   • Emergency closes also use Puppeteer
     */
    setUICloseHandler(fn) {
        this._uiCloseHandler = fn;
        this.logger.info('🖥️  UI close handler registered — all forced closes routed via browser bot');
    }

    /**
     * Register a browser-UI TP/SL update function for MEXC browser-bot mode.
     *
     * Usage in server.js:
     *   monitor.setUIUpdateTpSlHandler(async (symbol, direction, tp, sl) =>
     *     mexcBot.updateTpSl({ symbol, direction, tpPrice: tp, slPrice: sl })
     *   );
     *
     * With this registered:
     *   • CTC break-even SL moves go through Puppeteer
     *   • No REST API calls are made for TP/SL updates in MEXC browser mode
     */
    setUIUpdateTpSlHandler(fn) {
        this._uiUpdateTpSlHandler = fn;
        this.logger.info('🖥️  UI TP/SL handler registered — all SL/TP updates routed via browser bot');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async start() {
        this.logger.info('🔍 Position monitor started');

        this.monitorInterval = setInterval(async () => {
            await this.checkPositions();
        }, 5000);

        this.limitOrderInterval = setInterval(async () => {
            await this.checkLimitOrders();
        }, 10000);

        this.safetyMonitorInterval = setInterval(async () => {
            await this.safetyCheckUnprotectedPositions();
        }, 30000);

        // ── SL Guardian — 1-second WS-price check ───────────────────────────
        // MEXC sometimes fails to fire its own stop-loss order (known exchange bug),
        // allowing an isolated position to run to full liquidation.
        //
        // This guardian checks the live WS-cached price (0ms latency, no REST)
        // every second. If the price has breached the stored stopLoss level AND
        // the position is still open in our monitor, it force-closes via Puppeteer
        // Flash Close — bypassing MEXC's broken stop order entirely.
        //
        // Conditions to fire:
        //   • _uiCloseHandler registered (browser-bot mode only)
        //   • positionData.stopLoss is set
        //   • getLivePrice(symbol) ≥/≤ stopLoss (direction-aware)
        //   • monitorAge > 60s (grace period — position must be settled on exchange)
        //   • not already _closing
        this.slGuardInterval = setInterval(async () => {
            await this._slGuardTick();
        }, 1000);

        const isTestnet = this.client.isTestnet();
        this.logger.info(`🛡️ Safety monitor enabled (${isTestnet ? 'software SL/TP' : 'live exchange SL orders'})`);
        this.logger.info('🛡️ SL Guardian active — 1s WS-price check, flash-closes on missed SL');
    }

    stop() {
        if (this.monitorInterval)       clearInterval(this.monitorInterval);
        if (this.limitOrderInterval)    clearInterval(this.limitOrderInterval);
        if (this.safetyMonitorInterval) clearInterval(this.safetyMonitorInterval);
        if (this.slGuardInterval)       clearInterval(this.slGuardInterval);
        this.logger.info('🛑 Position monitor stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Add / Remove positions
    // ─────────────────────────────────────────────────────────────────────────

    addPosition(symbol, options) {
        const {
            side,
            entryPrice,
            orderType      = 'MARKET',
            ctcEnabled     = false,
            ctcTrigger     = 0.5,
            holdingCandles = 0,
            // Explicit holdingEnabled override — used when restoring a position after
            // server restart so the user's manual toggle state is preserved.
            // If omitted, defaults to (holdingCandles > 0) — i.e. the signal decides.
            holdingEnabled: holdingEnabledParam = undefined,
            tradeStartTime = Date.now(),
            softwareSLTP   = false,   // MUST be false for MEXC browser-bot
            stopLoss       = null,
            takeProfit1    = null,
            // MEXC fee fix: notional = marginDollar * leverage, used in _recordClose
            // to compute correct fee (MEXC charges 0.01% per leg, NOT 0.04% of PnL)
            notional       = 0,
            // CTC base price — the CANDLE OPEN at signal time (from signal.price / signal.entry).
            // CTC trigger must be measured from the candle open, NOT the fill price,
            // because we enter at candle open + small slippage and CTC % is defined
            // relative to the signal's planned TP distance (which starts from candle open).
            // Falls back to entryPrice if not provided (e.g. manual trades, limit orders).
            ctcBasePrice   = null
        } = options;

        // Use explicit param when provided (restore after restart preserves user's toggle);
        // otherwise derive from holdingCandles — non-zero means the signal enabled holding.
        const holdingEnabled = holdingEnabledParam !== undefined
            ? !!holdingEnabledParam
            : holdingCandles > 0;
        const isLong = side === 'LONG';

        // CTC trigger is measured from the candle open (ctcBasePrice), not the fill price.
        // The CTC % (e.g. 40%) means "when price has moved 40% of the TP distance FROM CANDLE OPEN".
        // Using fill price would shift the trigger upward/downward by slippage, making it inaccurate.
        const ctcRef = ctcBasePrice || entryPrice;

        let ctcTriggerPrice = null;
        if (ctcEnabled && takeProfit1 && ctcRef) {
            ctcTriggerPrice = isLong
                ? ctcRef + ctcTrigger * (takeProfit1 - ctcRef)
                : ctcRef - ctcTrigger * (ctcRef - takeProfit1);
            this.logger.info(
                `📐 CTC trigger for ${symbol}: ${ctcTriggerPrice.toFixed(4)} ` +
                `(${(ctcTrigger * 100).toFixed(0)}% of TP dist from candle open ${ctcRef.toFixed(4)})`
            );
        }

        this.monitoredPositions.set(symbol, {
            side,
            entryPrice,
            orderType,
            ctcEnabled: !!ctcEnabled,
            ctcTrigger,
            ctcTriggerPrice,
            ctcTriggered: false,
            holdingCandles,
            tradeStartTime,
            holdingEnabled,
            softwareSLTP: !!softwareSLTP,
            stopLoss,
            takeProfit1,
            tpHit: false,
            lastKnownPnL: 0,
            lastUpdated: Date.now(),
            // MEXC browser-bot grace period: the REST getPositions() API can take
            // 10–30 seconds to reflect a position opened via Puppeteer UI click.
            // We must NOT treat "no REST position" as "auto-closed" within 60 s.
            monitorAddedAt: Date.now(),
            // Stored for fee calculation in _recordClose
            // MEXC fee = notional * 0.0001 per leg (0.0002 round-trip), NOT pnl * 0.04%
            notional
        });

        const modeTag = softwareSLTP ? '🧪 software SL/TP' : '🏦 exchange SL/TP';
        this.logger.info(
            `📌 Monitoring ${symbol} ${side} [${modeTag}] | ` +
            `CTC: ${ctcEnabled ? `${(ctcTrigger * 100).toFixed(0)}% of TP` : 'off'} | ` +
            `Holding: ${holdingCandles > 0 ? `${holdingCandles} candles` : 'off'}`
        );
        if (softwareSLTP) {
            this.logger.info(`🔒 Software SL/TP: SL=${stopLoss} | TP=${takeProfit1}`);
        }
    }

    removePosition(symbol) {
        this.monitoredPositions.delete(symbol);
        this.logger.info(`🗑️ Stopped monitoring ${symbol}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Manual mode — bot stands by, user manages trade
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Toggle manual mode for a monitored position.
     *
     * When enabled=true:
     *   • All automated checks (holding candle, CTC, SL guardian, software SL/TP)
     *     are suspended for this position.
     *   • Position stays in the monitor map so the dashboard shows live PnL.
     *   • Auto-close detection (position gone on exchange) is suppressed —
     *     user will close it directly on MEXC.
     *
     * When enabled=false — normal bot behavior resumes immediately.
     *
     * @returns {boolean} true if position was found, false if not monitored
     */
    setManualMode(symbol, enabled) {
        const positionData = this.monitoredPositions.get(symbol);
        if (!positionData) return false;
        this.monitoredPositions.set(symbol, { ...positionData, manualMode: !!enabled });
        this.logger.info(`🎮 ${symbol}: manual mode ${!!enabled ? 'ENABLED — bot standing by' : 'DISABLED — bot resuming'}`);
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SL/TP manual edit
    // ─────────────────────────────────────────────────────────────────────────

    async updateSLTP(symbol, newSL, newTP) {
        const positionData = this.monitoredPositions.get(symbol);
        if (!positionData) {
            return { success: false, error: `Position ${symbol} not found in monitor` };
        }

        const previousSL = positionData.stopLoss;
        const previousTP = positionData.takeProfit1;
        const resolvedSL = newSL ?? previousSL;
        const resolvedTP = newTP ?? previousTP;
        const isLong     = positionData.side === 'LONG';

        if (resolvedSL && resolvedTP) {
            if (isLong && resolvedSL >= resolvedTP)
                return { success: false, error: `LONG: SL (${resolvedSL}) must be below TP (${resolvedTP})` };
            if (!isLong && resolvedSL <= resolvedTP)
                return { success: false, error: `SHORT: SL (${resolvedSL}) must be above TP (${resolvedTP})` };
        }

        // ── Browser-bot route: ZERO REST API calls ────────────────────────────
        // When _uiUpdateTpSlHandler is registered (MEXC browser mode), ALL SL/TP
        // moves — including CTC break-even — go through Puppeteer.
        let exchangeUpdated = false;
        if (this._uiUpdateTpSlHandler) {
            try {
                await this._uiUpdateTpSlHandler(symbol, positionData.side, resolvedTP || null, resolvedSL || null);
                this.logger.info(`🖥️  [Browser] TP/SL updated for ${symbol}: SL=${resolvedSL} TP=${resolvedTP}`);
                exchangeUpdated = true;
            } catch (err) {
                this.logger.warn(`⚠️ Browser TP/SL update failed for ${symbol}: ${err.message} — in-memory only`);
                // exchangeUpdated stays false — caller must check result.exchangeUpdated
            }

        } else {
            // ── REST API route (Binance live / non-browser MEXC) ────────────────
            const isTestnet = this.client.isTestnet();
            const hasMexcStopOrders = typeof this.client.cancelPositionSLTP === 'function'
                                    && typeof this.client.setPositionSLTP    === 'function';

            if (hasMexcStopOrders) {
                try {
                    const positions = await this.client.getPositions(symbol);
                    const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
                    if (position && position._positionId) {
                        const symbolInfo = await this.client.getSymbolInfo(symbol);
                        const roundedSL  = resolvedSL ? this.executor.roundToTickSize(resolvedSL, symbolInfo.tickSize, symbolInfo.pricePrecision) : null;
                        const roundedTP  = resolvedTP ? this.executor.roundToTickSize(resolvedTP, symbolInfo.tickSize, symbolInfo.pricePrecision) : null;
                        await this.client.cancelPositionSLTP(symbol);
                        await new Promise(r => setTimeout(r, 600));
                        const result = await this.client.setPositionSLTP(
                            position._positionId, position._holdVol || 1, roundedSL, roundedTP
                        );
                        if (result) {
                            this.logger.info(`✅ Exchange SL/TP updated on MEXC for ${symbol}: SL=${roundedSL} TP=${roundedTP}`);
                        } else {
                            this.logger.warn(`⚠️ Exchange SL/TP update returned null for ${symbol}`);
                        }
                    }
                } catch (err) {
                    this.logger.warn(`⚠️ Exchange SL/TP update failed for ${symbol}: ${err.message}`);
                }

            } else if (!isTestnet && !positionData.softwareSLTP) {
                try {
                    const symbolInfo = await this.client.getSymbolInfo(symbol);
                    const positions  = await this.client.getPositions(symbol);
                    const position   = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
                    if (!position) return { success: false, error: 'Position no longer open on exchange' };
                    const qty = Math.abs(parseFloat(position.positionAmt));
                    const openOrders = await this.client.getOpenOrders(symbol);
                    for (const order of openOrders) {
                        if (order.type === 'STOP_MARKET' || order.type === 'TAKE_PROFIT_MARKET') {
                            try { await this.client.cancelOrder(symbol, order.orderId); } catch (_) {}
                        }
                    }
                    if (resolvedSL) {
                        const slPrice = this.executor.roundToTickSize(resolvedSL, symbolInfo.tickSize, symbolInfo.pricePrecision);
                        await this.client.placeOrder({ symbol, side: isLong ? 'SELL' : 'BUY', type: 'STOP_MARKET',
                            quantity: qty.toString(), stopPrice: slPrice.toString(), reduceOnly: 'true', workingType: 'MARK_PRICE' });
                        this.logger.info(`✅ New SL placed at ${slPrice} for ${symbol}`);
                    }
                    if (resolvedTP) {
                        const tpPrice = this.executor.roundToTickSize(resolvedTP, symbolInfo.tickSize, symbolInfo.pricePrecision);
                        await this.client.placeOrder({ symbol, side: isLong ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET',
                            quantity: qty.toString(), stopPrice: tpPrice.toString(), reduceOnly: 'true', workingType: 'MARK_PRICE' });
                        this.logger.info(`✅ New TP placed at ${tpPrice} for ${symbol}`);
                    }
                } catch (err) {
                    this.logger.error(`❌ Failed to update exchange SL/TP for ${symbol}:`, err.message);
                    return { success: false, error: err.message };
                }
            } else {
                this.logger.info(`🧪 Software SL/TP only — in-memory levels updated for ${symbol}`);
            }
        }   // end REST API route

        // ── Always update in-memory state (runs for both browser and REST paths) ──
        positionData.stopLoss    = resolvedSL;
        positionData.takeProfit1 = resolvedTP;
        positionData.tpHit       = false;

        if (positionData.ctcEnabled && resolvedTP && positionData.entryPrice) {
            const newTrigger = isLong
                ? positionData.entryPrice + positionData.ctcTrigger * (resolvedTP - positionData.entryPrice)
                : positionData.entryPrice - positionData.ctcTrigger * (positionData.entryPrice - resolvedTP);

            const tpActuallyChanged = previousTP !== resolvedTP;
            if (tpActuallyChanged) {
                // TP was genuinely changed (e.g. manual edit) → new CTC distance → reset
                positionData.ctcTriggered = false;
                this.logger.info(`📐 CTC trigger recomputed (TP change): ${newTrigger?.toFixed(4)}`);
            }
            // If only SL changed (CTC break-even move, holding close, etc.)
            // do NOT reset ctcTriggered — it would cause CTC to re-fire on the very
            // next 5-second tick and hammer the MEXC UI with repeated update attempts.
            positionData.ctcTriggerPrice = newTrigger;
        }

        this.monitoredPositions.set(symbol, positionData);
        this.logger.info(`✏️ SL/TP updated for ${symbol}: SL ${previousSL} → ${resolvedSL} | TP ${previousTP} → ${resolvedTP}`);

        try {
            const trades    = await this.storage.getAllTrades();
            const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
            if (openTrade) {
                const adjustment = {
                    timestamp: Date.now(), previousSL: previousSL ?? null,
                    previousTP: previousTP ?? null, newSL: resolvedSL, newTP: resolvedTP,
                    reason: 'manual-adjustment'
                };
                await this.storage.updateTrade(openTrade.id, {
                    currentSL: resolvedSL, currentTP: resolvedTP,
                    slTpAdjustments: [...(openTrade.slTpAdjustments || []), adjustment]
                });
                this.logger.info(`📝 Adjustment logged to trade ${openTrade.id}`);
            }
        } catch (err) {
            this.logger.error(`Failed to log SL/TP adjustment for ${symbol}:`, err.message);
        }

        return { success: true, symbol, previousSL, previousTP, newSL: resolvedSL, newTP: resolvedTP, exchangeUpdated };
    }

    async setPositionHolding(symbol, enabled) {
        const positionData = this.monitoredPositions.get(symbol);
        if (!positionData) return false;

        const wasDisabled = !positionData.holdingEnabled;
        positionData.holdingEnabled = !!enabled;
        this.monitoredPositions.set(symbol, positionData);
        this.logger.info(`📌 ${symbol} holding: ${enabled ? 'ENABLED' : 'DISABLED'}`);

        if (enabled && wasDisabled && positionData.holdingCandles > 0) {
            // Use closedCandles (no +1) to match checkPosition — fire only when
            // Nth candle has actually CLOSED, not just started.
            const closedCandles = Math.floor((Date.now() - positionData.tradeStartTime) / CANDLE_INTERVAL_MS);
            if (closedCandles >= positionData.holdingCandles) {
                this.logger.info(`⏰ ${symbol}: holding re-enabled — already ${closedCandles}/${positionData.holdingCandles} candles closed → closing now`);
                await this._closeForHolding(symbol, positionData);
            }
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Limit order monitoring
    // ─────────────────────────────────────────────────────────────────────────

    addPendingLimitOrder(symbol, orderDetails) {
        this.pendingLimitOrders.set(symbol, orderDetails);
        this.logger.info(`📌 Monitoring pending limit order for ${symbol}`);
    }

    async checkLimitOrders() {
        if (this.pendingLimitOrders.size === 0) return;
        const isTestnet = this.client.isTestnet();
        try {
            for (const [symbol, orderDetails] of this.pendingLimitOrders.entries()) {
                const positions = await this.client.getPositions(symbol);
                const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
                if (position) {
                    this.logger.info(`✅ Limit order filled for ${symbol} at ${position.entryPrice}`);
                    const entryPrice = parseFloat(position.entryPrice);
                    const quantity   = Math.abs(parseFloat(position.positionAmt));

                    if (!isTestnet && !this._uiCloseHandler) {
                        const symbolInfo = await this.client.getSymbolInfo(symbol);
                        await this.executor.setStopLossAndTakeProfits(
                            symbol, orderDetails.side, entryPrice, quantity,
                            { stopLoss: orderDetails.stopLoss, takeProfit1: orderDetails.takeProfit1 },
                            symbolInfo
                        );
                    }

                    this.addPosition(symbol, {
                        side:           orderDetails.side,
                        entryPrice,
                        orderType:      'LIMIT',
                        ctcEnabled:     orderDetails.ctcEnabled    || false,
                        ctcTrigger:     orderDetails.ctcTrigger    || 0.5,
                        holdingCandles: orderDetails.holdingCandles || 0,
                        tradeStartTime: orderDetails.entryTime || orderDetails.tradeStartTime || Date.now(),
                        // browser-bot mode: softwareSLTP=false
                        softwareSLTP:   isTestnet && !this._uiCloseHandler,
                        stopLoss:       orderDetails.stopLoss    || null,
                        takeProfit1:    orderDetails.takeProfit1  || null
                    });
                    this.pendingLimitOrders.delete(symbol);
                }
            }
        } catch (error) {
            this.logger.error('Error checking limit orders:', error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Main position check loop
    // ─────────────────────────────────────────────────────────────────────────

    async checkPositions() {
        if (this.monitoredPositions.size === 0) return;
        try {
            for (const [symbol, positionData] of this.monitoredPositions.entries()) {
                await this.checkPosition(symbol, positionData);
            }
        } catch (error) {
            this.logger.error('Error checking positions:', error.message);
        }
    }

    async checkPosition(symbol, positionData) {
        try {
            // ── Guard: skip if a UI close is already in flight ───────────────
            if (positionData._closing) {
                this.logger.debug(`⏭️  ${symbol}: close in progress — skipping this tick`);
                return;
            }

            // ── Guard: manual mode — user has taken over this position ────────
            // When manualMode=true the bot skips ALL automated actions:
            // holding-candle force-close, software SL/TP checks, CTC break-even.
            // The position stays in the map so the dashboard still shows live PnL.
            // Auto-close detection (position gone on exchange) is also skipped —
            // the user will close it directly on MEXC and then clear the card.
            if (positionData.manualMode) {
                this.logger.debug(`🎮 ${symbol}: manual mode — bot hands-off`);
                return;
            }

            const positions = await this.client.getPositions(symbol);
            const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!position) {
                // ── Grace period guard ────────────────────────────────────────
                // MEXC REST getPositions() can lag 10-30 s after a browser-bot UI
                // placement.  Never treat "position missing from REST" as auto-closed
                // within the first 60 seconds of adding the position to the monitor.
                const monitorAge = Date.now() - (positionData.monitorAddedAt || positionData.tradeStartTime);
                if (monitorAge < 60_000) {
                    this.logger.debug(
                        `⏳ ${symbol}: not visible in REST yet (${Math.round(monitorAge / 1000)}s < 60s grace) — waiting`
                    );
                    return;
                }

                // Position already gone on exchange — record automatic close
                // (skip if a parallel _closeForHolding/_closeFullPosition is handling it)
                if (positionData._closing) {
                    this.monitoredPositions.delete(symbol);
                    return;
                }
                this.logger.info(`📊 Position closed for ${symbol}`);
                let closePnl = positionData.lastKnownPnL || 0;
                if (typeof this.client.getHistoricalPnL === 'function') {
                    try {
                        const histPnl = await this.client.getHistoricalPnL(symbol);
                        if (histPnl !== null) {
                            closePnl = histPnl;
                            this.logger.info(`💰 Realized PnL from exchange: $${closePnl.toFixed(4)}`);
                        }
                    } catch (_) {}
                }
                await this._recordClose(symbol, positionData, closePnl, 'automatic');
                this.monitoredPositions.delete(symbol);
                return;
            }

            const currentPnL = parseFloat(position.unRealizedProfit);
            positionData.lastKnownPnL = currentPnL;
            positionData.lastUpdated  = Date.now();
            this.monitoredPositions.set(symbol, positionData);

            // ── HOLDING CANDLE CHECK ──────────────────────────────────────────
            // "holding candles" means: wait until that many candles have CLOSED.
            //
            // Formula:
            //   closedCandles = floor((now - entryTime) / 3min)
            //                 = number of complete 3-min candles since entry
            //
            //   entry candle (0 closed):    closedCandles = 0
            //   after 1st candle closes:    closedCandles = 1
            //   after 8th candle closes:    closedCandles = 8  → close now
            //
            // The display adds +1 so entry reads "Candle 1/8" (not "Candle 0/8").
            // ⚠️  Old code used `>= holdingCandles` with the +1 formula, which
            //     fired on the START of the Nth candle, 3 min too early.
            //     e.g. holdingCandles=8: fired at 21 min instead of 24 min.
            if (positionData.holdingEnabled && positionData.holdingCandles > 0) {
                const closedCandles = Math.floor((Date.now() - positionData.tradeStartTime) / CANDLE_INTERVAL_MS);
                if (closedCandles >= positionData.holdingCandles) {
                    const displayCandle = Math.min(closedCandles + 1, positionData.holdingCandles);
                    this.logger.info(`⏰ Holding limit reached for ${symbol}: ${positionData.holdingCandles} candles closed — closing (display: ${displayCandle}/${positionData.holdingCandles})`);
                    await this._closeForHolding(symbol, positionData);
                    return;
                }
            }

            // ── SOFTWARE SL/TP CHECK ─────────────────────────────────────────
            // ⚠️  NEVER enabled in MEXC browser-bot mode (softwareSLTP=false there).
            // MEXC handles TP/SL via its own stop orders — a REST market close would
            // execute at spot price instead of the pre-set limit TP price.
            if (positionData.softwareSLTP) {
                const closed = await this._checkSoftwareSLTP(symbol, positionData, position);
                if (closed) return;
            }

            // ── CTC TRIGGER CHECK ─────────────────────────────────────────────
            // ⚠️  CRITICAL price-source priority for CTC:
            //   We need the CURRENT live price to detect if price crossed the
            //   CTC trigger level — NOT the candle-open price (getCandleOpen),
            //   which is stale by up to 3 minutes and WILL cause CTC to miss
            //   even if price travelled 70% towards TP inside the candle.
            //
            //   Priority:
            //   1. getLivePrice()    — WS push.ticker lastPrice (0ms, always current) ✅
            //   2. position.markPrice — live REST ticker from the getPositions() call above ✅
            //   3. REST getPrice()   — separate REST call, only if WS is cold-starting
            //   ❌ getCandleOpen()   — NEVER for CTC (candle open ≠ current price)
            if (positionData.ctcEnabled && !positionData.ctcTriggered && positionData.ctcTriggerPrice !== null) {
                // 1. WS ticker — 0ms latency, updates on every tick
                const wsTickerPrice = typeof this.client.getLivePrice === 'function'
                    ? this.client.getLivePrice(symbol) : null;

                // 2. markPrice from position REST response (set by getPositions() → ticker REST)
                const restMarkPrice = parseFloat(position.markPrice || position.lastPrice || '0') || null;

                let markPrice = wsTickerPrice || restMarkPrice;
                if (!markPrice || isNaN(markPrice)) {
                    // 3. Last-resort: separate REST getPrice() — only on cold WS start
                    this.logger.warn(`⚠️  CTC: no live price cached for ${symbol} — falling back to REST getPrice()`);
                    try { markPrice = await this.client.getPrice(symbol); } catch (_) {}
                }

                // ── Visibility log (shows every 5s tick) ─────────────────────
                const priceSource = wsTickerPrice ? 'WS-ticker' : restMarkPrice ? 'REST-mark' : 'REST-get';
                this.logger.info(
                    `🔍 CTC [${symbol}] price=${markPrice?.toFixed(2)} (${priceSource}) ` +
                    `trigger=${positionData.ctcTriggerPrice?.toFixed(2)} ` +
                    `${positionData.side === 'LONG' ? 'need ≥' : 'need ≤'} ← ${positionData.side}`
                );

                const isLong    = positionData.side === 'LONG';
                const triggered = markPrice > 0 && (isLong
                    ? markPrice >= positionData.ctcTriggerPrice
                    : markPrice <= positionData.ctcTriggerPrice);

                if (triggered) {
                    this.logger.info(`🔄 CTC triggered for ${symbol} | price: ${markPrice} | trigger: ${positionData.ctcTriggerPrice?.toFixed(4)}`);

                    const feeBuffer = 0.0004;
                    const bePrice   = isLong
                        ? positionData.entryPrice * (1 + feeBuffer)
                        : positionData.entryPrice * (1 - feeBuffer);

                    positionData.ctcTriggered = true;
                    this.monitoredPositions.set(symbol, positionData);

                    // Capture original SL NOW — updateSLTP updates in-memory immediately,
                    // so positionData.stopLoss will equal bePrice after the call returns.
                    const originalSL = positionData.stopLoss;

                    try {
                        const slResult = await this.updateSLTP(symbol, bePrice, null);
                        if (slResult.exchangeUpdated) {
                            this.logger.info(`✅ CTC: SL moved to break-even at ${bePrice.toFixed(4)} (exchange updated ✓)`);
                        } else {
                            // ── CRITICAL FIX: revert phantom in-memory SL ──────────────────────
                            // updateSLTP() ALWAYS writes positionData.stopLoss = bePrice (line ~330)
                            // regardless of whether the browser bot succeeded.
                            // If we leave it at bePrice and the exchange SL is still at originalSL,
                            // the next price bounce (even 5 pips) will trigger the SL guard on the
                            // phantom level, emergency-closing a trade that the exchange would NOT
                            // have stopped.  This is exactly what happened on 2026-06-16:
                            //   CTC fired → bot failed → in-memory SL=66870 (phantom) → price
                            //   bounced to 66874 → SL guard closed at +$53 instead of letting TP run.
                            //
                            // Fix: revert in-memory SL back to the ORIGINAL exchange SL so the SL
                            // guard enforces reality.  ctcPendingBePrice stores the desired level
                            // and is retried every 5s tick until the exchange confirms it.
                            positionData.stopLoss        = originalSL;     // revert phantom level
                            positionData.ctcPendingBePrice = bePrice;      // retry on next tick
                            positionData.ctcOriginalSL    = originalSL;    // saved for retry reverts
                            this.monitoredPositions.set(symbol, positionData);
                            this.logger.warn(
                                `⚠️ CTC: break-even SL FAILED on exchange — in-memory SL reverted to ` +
                                `original ${originalSL?.toFixed(4) ?? 'N/A'} (MEXC SL unchanged). ` +
                                `Auto-retrying every 5s tick until confirmed.`
                            );
                        }
                    } catch (ctcErr) {
                        // Same revert: do NOT leave phantom break-even in-memory
                        this.logger.warn(`⚠️ CTC SL update threw for ${symbol}: ${ctcErr.message} — keeping original exchange SL, queuing retry`);
                        positionData.stopLoss        = originalSL;   // revert, NOT bePrice
                        positionData.ctcPendingBePrice = bePrice;
                        positionData.ctcOriginalSL    = originalSL;
                        this.monitoredPositions.set(symbol, positionData);
                    }
                }
            }

            // ── Auto-retry pending CTC break-even SL (every 5s tick) ─────────
            // When the browser bot failed to move SL to break-even on the first
            // CTC trigger, ctcPendingBePrice is set and in-memory SL was reverted
            // to the original exchange SL (ctcOriginalSL).  Retry every tick so
            // the break-even SL gets applied as soon as the browser bot recovers.
            // While pending, positionData.stopLoss == ctcOriginalSL so the SL
            // guard will NOT falsely fire on a small post-CTC price bounce.
            if (positionData.ctcTriggered && positionData.ctcPendingBePrice) {
                const pendingBe = positionData.ctcPendingBePrice;
                this.logger.info(
                    `🔁 [CTC-Retry] Browser bot may have recovered — retrying break-even SL ` +
                    `at ${pendingBe.toFixed(4)} for ${symbol} ` +
                    `(exchange SL still at ${positionData.ctcOriginalSL?.toFixed(4) ?? 'N/A'})…`
                );
                try {
                    const retryResult = await this.updateSLTP(symbol, pendingBe, null);
                    if (retryResult.exchangeUpdated) {
                        positionData.ctcPendingBePrice = null;
                        positionData.ctcOriginalSL     = null;
                        this.monitoredPositions.set(symbol, positionData);
                        this.logger.info(`✅ [CTC-Retry] Break-even SL confirmed on MEXC at ${pendingBe.toFixed(4)} for ${symbol}`);
                    } else {
                        // Still failing — revert in-memory SL so SL guard stays on original
                        positionData.stopLoss = positionData.ctcOriginalSL ?? pendingBe;
                        this.monitoredPositions.set(symbol, positionData);
                    }
                } catch (retryErr) {
                    this.logger.warn(`⚠️ [CTC-Retry] Retry threw for ${symbol}: ${retryErr.message} — keeping original SL`);
                    positionData.stopLoss = positionData.ctcOriginalSL ?? pendingBe;
                    this.monitoredPositions.set(symbol, positionData);
                }
            }

        } catch (error) {
            this.logger.error(`Error checking position ${symbol}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Software SL/TP — ONLY used when softwareSLTP=true (Binance / testnet)
    // ─────────────────────────────────────────────────────────────────────────

    async _checkSoftwareSLTP(symbol, positionData, position) {
        const markPrice = parseFloat(position.markPrice);
        const isLong    = positionData.side === 'LONG';

        if (positionData.stopLoss) {
            const slHit = isLong ? markPrice <= positionData.stopLoss : markPrice >= positionData.stopLoss;
            if (slHit) {
                this.logger.info(`🛑 SL hit for ${symbol}: mark=${markPrice} | SL=${positionData.stopLoss}`);
                await this._closeFullPosition(symbol, positionData, position, 'software-sl');
                return true;
            }
        }

        if (!positionData.tpHit && positionData.takeProfit1) {
            const tpHit = isLong ? markPrice >= positionData.takeProfit1 : markPrice <= positionData.takeProfit1;
            if (tpHit) {
                this.logger.info(`🎯 TP hit for ${symbol}: mark=${markPrice} | TP=${positionData.takeProfit1}`);
                positionData.tpHit = true;
                this.monitoredPositions.set(symbol, positionData);
                await this._closeFullPosition(symbol, positionData, position, 'software-tp');
                return true;
            }
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Close helpers
    //  _uiCloseHandler (browser bot) is preferred over executor.closePosition()
    // ─────────────────────────────────────────────────────────────────────────

    async _closeFullPosition(symbol, positionData, position, reason) {
        // ── Double-close guard — set immediately, before any await ───────────
        if (positionData._closing) {
            this.logger.debug(`⏭️  _closeFullPosition: ${symbol} already closing — skipped`);
            return;
        }
        positionData._closing = true;
        this.monitoredPositions.set(symbol, positionData);   // persist flag now

        try {
            const snapshotPnl = position ? parseFloat(position.unRealizedProfit) : (positionData.lastKnownPnL || 0);
            // ── Skip REST cancelPositionSLTP in browser-bot mode ──────────────
            // The MEXC browser UI flash-close already cancels the position's stop
            // orders as part of the close flow — an extra REST cancel would be a
            // redundant API call that still charges a fee.
            if (!this._uiCloseHandler && typeof this.client.cancelPositionSLTP === 'function') {
                try { await this.client.cancelPositionSLTP(symbol); } catch (_) {}
            }
            if (this._uiCloseHandler) {
                this.logger.info(`🖥️  Closing ${symbol} via browser bot UI (${reason})`);
                await this._uiCloseHandler(symbol, positionData.side);
                // Wait for MEXC to settle and record the close before fetching realized PnL
                await new Promise(r => setTimeout(r, 3000));
            } else {
                await this.executor.closePosition(symbol, reason);
            }
            await this._recordClose(symbol, positionData, snapshotPnl, reason);
            this.monitoredPositions.delete(symbol);
        } catch (err) {
            this.logger.error(`❌ Failed to close ${symbol} (${reason}): ${err.message} — resetting _closing flag so next tick retries`);
            // ── CRITICAL: reset _closing so the next checkPosition tick retries ──
            positionData._closing = false;
            this.monitoredPositions.set(symbol, positionData);
        }
    }

    async _closeForHolding(symbol, positionData) {
        // ── Double-close guard ───────────────────────────────────────────────
        if (positionData._closing) {
            this.logger.debug(`⏭️  _closeForHolding: ${symbol} already closing — skipped`);
            return;
        }
        positionData._closing = true;
        this.monitoredPositions.set(symbol, positionData);   // persist flag now

        try {
            const positions = await this.client.getPositions(symbol);
            const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            const snapshotPnl = position ? parseFloat(position.unRealizedProfit) : (positionData.lastKnownPnL || 0);

            // ── Skip REST cancelPositionSLTP in browser-bot mode ──────────────
            // The MEXC browser UI flash-close handles stop order cancellation
            // internally — no REST API calls needed (avoids extra fees).
            if (!this._uiCloseHandler && typeof this.client.cancelPositionSLTP === 'function') {
                try { await this.client.cancelPositionSLTP(symbol); } catch (_) {}
            }

            if (this._uiCloseHandler) {
                this.logger.info(`🖥️  Closing ${symbol} via browser bot UI (holding-candles-limit)`);
                await this._uiCloseHandler(symbol, positionData.side);
                // Wait for MEXC to settle and record the close before fetching realized PnL
                await new Promise(r => setTimeout(r, 3000));
            } else {
                await this.executor.closePosition(symbol, 'holding-candles-limit');
            }

            await this._recordClose(symbol, positionData, snapshotPnl, 'holding-candles-limit');
            this.monitoredPositions.delete(symbol);
        } catch (err) {
            this.logger.error(`❌ Failed to close ${symbol} on holding limit: ${err.message} — resetting _closing flag so next tick retries`);
            // ── CRITICAL: reset _closing so the next checkPosition tick retries ──
            // Without this, _closing stays true forever and the position is never
            // checked again → runs until exchange SL/TP hit instead of holding limit.
            positionData._closing = false;
            this.monitoredPositions.set(symbol, positionData);
        }
    }

    /**
     * Record a closed trade with ACCURATE realized PnL and fees.
     *
     * PnL source (priority):
     *   1. getHistoricalPnL() — actual exchange-confirmed realized PnL (MEXC history API)
     *   2. snapshotPnl — unrealized PnL captured just before close (fallback)
     *
     * Fee formula (MEXC):
     *   • Each market order leg: notional * 0.0001 (0.01% taker fee)
     *   • Round-trip total: notional * 0.0002
     *   • notional = marginDollar × leverage (stored in positionData.notional)
     *   • NOT pnl × 0.04% — that was completely wrong (100× off for large positions!)
     *
     *   Example: $314 margin × 200× leverage = $62,800 notional
     *     fees ≈ $62,800 × 0.0002 = $12.56 (2 × $6.28 per leg) ✓
     */
    async _recordClose(symbol, positionData, snapshotPnl, reason) {
        try {
            const trades    = await this.storage.getAllTrades();
            const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
            if (!openTrade) return;

            // ── 1. Try to get actual realized PnL from exchange history ──────
            let pnl = snapshotPnl;
            let pnlSource = 'snapshot-unrealized';

            if (typeof this.client.getHistoricalPnL === 'function') {
                try {
                    const histPnl = await this.client.getHistoricalPnL(symbol);
                    if (histPnl !== null && histPnl !== undefined) {
                        pnl = histPnl;
                        pnlSource = 'mexc-history-api';
                        this.logger.info(`💰 Realized PnL from MEXC history: $${pnl.toFixed(4)}`);
                    }
                } catch (_) {}
            }

            // ── 2. Compute fees from notional (correct MEXC formula) ─────────
            // Prefer positionData.notional; fall back to signal-stored notional.
            const storedNotional = positionData.notional
                || (openTrade.signal?.marginDollar && openTrade.signal?.leverage
                    ? parseFloat(openTrade.signal.marginDollar) * parseFloat(openTrade.signal.leverage)
                    : 0);

            let fees;
            if (storedNotional > 0) {
                // MEXC taker: 0.01% (0.0001) per leg × 2 legs (open + close)
                fees = storedNotional * 0.0002;
            } else {
                // Last-resort fallback: estimate from absolute PnL magnitude
                // (still better than pnl * 0.0004 which was 100× wrong)
                fees = Math.abs(snapshotPnl) * 0.05; // rough 5% of |pnl| as fee
            }

            const netPnL = pnl - fees;

            await this.storage.updateTrade(openTrade.id, {
                status: 'closed', closedAt: Date.now(), closeReason: reason,
                pnl, fees, netPnL, pnlSource
            });

            this.logger.info(
                `✅ Trade ${openTrade.id} closed (${reason}): ` +
                `gross=$${pnl.toFixed(2)} fees=$${fees.toFixed(2)} net=$${netPnL.toFixed(2)} [${pnlSource}]`
            );
        } catch (err) {
            this.logger.error(`Failed to update trade record for ${symbol}:`, err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Safety check — live Binance mode only
    // ─────────────────────────────────────────────────────────────────────────

    async safetyCheckUnprotectedPositions() {
        if (this.client.isTestnet()) return;
        try {
            const allPositions  = await this.client.getPositions();
            const openPositions = allPositions.filter(p => parseFloat(p.positionAmt) !== 0);
            if (openPositions.length === 0) return;
            this.logger.debug(`🛡️ Safety check: ${openPositions.length} open positions`);
            for (const position of openPositions) {
                await this.checkPositionHasStopLoss(position);
            }
        } catch (error) {
            this.logger.error('Error in safety check:', error.message);
        }
    }

    async checkPositionHasStopLoss(position) {
        const symbol  = position.symbol;
        const monData = this.monitoredPositions.get(symbol);

        // Skip exchange SL check for browser-bot positions — MEXC manages its own stops
        if (monData && (monData.softwareSLTP || this._uiCloseHandler)) {
            this.logger.debug(`🛡️ ${symbol}: browser-bot/software SL active, skipping exchange check`);
            return;
        }

        try {
            const openOrders  = await this.client.getOpenOrders(symbol);
            const hasStopLoss = openOrders.some(o => o.type === 'STOP_MARKET');
            if (hasStopLoss) return;

            this.logger.warn(`⚠️ UNPROTECTED POSITION: ${symbol} has NO Stop Loss!`);
            const trades = await this.storage.getAllTrades();
            const trade  = trades.find(t => t.symbol === symbol && t.status === 'open');

            if (!trade || !trade.signal || !trade.signal.stopLoss) {
                this.logger.error(`🚨 EMERGENCY: ${symbol} — no SL in DB → closing for safety`);
                if (this._uiCloseHandler) {
                    await this._uiCloseHandler(symbol, monData?.side || 'LONG').catch(() => {});
                } else {
                    await this.executor.closePosition(symbol, 'emergency-no-sl-data');
                }
                this.monitoredPositions.delete(symbol);
                return;
            }

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const isLong     = parseFloat(position.positionAmt) > 0;
            const slPrice    = this.executor.roundToTickSize(trade.signal.stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision);
            const posQty     = Math.abs(parseFloat(position.positionAmt));

            try {
                await this.client.placeOrder({
                    symbol, side: isLong ? 'SELL' : 'BUY', type: 'STOP_MARKET',
                    quantity: posQty.toString(), stopPrice: slPrice.toString(),
                    reduceOnly: 'true', workingType: 'MARK_PRICE'
                });
                this.logger.info(`✅ Missing SL set for ${symbol} at ${slPrice}`);
            } catch (slError) {
                this.logger.error(`🚨 EMERGENCY: Failed to set SL for ${symbol} → closing for safety`);
                if (this._uiCloseHandler) {
                    await this._uiCloseHandler(symbol, monData?.side || 'LONG').catch(() => {});
                } else {
                    await this.executor.closePosition(symbol, 'emergency-sl-failed');
                }
                this.monitoredPositions.delete(symbol);
            }
        } catch (error) {
            this.logger.error(`Error checking SL for ${symbol}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SL Guardian — fires every 1 second using WS-cached price (no REST)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Runs every 1 second. Uses the WS live price (getLivePrice — 0ms latency)
     * to detect if any monitored position has breached its stopLoss level while
     * MEXC's own stop order failed to execute.
     *
     * Only active in MEXC browser-bot mode (_uiCloseHandler registered).
     * Uses Flash Close via Puppeteer — no REST market orders.
     */
    async _slGuardTick() {
        // Only runs in browser-bot mode (when _uiCloseHandler is registered)
        if (!this._uiCloseHandler) return;
        if (this.monitoredPositions.size === 0) return;
        if (typeof this.client.getLivePrice !== 'function') return;

        for (const [symbol, positionData] of this.monitoredPositions.entries()) {
            // Skip if manual mode — user is managing this position
            if (positionData.manualMode) continue;
            // Skip if already in a close flow
            if (positionData._closing) continue;

            // Skip if no SL is stored in the monitor
            if (!positionData.stopLoss || positionData.stopLoss <= 0) continue;

            // ── Grace period: don't check SL in first 60s ───────────────────
            // Position may not be settled on exchange yet (REST lag).
            // Also avoids false triggers from pre-fill price movement.
            const monitorAge = Date.now() - (positionData.monitorAddedAt || positionData.tradeStartTime);
            if (monitorAge < 60_000) continue;

            // ── Get WS-cached live price (0ms — no network call) ────────────
            const livePrice = this.client.getLivePrice(symbol);
            if (!livePrice || isNaN(livePrice) || livePrice <= 0) continue;

            // ── Check SL breach ──────────────────────────────────────────────
            const isLong = positionData.side === 'LONG';
            const slBreached = isLong
                ? livePrice <= positionData.stopLoss
                : livePrice >= positionData.stopLoss;

            if (!slBreached) continue;

            // ── SL MISSED by MEXC — Emergency flash-close ───────────────────
            this.logger.warn(
                `🚨 [SL GUARD] ${symbol} ${isLong ? 'LONG' : 'SHORT'}: ` +
                `live=${livePrice} breached SL=${positionData.stopLoss} — ` +
                `MEXC stop order missed! Emergency flash-close firing…`
            );

            // Set _closing immediately (synchronous) to block all other loops
            positionData._closing = true;
            this.monitoredPositions.set(symbol, positionData);

            // Fire close asynchronously — don't await in the 1s tick loop
            this._slGuardClose(symbol, positionData, livePrice).catch(err => {
                this.logger.error(`❌ [SL GUARD] Close failed for ${symbol}: ${err.message} — retrying next tick`);
                // Reset so next tick retries
                const pos = this.monitoredPositions.get(symbol);
                if (pos) { pos._closing = false; this.monitoredPositions.set(symbol, pos); }
            });

            // Only process one SL breach per tick to avoid hammering the browser
            break;
        }
    }

    /**
     * Executes a Puppeteer Flash Close for a missed-SL position.
     * Called async from _slGuardTick (fire-and-forget with error handling).
     */
    async _slGuardClose(symbol, positionData, triggerPrice) {
        this.logger.warn(
            `🔴 [SL GUARD] Flash-closing ${symbol} ${positionData.side} ` +
            `| SL=${positionData.stopLoss} | price at trigger=${triggerPrice}`
        );

        const snapshotPnl = positionData.lastKnownPnL || 0;

        try {
            await this._uiCloseHandler(symbol, positionData.side);

            // Wait for MEXC to settle the close before fetching realized PnL
            await new Promise(r => setTimeout(r, 3000));

            await this._recordClose(symbol, positionData, snapshotPnl, 'sl-guard-emergency');
            this.monitoredPositions.delete(symbol);

            this.logger.warn(
                `✅ [SL GUARD] ${symbol} closed successfully via Flash Close ` +
                `(MEXC stop order was missed)`
            );
        } catch (err) {
            // ── "Position row not found" = MEXC already closed via its own stop order ──
            // The exchange's stop order fired at the same moment as our SL Guard.
            // The position is gone from the DOM — treat as clean close (not a failure).
            if (/Position row not found|not found/i.test(err.message)) {
                this.logger.info(
                    `ℹ️  [SL GUARD] ${symbol}: position already closed by MEXC exchange stop order ` +
                    `(DOM gone before flash-close — this is correct behavior)`
                );
                // Wait briefly then record close (MEXC history API needs a moment to settle)
                await new Promise(r => setTimeout(r, 2000));
                await this._recordClose(symbol, positionData, snapshotPnl, 'sl-exchange-stop');
                this.monitoredPositions.delete(symbol);
                this.logger.info(`✅ [SL GUARD] ${symbol} removed from monitor (closed by exchange stop order)`);
            } else {
                // Genuine close failure — re-throw so caller resets _closing for retry
                throw err;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Status / getters
    // ─────────────────────────────────────────────────────────────────────────

    getStatus() {
        const positions = Array.from(this.monitoredPositions.entries()).map(([symbol, data]) => {
            // Display: entry candle = 1, capped at holdingCandles so UI never
            // shows "9/8" in the brief window between candle-close and monitor tick.
            const rawElapsed = data.tradeStartTime
                ? Math.floor((Date.now() - data.tradeStartTime) / CANDLE_INTERVAL_MS) + 1
                : 1;
            const elapsed = data.holdingCandles > 0
                ? Math.min(rawElapsed, data.holdingCandles)
                : rawElapsed;
            return {
                symbol,
                side:            data.side,
                entryPrice:      data.entryPrice,
                orderType:       data.orderType,
                ctcEnabled:      data.ctcEnabled,
                ctcTrigger:      data.ctcTrigger,
                ctcTriggerPrice: data.ctcTriggerPrice,
                ctcTriggered:    data.ctcTriggered,
                holdingCandles:  data.holdingCandles,
                holdingEnabled:  data.holdingEnabled,
                tradeStartTime:  data.tradeStartTime,
                elapsedCandles:  elapsed,
                softwareSLTP:    data.softwareSLTP,
                stopLoss:        data.stopLoss,
                takeProfit1:     data.takeProfit1,
                tpHit:           data.tpHit,
                lastKnownPnL:    data.lastKnownPnL,
                lastUpdated:     data.lastUpdated,
                manualMode:      data.manualMode || false
            };
        });
        return {
            monitoredPositions: this.monitoredPositions.size,
            pendingLimitOrders: this.pendingLimitOrders.size,
            tradeMode:          this.client.tradeMode,
            positions
        };
    }
}

module.exports = PositionMonitor;
