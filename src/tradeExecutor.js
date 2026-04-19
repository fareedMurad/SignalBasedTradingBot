/**
 * Trade Executor Module
 * Handles trade execution with market/limit orders, TP/SL management, CTC and R:R functionality
 */

class TradeExecutor {
    constructor(binanceClient, logger, config) {
        this.client = binanceClient;
        this.logger = logger;
        this.config = config;
    }

    /**
     * Calculate position size based on wallet percentage
     */
    calculatePositionSize(balance, walletPercentage, price, leverage, stepSize) {
        const margin = (balance * walletPercentage) / 100;
        const notionalValue = margin * leverage;
        const quantity = notionalValue / price;
        const roundedQuantity = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(roundedQuantity.toFixed(8));
    }

    /**
     * Calculate position size based on fixed dollar margin amount
     * Used when signal provider specifies margin in $
     */
    calculatePositionSizeFromDollar(marginDollar, price, leverage, stepSize) {
        const notionalValue = marginDollar * leverage;
        const quantity = notionalValue / price;
        const roundedQuantity = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(roundedQuantity.toFixed(8));
    }

    /**
     * Compute single TP from R:R ratio.
     * Signal provider provides rr (e.g. 2.5) → tp = entry ± slDist × rr
     *
     * @param {number} entryPrice
     * @param {number} stopLoss  - actual SL price (already resolved from pips or direct)
     * @param {number} rr        - risk:reward (e.g. 2.5 means 1:2.5)
     * @param {string} side      - 'LONG' or 'SHORT'
     * @returns {number} takeProfit1
     */
    computeTPFromRR(entryPrice, stopLoss, rr, side) {
        const slDist = Math.abs(entryPrice - stopLoss);
        const tpDist = slDist * rr;
        return side === 'LONG'
            ? entryPrice + tpDist
            : entryPrice - tpDist;
    }

    /**
     * Resolve stopLoss and takeProfit1 from signal.
     *
     * Signal can provide SL/TP in two ways:
     *   A) Absolute prices:  signal.stopLoss + signal.rr  (or signal.takeProfit1)
     *   B) Pips distance:    signal.slPips  + signal.rr  (or signal.tpPips)
     *      → stopLoss = entry ∓ slPips   (BUY: entry − slPips, SELL: entry + slPips)
     *      → tp       = entry ± slPips × rr  (BUY: entry + slPips×rr, SELL: entry − slPips×rr)
     *         OR:        entry ± tpPips   when signal provides tpPips directly
     *
     * @param {number} entryPrice - actual fill price (for pips mode) or pre-fill estimate
     * @param {string} side       - 'LONG' | 'SHORT'
     * @param {object} signal     - raw signal payload
     * @returns {{ stopLoss: number, takeProfit1: number, slPipsUsed: boolean }}
     */
    resolveSLTP(entryPrice, side, signal) {
        const isLong = side === 'LONG';

        // ── MODE A: absolute price SL provided ───────────────────────────────
        if (signal.stopLoss) {
            const stopLoss = signal.stopLoss;
            let takeProfit1;

            if (signal.takeProfit1) {
                takeProfit1 = signal.takeProfit1;
            } else if (signal.tpPips) {
                takeProfit1 = isLong
                    ? entryPrice + signal.tpPips
                    : entryPrice - signal.tpPips;
            } else {
                takeProfit1 = this.computeTPFromRR(entryPrice, stopLoss, signal.rr, side);
            }

            return { stopLoss, takeProfit1, slPipsUsed: false };
        }

        // ── MODE B: pips distance ─────────────────────────────────────────────
        if (signal.slPips) {
            const stopLoss = isLong
                ? entryPrice - signal.slPips
                : entryPrice + signal.slPips;

            let takeProfit1;
            if (signal.tpPips) {
                takeProfit1 = isLong
                    ? entryPrice + signal.tpPips
                    : entryPrice - signal.tpPips;
            } else {
                // rr must be present if no tpPips (validated in server.js)
                takeProfit1 = isLong
                    ? entryPrice + signal.slPips * signal.rr
                    : entryPrice - signal.slPips * signal.rr;
            }

            return { stopLoss, takeProfit1, slPipsUsed: true };
        }

        throw new Error('Signal must provide either stopLoss or slPips');
    }

