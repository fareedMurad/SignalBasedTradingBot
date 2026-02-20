/**
 * Position Monitor Module
 * Monitors positions and handles CTC (Close to Cost) functionality
 */

class PositionMonitor {
    constructor(binanceClient, tradeExecutor, logger, storageManager) {
        this.client = binanceClient;
        this.executor = tradeExecutor;
        this.logger = logger;
        this.storage = storageManager;
        this.monitoredPositions = new Map(); // symbol -> { side, entryPrice, ctcLevel, ctcTriggered }
        this.pendingLimitOrders = new Map(); // symbol -> order details
    }

    /**
     * Start monitoring positions
     */
    async start() {
        this.logger.info('🔍 Position monitor started');

        // Monitor every 5 seconds
        this.monitorInterval = setInterval(async () => {
            await this.checkPositions();
        }, 5000);

        // Check for filled limit orders every 10 seconds
        this.limitOrderInterval = setInterval(async () => {
            await this.checkLimitOrders();
        }, 10000);

        // OPTION 3: Safety monitor - check for unprotected positions every 30 seconds
        this.safetyMonitorInterval = setInterval(async () => {
            await this.safetyCheckUnprotectedPositions();
        }, 30000);
        
        this.logger.info('🛡️ Safety monitor enabled - checking for unprotected positions every 30s');
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        if (this.limitOrderInterval) {
            clearInterval(this.limitOrderInterval);
        }
        if (this.safetyMonitorInterval) {
            clearInterval(this.safetyMonitorInterval);
        }
        this.logger.info('🛑 Position monitor stopped');
    }

    /**
     * Add position to monitor
     */
    addPosition(symbol, side, entryPrice, ctcLevel, orderType = 'MARKET') {
        this.monitoredPositions.set(symbol, {
            side,
            entryPrice,
            ctcLevel,
            ctcTriggered: false,
            orderType,
            lastKnownPnL: 0, // Track PnL before position closes
            lastUpdated: Date.now()
        });
        this.logger.info(`📌 Monitoring ${symbol} ${side} position (CTC: ${ctcLevel})`);
    }

    /**
     * Add pending limit order to monitor
     */
    addPendingLimitOrder(symbol, orderDetails) {
        this.pendingLimitOrders.set(symbol, orderDetails);
        this.logger.info(`📌 Monitoring limit order for ${symbol}`);
    }

    /**
     * Check limit orders for fills
     */
    async checkLimitOrders() {
        if (this.pendingLimitOrders.size === 0) return;

        try {
            for (const [symbol, orderDetails] of this.pendingLimitOrders.entries()) {
                const positions = await this.client.getPositions(symbol);
                const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

                if (position) {
                    // Limit order filled!
                    this.logger.info(`✅ Limit order filled for ${symbol} at ${position.entryPrice}`);

                    // Set SL/TP now
                    const symbolInfo = await this.client.getSymbolInfo(symbol);
                    const entryPrice = parseFloat(position.entryPrice);
                    const quantity = Math.abs(parseFloat(position.positionAmt));

                    await this.executor.setStopLossAndTakeProfits(
                        symbol,
                        orderDetails.side,
                        entryPrice,
                        quantity,
                        {
                            stopLoss: orderDetails.stopLoss,
                            takeProfit1: orderDetails.takeProfit1,
                            takeProfit2: orderDetails.takeProfit2,
                            takeProfit3: orderDetails.takeProfit3,
                            ctcLevel: orderDetails.ctcLevel
                        },
                        symbolInfo
                    );

                    // Add to monitored positions
                    this.addPosition(symbol, orderDetails.side, entryPrice, orderDetails.ctcLevel, 'LIMIT');

                    // Remove from pending
                    this.pendingLimitOrders.delete(symbol);
                }
            }
        } catch (error) {
            this.logger.error('Error checking limit orders:', error.message);
        }
    }

    /**
     * Check all monitored positions
     */
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

