/**
 * Trade Executor Module
 * Handles trade execution with market/limit orders, TP/SL management, and CTC functionality
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

        // Round to step size
        const roundedQuantity = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(roundedQuantity.toFixed(8));
    }

    /**
     * Execute a trade based on signal
     * @param {Object} signal - Trade signal with all parameters
     */
    async executeTrade(signal) {
        const {
            symbol,
            side, // 'LONG' or 'SHORT'
            orderType, // 'MARKET' or 'LIMIT'
            limitPrice, // Only for limit orders
            walletPercentage,
            leverage, // Leverage from admin
            riskMode, // Risk mode from admin
            stopLoss,
            takeProfit1,
            takeProfit2,
            takeProfit3,
            ctcLevel // 'TP1', 'TP2', or 'NONE'
        } = signal;

        try {
            this.logger.info(`🎯 Executing ${orderType} ${side} trade for ${symbol} (${leverage}x ${riskMode})`);

            // Get symbol info
            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const currentPrice = await this.client.getPrice(symbol);

            // Validate SL/TP prices BEFORE executing trade
            const entryPrice = orderType === 'MARKET' ? currentPrice : limitPrice;
            const validation = this.validateSLTP(side, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3);
            if (!validation.valid) {
                throw new Error(`❌ Validation Failed: ${validation.error}`);
            }

            // Set leverage and margin type from signal
            await this.client.setMarginType(symbol, riskMode);
            await this.client.setLeverage(symbol, leverage);

            // Get balance
            const balance = await this.client.getBalance();
            this.logger.info(`💰 Available balance: $${balance.available.toFixed(2)}`);

            // Calculate position size
            const quantity = this.calculatePositionSize(
                balance.available,
                walletPercentage,
                orderType === 'MARKET' ? currentPrice : limitPrice,
                leverage,
                symbolInfo.stepSize
            );

            if (quantity < symbolInfo.minQuantity) {
                throw new Error(`Quantity ${quantity} below minimum ${symbolInfo.minQuantity}`);
            }

            this.logger.info(`📊 Position size: ${quantity} ${symbol.replace('USDT', '')} @ ${orderType === 'MARKET' ? currentPrice : limitPrice}`);

            // OPTION 2: Pre-validate SL/TP prices before executing
            this.logger.info('🔍 Pre-validating SL/TP orders...');
            const testValidation = await this.testSLTPOrders(symbol, side, entryPrice, quantity, {
                stopLoss, takeProfit1, takeProfit2, takeProfit3
            }, symbolInfo);
            
            if (!testValidation.valid) {
                throw new Error(`❌ Pre-validation failed: ${testValidation.error}`);
            }
            this.logger.info('✅ Pre-validation passed');

            // Place entry order
            let entryOrder;
            if (orderType === 'MARKET') {
                entryOrder = await this.client.placeOrder({
                    symbol,
                    side: side === 'LONG' ? 'BUY' : 'SELL',
                    type: 'MARKET',
                    quantity: quantity.toString()
                });

                this.logger.info(`✅ Market order executed: ${entryOrder.orderId}`);

                // Wait for fill and set SL/TP with retry
                await new Promise(resolve => setTimeout(resolve, 500));
                const fillPrice = await this.getActualEntryPrice(symbol, currentPrice);
                
                // Try to set SL/TP with retry mechanism
                const slTpSuccess = await this.setStopLossAndTakeProfitsWithRetry(symbol, side, fillPrice, quantity, {
                    stopLoss,
                    takeProfit1,
                    takeProfit2,
                    takeProfit3,
                    ctcLevel
                }, symbolInfo);
                
                if (!slTpSuccess) {
                    // If SL/TP failed after retries, close the position immediately
                    this.logger.error('🚨 CRITICAL: Failed to set SL/TP after retries - CLOSING POSITION!');
                    await this.closePosition(symbol, 'safety-no-sl');
                    throw new Error('Failed to protect position with SL/TP - Position closed for safety');
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
                this.logger.info(`⏳ Waiting for fill... SL/TP will be set automatically after fill`);

                // Store order info for monitoring (will be handled by position monitor)
            }

            return {
                success: true,
                orderId: entryOrder.orderId,
                symbol,
                side,
                orderType,
                quantity,
                price: orderType === 'MARKET' ? currentPrice : limitPrice
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
     * Set stop loss and take profit orders with CTC functionality
     */
    async setStopLossAndTakeProfits(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo) {
        const { stopLoss, takeProfit1, takeProfit2, takeProfit3, ctcLevel } = tpSlConfig;
        const isLong = side === 'LONG';

        try {
            // Calculate SL price
            const slPrice = this.roundToTickSize(stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision);

            // Place Stop Loss (closes entire position)
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'STOP_MARKET',
                closePosition: 'true',
                stopPrice: slPrice.toString(),
                workingType: 'MARK_PRICE'
            });

            this.logger.info(`✅ Stop Loss set at ${slPrice}`);

            // Calculate TP quantities (distribute across 3 TPs)
            const tp1Qty = this.roundToStepSize(quantity * 0.33, symbolInfo.stepSize, symbolInfo.quantityPrecision);
            const tp2Qty = this.roundToStepSize(quantity * 0.33, symbolInfo.stepSize, symbolInfo.quantityPrecision);
            const tp3Qty = this.roundToStepSize(quantity - tp1Qty - tp2Qty, symbolInfo.stepSize, symbolInfo.quantityPrecision);

            // Place TP1
            const tp1Price = this.roundToTickSize(takeProfit1, symbolInfo.tickSize, symbolInfo.pricePrecision);
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'TAKE_PROFIT_MARKET',
                quantity: tp1Qty.toString(),
                stopPrice: tp1Price.toString(),
                reduceOnly: 'true',
                workingType: 'MARK_PRICE'
            });
            this.logger.info(`✅ TP1 set at ${tp1Price} (33% - ${tp1Qty})`);

            // Place TP2
            const tp2Price = this.roundToTickSize(takeProfit2, symbolInfo.tickSize, symbolInfo.pricePrecision);
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'TAKE_PROFIT_MARKET',
                quantity: tp2Qty.toString(),
                stopPrice: tp2Price.toString(),
                reduceOnly: 'true',
                workingType: 'MARK_PRICE'
            });
            this.logger.info(`✅ TP2 set at ${tp2Price} (33% - ${tp2Qty})`);

            // Place TP3
            const tp3Price = this.roundToTickSize(takeProfit3, symbolInfo.tickSize, symbolInfo.pricePrecision);
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'TAKE_PROFIT_MARKET',
                quantity: tp3Qty.toString(),
                stopPrice: tp3Price.toString(),
                reduceOnly: 'true',
                workingType: 'MARK_PRICE'
            });
            this.logger.info(`✅ TP3 set at ${tp3Price} (34% - ${tp3Qty})`);

            // Store CTC level for monitoring
            if (ctcLevel !== 'NONE') {
                this.logger.info(`🔄 CTC enabled: Will move SL to break-even after ${ctcLevel} hit`);
            }

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

            // Calculate break-even price (entry + minimal buffer for fees)
            const feeBuffer = 0.0004; // ~0.04% to cover trading fees (maker/taker)
            const breakEvenPrice = isLong
                ? entryPrice * (1 + feeBuffer)
                : entryPrice * (1 - feeBuffer);

            const slPrice = this.roundToTickSize(breakEvenPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

            // Cancel existing SL
            const openOrders = await this.client.getOpenOrders(symbol);
            const existingSL = openOrders.find(o => o.type === 'STOP_MARKET');

            if (existingSL) {
                await this.client.cancelOrder(symbol, existingSL.orderId);
                this.logger.info(`🗑️ Cancelled old SL at ${existingSL.stopPrice}`);
            }

            // Place new SL at break-even
            await this.client.placeOrder({
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'STOP_MARKET',
                closePosition: 'true',
                stopPrice: slPrice.toString(),
                workingType: 'MARK_PRICE'
            });

            this.logger.info(`✅ CTC: Stop Loss moved to break-even at ${slPrice}`);
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

            // Cancel all orders first
            await this.client.cancelAllOrders(symbol);

            // Close position
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

    /**
     * Round price to tick size
     */
    roundToTickSize(price, tickSize, precision) {
        const rounded = Math.round(price / tickSize) * tickSize;
        return parseFloat(rounded.toFixed(precision));
    }

    /**
     * Round quantity to step size
     */
    roundToStepSize(quantity, stepSize, precision) {
        const rounded = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(rounded.toFixed(precision));
    }

    /**
     * Test if SL/TP orders can be placed (pre-validation)
     */
    async testSLTPOrders(symbol, side, entryPrice, quantity, prices, symbolInfo) {
        const { stopLoss, takeProfit1, takeProfit2, takeProfit3 } = prices;
        const isLong = side === 'LONG';

        try {
            // Test SL price calculation
            const slPrice = this.roundToTickSize(stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision);
            
            // Test TP price calculations
            const tp1Price = this.roundToTickSize(takeProfit1, symbolInfo.tickSize, symbolInfo.pricePrecision);
            const tp2Price = this.roundToTickSize(takeProfit2, symbolInfo.tickSize, symbolInfo.pricePrecision);
            const tp3Price = this.roundToTickSize(takeProfit3, symbolInfo.tickSize, symbolInfo.pricePrecision);

            // Verify prices won't immediately trigger
            const currentPrice = await this.client.getPrice(symbol);
            
            if (isLong) {
                if (slPrice >= currentPrice) {
                    return { valid: false, error: 'Stop Loss would trigger immediately (price too high)' };
                }
                if (tp1Price <= currentPrice || tp2Price <= currentPrice || tp3Price <= currentPrice) {
                    return { valid: false, error: 'Take Profit would trigger immediately (price too low)' };
                }
            } else {
                if (slPrice <= currentPrice) {
                    return { valid: false, error: 'Stop Loss would trigger immediately (price too low)' };
                }
                if (tp1Price >= currentPrice || tp2Price >= currentPrice || tp3Price >= currentPrice) {
                    return { valid: false, error: 'Take Profit would trigger immediately (price too high)' };
                }
            }

            return { valid: true };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    /**
     * Set SL/TP with retry mechanism (3 attempts)
     */
    async setStopLossAndTakeProfitsWithRetry(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo, maxRetries = 3) {
        for (let attempt = 1; attempt <=maxRetries; attempt++) {
            try {
                this.logger.info(`🔄 Attempt ${attempt}/${maxRetries} to set SL/TP for ${symbol}`);
                await this.setStopLossAndTakeProfits(symbol, side, entryPrice, quantity, tpSlConfig, symbolInfo);
                return true; // Success!
            } catch (error) {
                this.logger.error(`❌ Attempt ${attempt} failed: ${error.message}`);
                
                if (attempt < maxRetries) {
                    // Wait 1 second before retry
                    this.logger.info(`⏳ Waiting 1s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    this.logger.error(`🚨 All ${maxRetries} attempts failed to set SL/TP`);
                    return false; // All retries failed
                }
            }
        }
        return false;
    }

    /**
     * Validate SL/TP prices are in correct direction
     */
    validateSLTP(side, entryPrice, sl, tp1, tp2, tp3) {
        const isLong = side === 'LONG';
        const errors = [];

        // Validate Stop Loss
        if (isLong) {
            if (sl >= entryPrice) {
                errors.push(`LONG Stop Loss (${sl}) must be BELOW entry price (${entryPrice})`);
            }
        } else {
            if (sl <= entryPrice) {
                errors.push(`SHORT Stop Loss (${sl}) must be ABOVE entry price (${entryPrice})`);
            }
        }

        // Validate Take Profits
        if (isLong) {
            if (tp1 <= entryPrice) {
                errors.push(`LONG TP1 (${tp1}) must be ABOVE entry price (${entryPrice})`);
            }
            if (tp2 <= entryPrice) {
                errors.push(`LONG TP2 (${tp2}) must be ABOVE entry price (${entryPrice})`);
            }
            if (tp3 <= entryPrice) {
                errors.push(`LONG TP3 (${tp3}) must be ABOVE entry price (${entryPrice})`);
            }
            
            // Check order: TP1 < TP2 < TP3
            if (tp1 >= tp2 || tp2 >= tp3) {
                errors.push(`LONG TPs must be in order: TP1 (${tp1}) < TP2 (${tp2}) < TP3 (${tp3})`);
            }
        } else {
            if (tp1 >= entryPrice) {
                errors.push(`SHORT TP1 (${tp1}) must be BELOW entry price (${entryPrice})`);
            }
            if (tp2 >= entryPrice) {
                errors.push(`SHORT TP2 (${tp2}) must be BELOW entry price (${entryPrice})`);
            }
            if (tp3 >= entryPrice) {
                errors.push(`SHORT TP3 (${tp3}) must be BELOW entry price (${entryPrice})`);
            }
            
            // Check order: TP1 > TP2 > TP3
            if (tp1 <= tp2 || tp2 <= tp3) {
                errors.push(`SHORT TPs must be in order: TP1 (${tp1}) > TP2 (${tp2}) > TP3 (${tp3})`);
            }
        }

        if (errors.length > 0) {
            return {
                valid: false,
                error: errors.join(' | ')
            };
        }

        return { valid: true };
    }
}

module.exports = TradeExecutor;