    /**
     * Execute a trade based on signal
     *
     * Signal fields (from provider):
     *   symbol         - trading pair (e.g. BTCUSDT)
     *   direction      - 'BUY' | 'SELL'  (alternative to side)
     *   side           - 'LONG' | 'SHORT' (alternative to direction)
     *   orderType      - 'MARKET' | 'LIMIT'
     *   limitPrice     - required for LIMIT orders
     *   leverage       - 1-125
     *   riskMode       - 'isolated' | 'crossed'
     *   stopLoss       - stop loss price
     *   rr             - risk:reward ratio  → TPs computed automatically
     *   takeProfit1/2/3 - manual TPs (overrides rr if provided)
     *   marginMode     - 'percent' | 'dollar'  (default: 'percent')
     *   walletPercentage - % of wallet (when marginMode=percent)
     *   marginDollar   - fixed $ per trade (when marginMode=dollar)
     *   ctcEnabled     - boolean, enable CTC (close-to-cost)
     *   ctcTrigger     - fraction of TP dist to trigger CTC (0.4 = 40%)
     *   holdingCandles - number of 3-min candles before force-close (0 = disabled)
     *   entryTime      - unix ms timestamp of signal entry (for holding count)
     */
    async executeTrade(signal) {
        // --- Resolve direction → side ---
        let side = signal.side;
        if (!side && signal.direction) {
            side = signal.direction === 'BUY' ? 'LONG' : 'SHORT';
        }
        if (!side) side = 'LONG'; // final fallback

        const {
            symbol,
            orderType = 'MARKET',
            limitPrice,
            leverage,
            riskMode,
            stopLoss,
            ctcEnabled = false,
            ctcTrigger = 0.5,
            holdingCandles = 0,
            entryTime
        } = signal;

        try {
            this.logger.info(`🎯 Executing ${orderType} ${side} trade for ${symbol} (${leverage}x ${riskMode})`);

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const currentPrice = await this.client.getPrice(symbol);

            // Entry price estimate (pre-fill) for pre-validation
            const estimatedEntry = orderType === 'MARKET' ? currentPrice : (limitPrice || currentPrice);

            // --- Resolve SL/TP using estimated entry (pre-fill) for pre-validation ---
            const { stopLoss: estSL, takeProfit1: estTP } = this.resolveSLTP(estimatedEntry, side, signal);

            const mode = signal.slPips
                ? `pips (slPips=${signal.slPips}${signal.tpPips ? `, tpPips=${signal.tpPips}` : `, rr=${signal.rr}`})`
                : `absolute price (SL=${signal.stopLoss}, rr=${signal.rr})`;
            this.logger.info(`📐 SL/TP mode: ${mode}`);
            this.logger.info(`📐 Estimated → SL=${estSL.toFixed(4)} | TP=${estTP.toFixed(4)}`);

            // Validate direction (pre-fill estimate)
            const validation = this.validateSLTP(side, estimatedEntry, estSL, estTP);
            if (!validation.valid) {
                throw new Error(`❌ Validation Failed: ${validation.error}`);
            }

            // Use estimated SL/TP for pre-validation (actual fill resolves below)
            let stopLoss = estSL;
            let takeProfit1 = estTP;

            // Set leverage and margin type
            await this.client.setMarginType(symbol, riskMode);
            await this.client.setLeverage(symbol, leverage);

            const balance = await this.client.getBalance();
            this.logger.info(`💰 Available balance: $${balance.available.toFixed(2)}`);

            // --- Position sizing ---
            const priceForSize = orderType === 'MARKET' ? currentPrice : limitPrice;
            let quantity;

            if (signal.marginMode === 'dollar' && signal.marginDollar > 0) {
                quantity = this.calculatePositionSizeFromDollar(
                    signal.marginDollar,
                    priceForSize,
                    leverage,
                    symbolInfo.stepSize
                );
                this.logger.info(`💵 Dollar margin: $${signal.marginDollar} → qty ${quantity}`);
            } else {
                const walletPct = signal.walletPercentage || 10;
                quantity = this.calculatePositionSize(
                    balance.available,
                    walletPct,
                    priceForSize,
                    leverage,
                    symbolInfo.stepSize
                );
                this.logger.info(`📊 Percent margin: ${walletPct}% → qty ${quantity}`);
            }

            if (quantity < symbolInfo.minQuantity) {
                throw new Error(`Quantity ${quantity} below minimum ${symbolInfo.minQuantity}`);
            }

            // Pre-validate SL/TP orders won't immediately trigger
            this.logger.info('🔍 Pre-validating SL/TP orders...');
            const testValidation = await this.testSLTPOrders(symbol, side, estimatedEntry, quantity, {
                stopLoss, takeProfit1
            }, symbolInfo);
            if (!testValidation.valid) {
                throw new Error(`❌ Pre-validation failed: ${testValidation.error}`);
            }
            this.logger.info('✅ Pre-validation passed');

            const tpSlConfig = { stopLoss, takeProfit1, ctcEnabled, ctcTrigger, entryPrice: estimatedEntry };
            let entryOrder;
            let softwareSLTP = false;

            if (orderType === 'MARKET') {
                entryOrder = await this.client.placeOrder({
                    symbol,
                    side: side === 'LONG' ? 'BUY' : 'SELL',
                    type: 'MARKET',
                    quantity: quantity.toString()
                });
                this.logger.info(`✅ Market order executed: ${entryOrder.orderId}`);

                await new Promise(resolve => setTimeout(resolve, 500));
                const fillPrice = await this.getActualEntryPrice(symbol, currentPrice);

                // ── Re-resolve SL/TP from ACTUAL fill price (critical for pips mode) ──
                if (signal.slPips) {
                    const resolved = this.resolveSLTP(fillPrice, side, signal);
                    stopLoss    = resolved.stopLoss;
                    takeProfit1 = resolved.takeProfit1;
                    this.logger.info(`📐 Pips resolved from fill ${fillPrice.toFixed(4)} → SL=${stopLoss.toFixed(4)} | TP=${takeProfit1.toFixed(4)}`);
                } else {
                    // Absolute SL stays the same; recompute TP from fill price for accuracy
                    takeProfit1 = this.resolveSLTP(fillPrice, side, signal).takeProfit1;
                    this.logger.info(`📐 TP recomputed from fill ${fillPrice.toFixed(4)} → TP=${takeProfit1.toFixed(4)} | SL=${stopLoss.toFixed(4)}`);
                }

                if (this.client.isTestnet()) {
                    // Testnet blocks STOP_MARKET / TAKE_PROFIT_MARKET (-4120)
                    // Position is protected by software SL/TP in the position monitor
                    this.logger.info('🧪 Testnet: skipping exchange SL/TP orders — software SL/TP active');
                    softwareSLTP = true;
                } else {
                    const slTpSuccess = await this.setStopLossAndTakeProfitsWithRetry(
                        symbol, side, fillPrice, quantity, tpSlConfig, symbolInfo
                    );

                    if (!slTpSuccess) {
                        this.logger.error('🚨 CRITICAL: Failed to set SL/TP after retries - CLOSING POSITION!');
                        await this.closePosition(symbol, 'safety-no-sl');
                        throw new Error('Failed to protect position with SL/TP - Position closed for safety');
                    }
                }

            } else {
                // LIMIT order
                const roundedPrice = this.roundToTickSize(limitPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);
                entryOrder = await this.client.placeOrder({
                    symbol,
                    side: side === 'LONG' ? 'BUY' : 'SELL',
                    type: 'LIMIT',
                    quantity: quantity.toString(),
                    price: roundedPrice.toString(),
                    timeInForce: 'GTC'
                });
                this.logger.info(`✅ Limit order placed at ${roundedPrice}: ${entryOrder.orderId}`);
                if (this.client.isTestnet()) {
                    softwareSLTP = true;
                    this.logger.info('🧪 Testnet: limit order — software SL/TP will activate on fill');
                }
            }

            // Trade start time: use signal entryTime if provided, else now
            const tradeStartTime = entryTime || Date.now();

            return {
                success: true,
                orderId: entryOrder.orderId,
                symbol,
                side,
                orderType,
                quantity,
                price:          orderType === 'MARKET' ? currentPrice : limitPrice,
                stopLoss,
                takeProfit1,
                rr:             signal.rr    || null,
                slPips:         signal.slPips || null,
                tpPips:         signal.tpPips || null,
                ctcEnabled:     !!ctcEnabled,
                ctcTrigger,
                holdingCandles,
                tradeStartTime,
                softwareSLTP
            };

        } catch (error) {
            this.logger.error(`❌ Trade execution failed for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Get actual entry price from position
     */
    async getActualEntryPrice(symbol, fallbackPrice) {
        try {
            const positions = await this.client.getPositions(symbol);
            const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            if (position && parseFloat(position.entryPrice) > 0) {
                this.logger.info(`✅ Actual entry price: ${position.entryPrice}`);
                return parseFloat(position.entryPrice);
            }
        } catch (error) {
            this.logger.warn('Could not fetch actual entry price, using fallback');
        }
        return fallbackPrice;
    }

    /**
     * Set stop loss and single take profit orders (100% position close at TP)
     */
    async setStopLossAndTakeProfits(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo) {
        const { stopLoss, takeProfit1 } = tpSlConfig;
        const isLong = side === 'LONG';

        try {
            // Stop Loss
            const slPrice = this.roundToTickSize(stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision);
            await this.client.placeOrder({
                symbol,
                side:        isLong ? 'SELL' : 'BUY',
                type:        'STOP_MARKET',
                quantity:    quantity.toString(),
                stopPrice:   slPrice.toString(),
                reduceOnly:  'true',
                workingType: 'MARK_PRICE'
            });
            this.logger.info(`✅ Stop Loss set at ${slPrice} (qty: ${quantity})`);

            // Single TP — 100% of position
            const tp1Price = this.roundToTickSize(takeProfit1, symbolInfo.tickSize, symbolInfo.pricePrecision);
            await this.client.placeOrder({
                symbol,
                side:        isLong ? 'SELL' : 'BUY',
                type:        'TAKE_PROFIT_MARKET',
                quantity:    quantity.toString(),
                stopPrice:   tp1Price.toString(),
                reduceOnly:  'true',
                workingType: 'MARK_PRICE'
            });
            this.logger.info(`✅ TP set at ${tp1Price} (100% - ${quantity})`);

            return { success: true };

        } catch (error) {
            this.logger.error(`❌ Failed to set SL/TP for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Move stop loss to break-even (CTC - Close to Cost)
     */
    async moveStopLossToBreakEven(symbol, side, entryPrice, symbolInfo) {
        try {
            const isLong = side === 'LONG';
            const feeBuffer = 0.0004; // ~0.04% to cover fees
            const breakEvenPrice = isLong
                ? entryPrice * (1 + feeBuffer)
                : entryPrice * (1 - feeBuffer);

            const slPrice = this.roundToTickSize(breakEvenPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

            // Cancel existing SL orders
            const openOrders = await this.client.getOpenOrders(symbol);
            const existingSL = openOrders.find(o => o.type === 'STOP_MARKET');
            if (existingSL) {
                await this.client.cancelOrder(symbol, existingSL.orderId);
                this.logger.info(`🗑️ Cancelled old SL at ${existingSL.stopPrice}`);
            }

            // Get current position quantity (needed for reduceOnly order)
            const positions = await this.client.getPositions(symbol);
            const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            if (!position) {
                this.logger.warn(`⚠️ No open position for ${symbol} when moving SL to break-even`);
                return { success: false, reason: 'no-position' };
            }
            const posQty = Math.abs(parseFloat(position.positionAmt));

            // Place new SL using reduceOnly (NOT closePosition — routes to Algo API on newer testnet)
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'STOP_MARKET',
                quantity: posQty.toString(),
                stopPrice: slPrice.toString(),
                reduceOnly: 'true',
                workingType: 'MARK_PRICE'
            });

            this.logger.info(`✅ CTC: Stop Loss moved to break-even at ${slPrice} (qty: ${posQty})`);
            return { success: true };

        } catch (error) {
            this.logger.error(`❌ Failed to move SL to break-even for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Close position manually
     */
    async closePosition(symbol, reason = 'manual') {
        try {
            const positions = await this.client.getPositions(symbol);
            const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!position) {
                this.logger.warn(`No position found for ${symbol}`);
                return null;
            }

            const quantity = Math.abs(parseFloat(position.positionAmt));
            const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

            await this.client.cancelAllOrders(symbol);
            const order = await this.client.placeOrder({
                symbol,
                side,
                type: 'MARKET',
                quantity: quantity.toString(),
                reduceOnly: 'true'
            });

            this.logger.info(`✅ Position closed for ${symbol} (${reason}): ${order.orderId}`);
            return order;

        } catch (error) {
            this.logger.error(`❌ Failed to close position for ${symbol}:`, error.message);
            throw error;
        }
    }

    roundToTickSize(price, tickSize, precision) {
        const rounded = Math.round(price / tickSize) * tickSize;
        return parseFloat(rounded.toFixed(precision));
    }

    roundToStepSize(quantity, stepSize, precision) {
        const rounded = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(rounded.toFixed(precision));
    }

    async testSLTPOrders(symbol, side, entryPrice, quantity, prices, symbolInfo) {
        const { stopLoss, takeProfit1 } = prices;
        const isLong = side === 'LONG';

        try {
            const slPrice  = this.roundToTickSize(stopLoss,     symbolInfo.tickSize, symbolInfo.pricePrecision);
            const tp1Price = this.roundToTickSize(takeProfit1,   symbolInfo.tickSize, symbolInfo.pricePrecision);
            const currentPrice = await this.client.getPrice(symbol);

            if (isLong) {
                if (slPrice  >= currentPrice) return { valid: false, error: 'SL would trigger immediately (SL >= current price)' };
                if (tp1Price <= currentPrice) return { valid: false, error: 'TP would trigger immediately (TP <= current price)' };
            } else {
                if (slPrice  <= currentPrice) return { valid: false, error: 'SL would trigger immediately (SL <= current price)' };
                if (tp1Price >= currentPrice) return { valid: false, error: 'TP would trigger immediately (TP >= current price)' };
            }

            return { valid: true };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    async setStopLossAndTakeProfitsWithRetry(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`🔄 Attempt ${attempt}/${maxRetries} to set SL/TP for ${symbol}`);
                await this.setStopLossAndTakeProfits(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo);
                return true;
            } catch (error) {
                this.logger.error(`❌ Attempt ${attempt} failed: ${error.message}`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    this.logger.error(`🚨 All ${maxRetries} attempts failed to set SL/TP`);
                    return false;
                }
            }
        }
        return false;
    }

    validateSLTP(side, entryPrice, sl, tp1) {
        const isLong = side === 'LONG';
        const errors = [];

        if (isLong) {
            if (sl  >= entryPrice) errors.push(`LONG SL (${sl}) must be BELOW entry (${entryPrice})`);
            if (tp1 <= entryPrice) errors.push(`LONG TP (${tp1}) must be ABOVE entry (${entryPrice})`);
        } else {
            if (sl  <= entryPrice) errors.push(`SHORT SL (${sl}) must be ABOVE entry (${entryPrice})`);
            if (tp1 >= entryPrice) errors.push(`SHORT TP (${tp1}) must be BELOW entry (${entryPrice})`);
        }

        if (errors.length > 0) return { valid: false, error: errors.join(' | ') };
        return { valid: true };
    }
}

module.exports = TradeExecutor;
