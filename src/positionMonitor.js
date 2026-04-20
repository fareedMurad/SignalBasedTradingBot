/**
 * Position Monitor Module
 * Monitors positions with:
 *  - Software SL/TP  (testnet mode — exchange conditional orders blocked)
 *      • Checks mark price vs SL/TP levels every 5 s
 *      • Single TP exit: closes 100% of position when TP is hit
 *      • Single SL exit: closes 100% of position when SL is hit
 *      • CTC: when price reaches ctcTrigger% of TP distance → move SL to break-even (trade continues)
 *  - Exchange SL/TP  (live mode — exchange-native STOP_MARKET / TAKE_PROFIT_MARKET)
 *      • Safety watcher verifies every 30 s that exchange SL order exists
 *  - Holding candle limit (3-min candles, auto-close when limit reached)
 *  - Per-position holding enable/disable toggle
 */

const CANDLE_INTERVAL_MS = 3 * 60 * 1000; // 3-minute candles

class PositionMonitor {
    constructor(binanceClient, tradeExecutor, logger, storageManager) {
        this.client     = binanceClient;
        this.executor   = tradeExecutor;
        this.logger     = logger;
        this.storage    = storageManager;

        // symbol → position data object
        this.monitoredPositions  = new Map();
        // symbol → pending limit order details
        this.pendingLimitOrders  = new Map();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async start() {
        this.logger.info('🔍 Position monitor started');

        // Main position check every 5 s
        this.monitorInterval = setInterval(async () => {
            await this.checkPositions();
        }, 5000);

        // Check for filled limit orders every 10 s
        this.limitOrderInterval = setInterval(async () => {
            await this.checkLimitOrders();
        }, 10000);

        // Safety: check for unprotected positions every 30 s (live mode only)
        this.safetyMonitorInterval = setInterval(async () => {
            await this.safetyCheckUnprotectedPositions();
        }, 30000);

        const isTestnet = this.client.isTestnet();
        this.logger.info(`🛡️ Safety monitor enabled (${isTestnet ? 'software SL/TP — no exchange SL check' : 'live — checking exchange SL orders'})`);
    }

    stop() {
        if (this.monitorInterval)       clearInterval(this.monitorInterval);
        if (this.limitOrderInterval)    clearInterval(this.limitOrderInterval);
        if (this.safetyMonitorInterval) clearInterval(this.safetyMonitorInterval);
        this.logger.info('🛑 Position monitor stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Add / Remove positions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Add a position to monitoring.
     *
     * Signal provider model (single TP):
     *   side, entryPrice, orderType, ctcEnabled, ctcTrigger, holdingCandles, tradeStartTime
     *   softwareSLTP  - boolean
     *   stopLoss      - SL price (100% close on hit)
     *   takeProfit1   - single TP price (100% close on hit)
     *
     * CTC: when price reaches ctcTrigger% of entry→TP distance → move in-memory SL to break-even (does NOT close)
     */
    addPosition(symbol, options) {
        const {
            side,
            entryPrice,
            orderType      = 'MARKET',
            ctcEnabled     = false,
            ctcTrigger     = 0.5,
            holdingCandles = 0,
            tradeStartTime = Date.now(),
            // software SL/TP
            softwareSLTP   = false,
            stopLoss       = null,
            takeProfit1    = null
        } = options;

        const holdingEnabled = holdingCandles > 0;
        const isLong = side === 'LONG';

        // Pre-compute CTC trigger price (ctcTrigger% of entry→TP distance)
        let ctcTriggerPrice = null;
        if (ctcEnabled && takeProfit1 && entryPrice) {
            ctcTriggerPrice = isLong
                ? entryPrice + ctcTrigger * (takeProfit1 - entryPrice)
                : entryPrice - ctcTrigger * (entryPrice - takeProfit1);
            this.logger.info(
                `📐 CTC trigger for ${symbol}: ${ctcTriggerPrice.toFixed(4)} (${(ctcTrigger * 100).toFixed(0)}% of TP dist)`
            );
        }

        this.monitoredPositions.set(symbol, {
            side,
            entryPrice,
            orderType,
            // CTC
            ctcEnabled: !!ctcEnabled,
            ctcTrigger,
            ctcTriggerPrice,
            ctcTriggered: false,
            // Holding candles
            holdingCandles,
            tradeStartTime,
            holdingEnabled,
            // Software SL/TP — single TP model (100% exit on SL or TP hit)
            softwareSLTP: !!softwareSLTP,
            stopLoss,
            takeProfit1,
            tpHit: false,
            // Misc
            lastKnownPnL: 0,
            lastUpdated: Date.now()
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
    //  Holding toggle
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    //  SL/TP manual edit
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Update SL and/or TP for an active monitored position.
     *
     * History policy:
     *   - Original stopLoss / takeProfit1 on the trade record are NEVER overwritten.
     *   - Each adjustment is appended to trade.slTpAdjustments[] with full audit log.
     *   - trade.currentSL / trade.currentTP reflect the latest active levels.
     *
     * Behaviour:
     *   - Software SL/TP (testnet): updates in-memory only; exchange orders not touched.
     *   - Live mode: cancels old STOP_MARKET / TAKE_PROFIT_MARKET, places new ones.
     *   - CTC trigger price is recomputed from the new TP.
     *
     * @param {string}  symbol
     * @param {number|null} newSL  - new stop loss price  (null = keep current)
     * @param {number|null} newTP  - new take profit price (null = keep current)
     * @returns {object} { success, symbol, previousSL, previousTP, newSL, newTP }
     */
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

        // ── Basic directional validation ─────────────────────────────────────
        if (resolvedSL && resolvedTP) {
            if (isLong && resolvedSL >= resolvedTP) {
                return { success: false, error: `LONG: SL (${resolvedSL}) must be below TP (${resolvedTP})` };
            }
            if (!isLong && resolvedSL <= resolvedTP) {
                return { success: false, error: `SHORT: SL (${resolvedSL}) must be above TP (${resolvedTP})` };
            }
        }

        // ── Live mode: replace exchange orders ───────────────────────────────
        const isTestnet = this.client.isTestnet();
        if (!isTestnet && !positionData.softwareSLTP) {
            try {
                const symbolInfo = await this.client.getSymbolInfo(symbol);
                const positions  = await this.client.getPositions(symbol);
                const position   = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
                if (!position) return { success: false, error: 'Position no longer open on exchange' };

                const qty = Math.abs(parseFloat(position.positionAmt));

                // Cancel existing SL and TP orders
                const openOrders = await this.client.getOpenOrders(symbol);
                for (const order of openOrders) {
                    if (order.type === 'STOP_MARKET' || order.type === 'TAKE_PROFIT_MARKET') {
                        try {
                            await this.client.cancelOrder(symbol, order.orderId);
                            this.logger.info(`🗑️ Cancelled ${order.type} @ ${order.stopPrice} for ${symbol}`);
                        } catch (e) {
                            this.logger.warn(`Could not cancel order ${order.orderId}: ${e.message}`);
                        }
                    }
                }

                // Place new SL
                if (resolvedSL) {
                    const slPrice = this.executor.roundToTickSize(resolvedSL, symbolInfo.tickSize, symbolInfo.pricePrecision);
                    await this.client.placeOrder({
                        symbol,
                        side:        isLong ? 'SELL' : 'BUY',
                        type:        'STOP_MARKET',
                        quantity:    qty.toString(),
                        stopPrice:   slPrice.toString(),
                        reduceOnly:  'true',
                        workingType: 'MARK_PRICE'
                    });
                    this.logger.info(`✅ New SL placed at ${slPrice} for ${symbol}`);
                }

                // Place new TP
                if (resolvedTP) {
                    const tpPrice = this.executor.roundToTickSize(resolvedTP, symbolInfo.tickSize, symbolInfo.pricePrecision);
                    await this.client.placeOrder({
                        symbol,
                        side:        isLong ? 'SELL' : 'BUY',
                        type:        'TAKE_PROFIT_MARKET',
                        quantity:    qty.toString(),
                        stopPrice:   tpPrice.toString(),
                        reduceOnly:  'true',
                        workingType: 'MARK_PRICE'
                    });
                    this.logger.info(`✅ New TP placed at ${tpPrice} for ${symbol}`);
                }

            } catch (err) {
                this.logger.error(`❌ Failed to update exchange SL/TP for ${symbol}:`, err.message);
                return { success: false, error: err.message };
            }
        } else {
            this.logger.info(`🧪 ${isTestnet ? 'Testnet' : 'Software'}: SL/TP updated in-memory only for ${symbol}`);
        }

        // ── Update in-memory monitor data ────────────────────────────────────
        positionData.stopLoss    = resolvedSL;
        positionData.takeProfit1 = resolvedTP;
        positionData.tpHit       = false; // reset TP hit flag when TP is changed

        // Recompute CTC trigger price from new TP
        if (positionData.ctcEnabled && resolvedTP && positionData.entryPrice) {
            positionData.ctcTriggerPrice = isLong
                ? positionData.entryPrice + positionData.ctcTrigger * (resolvedTP - positionData.entryPrice)
                : positionData.entryPrice - positionData.ctcTrigger * (positionData.entryPrice - resolvedTP);
            positionData.ctcTriggered = false; // reset CTC if new TP set
            this.logger.info(`📐 CTC trigger recomputed: ${positionData.ctcTriggerPrice?.toFixed(4)}`);
        }

        this.monitoredPositions.set(symbol, positionData);
        this.logger.info(`✏️ SL/TP updated for ${symbol}: SL ${previousSL} → ${resolvedSL} | TP ${previousTP} → ${resolvedTP}`);

        // ── Append audit log to trade record (NEVER overwrite original) ───────
        try {
            const trades    = await this.storage.getAllTrades();
            const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
            if (openTrade) {
                const adjustment = {
                    timestamp:  Date.now(),
                    previousSL: previousSL ?? null,
                    previousTP: previousTP ?? null,
                    newSL:      resolvedSL,
                    newTP:      resolvedTP,
                    reason:     'manual-adjustment'
                };
                const existingAdjustments = openTrade.slTpAdjustments || [];
                await this.storage.updateTrade(openTrade.id, {
                    // currentSL / currentTP track the live levels; original stopLoss / takeProfit1 UNTOUCHED
                    currentSL:         resolvedSL,
                    currentTP:         resolvedTP,
                    slTpAdjustments:   [...existingAdjustments, adjustment]
                });
                this.logger.info(`📝 Adjustment logged to trade ${openTrade.id}`);
            }
        } catch (err) {
            this.logger.error(`Failed to log SL/TP adjustment for ${symbol}:`, err.message);
        }

        return {
            success:    true,
            symbol,
            previousSL,
            previousTP,
            newSL:      resolvedSL,
            newTP:      resolvedTP
        };
    }

    async setPositionHolding(symbol, enabled) {
        const positionData = this.monitoredPositions.get(symbol);
        if (!positionData) return false;

        const wasDisabled = !positionData.holdingEnabled;
        positionData.holdingEnabled = !!enabled;
        this.monitoredPositions.set(symbol, positionData);
        this.logger.info(`📌 ${symbol} holding: ${enabled ? 'ENABLED' : 'DISABLED'}`);

        // If re-enabled, immediately check if limit already reached
        if (enabled && wasDisabled && positionData.holdingCandles > 0) {
            const elapsed = Math.floor((Date.now() - positionData.tradeStartTime) / CANDLE_INTERVAL_MS);
            if (elapsed >= positionData.holdingCandles) {
                this.logger.info(
                    `⏰ ${symbol}: holding re-enabled — already at ${elapsed}/${positionData.holdingCandles} candles → closing now`
                );
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

                    if (!isTestnet) {
                        const symbolInfo = await this.client.getSymbolInfo(symbol);
                        await this.executor.setStopLossAndTakeProfits(
                            symbol, orderDetails.side, entryPrice, quantity,
                            { stopLoss: orderDetails.stopLoss, takeProfit1: orderDetails.takeProfit1 },
                            symbolInfo
                        );
                    } else {
                        this.logger.info(`🧪 Testnet: software SL/TP activated for filled limit order ${symbol}`);
                    }

                    this.addPosition(symbol, {
                        side:           orderDetails.side,
                        entryPrice,
                        orderType:      'LIMIT',
                        ctcEnabled:     orderDetails.ctcEnabled    || false,
                        ctcTrigger:     orderDetails.ctcTrigger    || 0.5,
                        holdingCandles: orderDetails.holdingCandles || 0,
                        tradeStartTime: orderDetails.entryTime || orderDetails.tradeStartTime || Date.now(),
                        softwareSLTP:   isTestnet,
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
            const positions = await this.client.getPositions(symbol);
            const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!position) {
                // Position closed externally
                this.logger.info(`📊 Position closed for ${symbol}`);
                await this._recordClose(symbol, positionData, positionData.lastKnownPnL || 0, 'automatic');
                this.monitoredPositions.delete(symbol);
                return;
            }

            // Track PnL
            const currentPnL = parseFloat(position.unRealizedProfit);
            positionData.lastKnownPnL = currentPnL;
            positionData.lastUpdated  = Date.now();
            this.monitoredPositions.set(symbol, positionData);

            // ── HOLDING CANDLE CHECK ──────────────────────────────────────────
            if (positionData.holdingEnabled && positionData.holdingCandles > 0) {
                const elapsed = Math.floor((Date.now() - positionData.tradeStartTime) / CANDLE_INTERVAL_MS);
                if (elapsed >= positionData.holdingCandles) {
                    this.logger.info(
                        `⏰ Holding limit reached for ${symbol}: ${elapsed}/${positionData.holdingCandles} candles — closing`
                    );
                    await this._closeForHolding(symbol, positionData);
                    return;
                }
            }

            // ── SOFTWARE SL/TP CHECK (testnet) ───────────────────────────────
            if (positionData.softwareSLTP) {
                const closed = await this._checkSoftwareSLTP(symbol, positionData, position);
                if (closed) return;
            }

            // ── CTC TRIGGER CHECK ─────────────────────────────────────────────
            // CTC fires BEFORE TP is hit → moves SL to break-even, trade continues
            if (positionData.ctcEnabled && !positionData.ctcTriggered && positionData.ctcTriggerPrice !== null) {
                const markPrice = parseFloat(position.markPrice);
                const isLong    = positionData.side === 'LONG';
                const triggered = isLong
                    ? markPrice >= positionData.ctcTriggerPrice
                    : markPrice <= positionData.ctcTriggerPrice;

                if (triggered) {
                    this.logger.info(
                        `🔄 CTC triggered for ${symbol} | mark: ${markPrice} | trigger: ${positionData.ctcTriggerPrice?.toFixed(4)}`
                    );

                    const feeBuffer = 0.0004;
                    const bePrice = isLong
                        ? positionData.entryPrice * (1 + feeBuffer)
                        : positionData.entryPrice * (1 - feeBuffer);

                    if (positionData.softwareSLTP) {
                        // Software mode: update in-memory SL to break-even
                        positionData.stopLoss     = bePrice;
                        positionData.ctcTriggered = true;
                        this.monitoredPositions.set(symbol, positionData);
                        this.logger.info(`✅ CTC (software): SL moved to break-even at ${bePrice.toFixed(2)}`);
                    } else {
                        // Live mode: place exchange SL order at break-even
                        const symbolInfo = await this.client.getSymbolInfo(symbol);
                        await this.executor.moveStopLossToBreakEven(
                            symbol, positionData.side, positionData.entryPrice, symbolInfo
                        );
                        positionData.ctcTriggered = true;
                        this.monitoredPositions.set(symbol, positionData);
                    }
                }
            }

        } catch (error) {
            this.logger.error(`Error checking position ${symbol}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Software SL/TP logic — single TP model
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Check mark price against software SL/TP levels.
     * Single TP model: 100% close on SL hit OR TP hit.
     * Returns true if the position was fully closed.
     */
    async _checkSoftwareSLTP(symbol, positionData, position) {
        const markPrice = parseFloat(position.markPrice);
        const isLong    = positionData.side === 'LONG';

        // ── Stop Loss — close 100% ────────────────────────────────────────────
        if (positionData.stopLoss) {
            const slHit = isLong
                ? markPrice <= positionData.stopLoss
                : markPrice >= positionData.stopLoss;

            if (slHit) {
                this.logger.info(
                    `🛑 SL hit for ${symbol}: mark=${markPrice} | SL=${positionData.stopLoss}`
                );
                await this._closeFullPosition(symbol, positionData, position, 'software-sl');
                return true;
            }
        }

        // ── Single TP — close 100% ────────────────────────────────────────────
        if (!positionData.tpHit && positionData.takeProfit1) {
            const tpHit = isLong
                ? markPrice >= positionData.takeProfit1
                : markPrice <= positionData.takeProfit1;

            if (tpHit) {
                this.logger.info(
                    `🎯 TP hit for ${symbol}: mark=${markPrice} | TP=${positionData.takeProfit1}`
                );
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
    // ─────────────────────────────────────────────────────────────────────────

    async _closeFullPosition(symbol, positionData, position, reason) {
        const pnl = position ? parseFloat(position.unRealizedProfit) : (positionData.lastKnownPnL || 0);
        await this.executor.closePosition(symbol, reason);
        await this._recordClose(symbol, positionData, pnl, reason);
        this.monitoredPositions.delete(symbol);
    }

    async _closeForHolding(symbol, positionData) {
        try {
            const positions = await this.client.getPositions(symbol);
            const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            const pnl = position
                ? parseFloat(position.unRealizedProfit)
                : (positionData.lastKnownPnL || 0);

            await this.executor.closePosition(symbol, 'holding-candles-limit');
            await this._recordClose(symbol, positionData, pnl, 'holding-candles-limit');
            this.monitoredPositions.delete(symbol);
        } catch (err) {
            this.logger.error(`Failed to close ${symbol} on holding limit:`, err.message);
        }
    }

    async _recordClose(symbol, positionData, pnl, reason) {
        try {
            const trades    = await this.storage.getAllTrades();
            const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
            if (openTrade) {
                const fees = Math.abs(pnl * 0.0004);
                await this.storage.updateTrade(openTrade.id, {
                    status:      'closed',
                    closedAt:    Date.now(),
                    closeReason: reason,
                    pnl,
                    fees,
                    netPnL:      pnl - fees
                });
                this.logger.info(`✅ Trade ${openTrade.id} closed (${reason}): PnL=$${pnl.toFixed(2)}`);
            }
        } catch (err) {
            this.logger.error(`Failed to update trade record for ${symbol}:`, err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Safety check (live mode only)
    // ─────────────────────────────────────────────────────────────────────────

    async safetyCheckUnprotectedPositions() {
        // On testnet, positions are protected by software SL/TP — skip exchange SL check
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
        const symbol = position.symbol;
        try {
            // If this position runs software SL/TP, skip exchange check
            const monData = this.monitoredPositions.get(symbol);
            if (monData && monData.softwareSLTP) {
                this.logger.debug(`🛡️ ${symbol}: software SL/TP active, skipping exchange SL check`);
                return;
            }

            const openOrders  = await this.client.getOpenOrders(symbol);
            const hasStopLoss = openOrders.some(o => o.type === 'STOP_MARKET');
            if (hasStopLoss) return;

            this.logger.warn(`⚠️ UNPROTECTED POSITION: ${symbol} has NO Stop Loss!`);

            const trades = await this.storage.getAllTrades();
            const trade  = trades.find(t => t.symbol === symbol && t.status === 'open');

            if (!trade || !trade.signal || !trade.signal.stopLoss) {
                this.logger.error(`🚨 EMERGENCY: ${symbol} — no SL in DB → closing for safety`);
                await this.executor.closePosition(symbol, 'emergency-no-sl-data');
                this.monitoredPositions.delete(symbol);
                return;
            }

            this.logger.info(`🔧 Setting missing SL for ${symbol} from DB: ${trade.signal.stopLoss}`);
            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const isLong     = parseFloat(position.positionAmt) > 0;
            const slPrice    = this.executor.roundToTickSize(
                trade.signal.stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision
            );
            const posQty = Math.abs(parseFloat(position.positionAmt));

            try {
                await this.client.placeOrder({
                    symbol,
                    side:        isLong ? 'SELL' : 'BUY',
                    type:        'STOP_MARKET',
                    quantity:    posQty.toString(),
                    stopPrice:   slPrice.toString(),
                    reduceOnly:  'true',
                    workingType: 'MARK_PRICE'
                });
                this.logger.info(`✅ Missing SL set for ${symbol} at ${slPrice}`);
            } catch (slError) {
                this.logger.error(`🚨 EMERGENCY: Failed to set SL for ${symbol} → closing for safety`);
                await this.executor.closePosition(symbol, 'emergency-sl-failed');
                this.monitoredPositions.delete(symbol);
            }

        } catch (error) {
            this.logger.error(`Error checking SL for ${symbol}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Status / getters
    // ─────────────────────────────────────────────────────────────────────────

    getStatus() {
        const positions = Array.from(this.monitoredPositions.entries()).map(([symbol, data]) => {
            const elapsed = data.tradeStartTime
                ? Math.floor((Date.now() - data.tradeStartTime) / CANDLE_INTERVAL_MS)
                : 0;
            return {
                symbol,
                side:            data.side,
                entryPrice:      data.entryPrice,
                orderType:       data.orderType,
                // CTC
                ctcEnabled:      data.ctcEnabled,
                ctcTrigger:      data.ctcTrigger,
                ctcTriggerPrice: data.ctcTriggerPrice,
                ctcTriggered:    data.ctcTriggered,
                // Holding
                holdingCandles:  data.holdingCandles,
                holdingEnabled:  data.holdingEnabled,
                tradeStartTime:  data.tradeStartTime,
                elapsedCandles:  elapsed,
                // Software SL/TP — single TP model
                softwareSLTP:    data.softwareSLTP,
                stopLoss:        data.stopLoss,
                takeProfit1:     data.takeProfit1,
                tpHit:           data.tpHit,
                // Live PnL
                lastKnownPnL:    data.lastKnownPnL,
                lastUpdated:     data.lastUpdated
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