    /**
     * Check individual position for CTC trigger
     */
    async checkPosition(symbol, positionData) {
        try {
            // Get current position first (check if still exists)
            const positions = await this.client.getPositions(symbol);
            const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!position) {
                // Position closed - update trade status WITH LAST KNOWN PnL
                this.logger.info(`📊 Position closed for ${symbol}`);
                
                // Use last known PnL (tracked before close)
                const pnl = positionData.lastKnownPnL || 0;
                const fees = Math.abs(pnl * 0.0004);
                
                // Update trade status in storage
                try {
                    const trades = await this.storage.getAllTrades();
                    const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
                    
                    if (openTrade) {
                        await this.storage.updateTrade(openTrade.id, {
                            status: 'closed',
                            closedAt: Date.now(),
                            closeReason: 'automatic', // TP or SL hit
                            pnl,
                            fees,
                            netPnL: pnl - fees
                        });
                        this.logger.info(`✅ Updated trade ${openTrade.id}: PnL=$${pnl.toFixed(2)}, Fees=$${fees.toFixed(2)}, Status=closed`);
                    }
                } catch (err) {
                    this.logger.error(`Failed to update trade status for ${symbol}:`, err.message);
                }
                
                this.monitoredPositions.delete(symbol);
                return;
            }

            // Position still exists - UPDATE LAST KNOWN PnL
            const currentPnL = parseFloat(position.unRealizedProfit);
            positionData.lastKnownPnL = currentPnL;
            positionData.lastUpdated = Date.now();
            this.monitoredPositions.set(symbol, positionData);

            // Skip CTC logic if already triggered or not enabled
            if (positionData.ctcTriggered || positionData.ctcLevel === 'NONE') {
                // Still alive, just no CTC action needed
                return;
            }

            // Get open orders to check if TP hit (for CTC logic)
            const openOrders = await this.client.getOpenOrders(symbol);
            const tpOrders = openOrders.filter(o => o.type === 'TAKE_PROFIT_MARKET');

            // Determine which TPs have been hit based on missing orders
            // We placed 3 TPs, so if we have less than 3, some have hit
            const tpsHit = 3 - tpOrders.length;

            if (tpsHit === 0) {
                // No TPs hit yet
                return;
            }

            // Check if CTC should trigger
            let shouldTriggerCTC = false;

            if (positionData.ctcLevel === 'TP1' && tpsHit >= 1) {
                shouldTriggerCTC = true;
            } else if (positionData.ctcLevel === 'TP2' && tpsHit >= 2) {
                shouldTriggerCTC = true;
            }

            if (shouldTriggerCTC) {
                this.logger.info(`🔄 CTC triggered for ${symbol} after ${positionData.ctcLevel} hit`);

                // Move SL to break-even
                const symbolInfo = await this.client.getSymbolInfo(symbol);
                await this.executor.moveStopLossToBreakEven(
                    symbol,
                    positionData.side,
                    positionData.entryPrice,
                    symbolInfo
                );

                // Mark as triggered
                positionData.ctcTriggered = true;
                this.monitoredPositions.set(symbol, positionData);
            }

        } catch (error) {
            this.logger.error(`Error checking position for ${symbol}:`, error.message);
        }
    }

    /**
     * Remove position from monitoring
     */
    removePosition(symbol) {
        this.monitoredPositions.delete(symbol);
        this.logger.info(`🗑️ Stopped monitoring ${symbol}`);
    }

    /**
     * OPTION 3: Safety check for unprotected positions
     * Checks every open position has a SL, if not tries to set it from database or closes position
     */
    async safetyCheckUnprotectedPositions() {
        try {
            // Get all open positions from Binance
            const allPositions = await this.client.getPositions();
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

    /**
     * Check if a specific position has a stop loss, if not try to set it or close position
     */
    async checkPositionHasStopLoss(position) {
        const symbol = position.symbol;
        
        try {
            // Check if position has a SL order
            const openOrders = await this.client.getOpenOrders(symbol);
            const hasStopLoss = openOrders.some(o => o.type === 'STOP_MARKET');

            if (hasStopLoss) {
                // Position is protected - all good!
                return;
            }

            // NO STOP LOSS! This is dangerous
            this.logger.warn(`⚠️ UNPROTECTED POSITION DETECTED: ${symbol} has NO Stop Loss!`);

            // Try to find SL from database
            const trades = await this.storage.getAllTrades();
            const trade = trades.find(t => t.symbol === symbol && t.status === 'open');

            if (!trade || !trade.signal || !trade.signal.stopLoss) {
                // No trade record or no SL in database - CLOSE IMMEDIATELY
                this.logger.error(`🚨 EMERGENCY: ${symbol} has no SL in database - CLOSING POSITION FOR SAFETY!`);
                await this.executor.closePosition(symbol, 'emergency-no-sl-data');
                this.monitoredPositions.delete(symbol);
                return;
            }

            // Database has SL - try to set it
            this.logger.info(`🔧 Attempting to set missing SL for ${symbol} from database: ${trade.signal.stopLoss}`);

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const isLong = parseFloat(position.positionAmt) > 0;
            const slPrice = this.executor.roundToTickSize(
                trade.signal.stopLoss,
                symbolInfo.tickSize,
                symbolInfo.pricePrecision
            );

            // Try to place the SL
            try {
                await this.client.placeOrder({
                    symbol,
                    side: isLong ? 'SELL' : 'BUY',
                    type: 'STOP_MARKET',
                    closePosition: 'true',
                    stopPrice: slPrice.toString(),
                    workingType: 'MARK_PRICE'
                });

                this.logger.info(`✅ Successfully set missing SL for ${symbol} at ${slPrice}`);
            } catch (slError) {
                // Failed to set SL - CLOSE POSITION FOR SAFETY
                this.logger.error(`🚨 EMERGENCY: Failed to set SL for ${symbol} - CLOSING POSITION FOR SAFETY!`);
                this.logger.error(`SL Error: ${slError.message}`);
                await this.executor.closePosition(symbol, 'emergency-sl-failed');
                this.monitoredPositions.delete(symbol);
            }

        } catch (error) {
            this.logger.error(`Error checking SL for ${symbol}:`, error.message);
        }
    }

    /**
     * Get monitoring status
     */
    getStatus() {
        return {
            monitoredPositions: this.monitoredPositions.size,
            pendingLimitOrders: this.pendingLimitOrders.size,
            positions: Array.from(this.monitoredPositions.entries()).map(([symbol, data]) => ({
                symbol,
                ...data
            }))
        };
    }
}

module.exports = PositionMonitor;
