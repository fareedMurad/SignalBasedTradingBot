/**
 * Dashboard Server
 * Express API server for the trading dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const Logger = require('../src/logger');
const BinanceClient = require('../src/binanceClient');
const TradeExecutor = require('../src/tradeExecutor');
const PositionMonitor = require('../src/positionMonitor');
const StorageManager = require('../src/storageManager');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize bot components
const logger = new Logger(process.env.LOG_LEVEL || 'info');
const config = {
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    useTestnet: process.env.USE_TESTNET === 'true',
    useDemoEnv: process.env.USE_DEMO_ENV === 'true',
    leverage: parseInt(process.env.LEVERAGE) || 10,
    riskMode: process.env.RISK_MODE || 'isolated',
    minMarginBalance: parseFloat(process.env.MIN_MARGIN_BALANCE) || 50,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    s3BucketName: process.env.S3_BUCKET_NAME
};

const binanceClient = new BinanceClient(config, logger);
const storage = new StorageManager(config, logger);
const executor = new TradeExecutor(binanceClient, logger, config);
const monitor = new PositionMonitor(binanceClient, executor, logger, storage);

// Start monitor and restore positions
async function initializeMonitor() {
    monitor.start();
    
    // Restore open positions to monitoring after restart
    try {
        const trades = await storage.getAllTrades();
        const openTrades = trades.filter(t => t.status === 'open' && t.signal);
        
        for (const trade of openTrades) {
            const positions = await binanceClient.getPositions(trade.symbol);
            const position = positions.find(p => p.symbol === trade.symbol && parseFloat(p.positionAmt) !== 0);
            
            if (position) {
                monitor.addPosition(
                    trade.symbol,
                    trade.signal.side,
                    trade.price || parseFloat(position.entryPrice),
                    trade.signal.ctcLevel || 'NONE',
                    trade.orderType
                );
                logger.info(`🔄 Restored monitoring for ${trade.symbol} (CTC: ${trade.signal.ctcLevel})`);
            }
        }
    } catch (err) {
        logger.error('Failed to restore monitored positions:', err.message);
    }
}

initializeMonitor();

// API Routes

/**
 * Get bot status
 */
app.get('/api/status', async (req, res) => {
    try {
        const balance = await binanceClient.getBalance();
        const positions = await binanceClient.getPositions();
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const monitorStatus = monitor.getStatus();
        const stats = await storage.getStatistics();

        res.json({
            success: true,
            data: {
                balance: {
                    available: balance.available.toFixed(2),
                    total: balance.total.toFixed(2)
                },
                activePositions: activePositions.length,
                monitoredPositions: monitorStatus.monitoredPositions,
                pendingLimitOrders: monitorStatus.pendingLimitOrders,
                statistics: stats
            }
        });
    } catch (error) {
        logger.error('Error getting status:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get available symbols
 */
app.get('/api/symbols', async (req, res) => {
    try {
        const symbols = await binanceClient.getAvailableSymbols();
        res.json({ success: true, data: symbols });
    } catch (error) {
        logger.error('Error getting symbols:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get current price for a symbol
 */
app.get('/api/price/:symbol', async (req, res) => {
    try {
        const price = await binanceClient.getPrice(req.params.symbol);
        res.json({ success: true, data: { price } });
    } catch (error) {
        logger.error('Error getting price:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get symbol details including max leverage
 */
app.get('/api/symbol-info/:symbol', async (req, res) => {
    try {
        const symbolInfo = await binanceClient.getSymbolInfo(req.params.symbol);
        const exchangeInfo = await binanceClient.client.futuresExchangeInfo();
        const fullSymbolInfo = exchangeInfo.symbols.find(s => s.symbol === req.params.symbol);

        res.json({
            success: true,
            data: {
                ...symbolInfo,
                maxLeverage: fullSymbolInfo?.leverage || 125
            }
        });
    } catch (error) {
        logger.error('Error getting symbol info:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Execute trade signal
 */
app.post('/api/trade', async (req, res) => {
    try {
        const signal = req.body;

        // Validate signal
        const required = ['symbol', 'side', 'orderType', 'walletPercentage', 'leverage', 'riskMode', 'stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3', 'ctcLevel'];
        for (const field of required) {
            if (signal[field] === undefined || signal[field] === null || signal[field] === '') {
                return res.status(400).json({ success: false, error: `Missing required field: ${field}` });
            }
        }

        // Validate leverage range
        if (signal.leverage < 1 || signal.leverage > 125) {
            return res.status(400).json({ success: false, error: 'Leverage must be between 1 and 125' });
        }

        // Validate risk mode
        if (!['isolated', 'crossed'].includes(signal.riskMode.toLowerCase())) {
            return res.status(400).json({ success: false, error: 'Risk mode must be isolated or crossed' });
        }

        // Execute trade
        const result = await executor.executeTrade(signal);

        // Save trade to storage
        const tradeId = await storage.saveTrade({
            ...result,
            signal,
            status: signal.orderType === 'MARKET' ? 'open' : 'pending',
            ctcLevel: signal.ctcLevel
        });

        // Add to monitor
        if (signal.orderType === 'MARKET') {
            monitor.addPosition(
                signal.symbol,
                signal.side,
                result.price,
                signal.ctcLevel,
                'MARKET'
            );
        } else {
            monitor.addPendingLimitOrder(signal.symbol, {
                ...signal,
                orderId: result.orderId
            });
        }

        logger.info(`✅ Trade executed - ID: ${tradeId}`);
        res.json({ success: true, data: { tradeId, ...result } });

    } catch (error) {
        logger.error('Error executing trade:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get all trades
 */
app.get('/api/trades', async (req, res) => {
    try {
        const trades = await storage.getAllTrades();
        res.json({ success: true, data: trades });
    } catch (error) {
        logger.error('Error getting trades:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get active positions with SL/TP orders
 */
app.get('/api/positions', async (req, res) => {
    try {
        const positions = await binanceClient.getPositions();
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        const enrichedPositions = await Promise.all(activePositions.map(async (p) => {
            const symbol = p.symbol;
            const isLong = parseFloat(p.positionAmt) > 0;
            
            // Get open orders for this position
            let sl = null, tp1 = null, tp2 = null, tp3 = null;
            try {
                const orders = await binanceClient.getOpenOrders(symbol);
                
                // Find SL order
                const slOrder = orders.find(o => o.type === 'STOP_MARKET');
                if (slOrder) sl = parseFloat(slOrder.stopPrice);
                
                // Find TP orders and sort by price
                const tpOrders = orders.filter(o => o.type === 'TAKE_PROFIT_MARKET');
                
                if (tpOrders.length > 0) {
                    // Sort by price: LONG = ascending (TP1 lowest), SHORT = descending (TP1 highest)
                    tpOrders.sort((a, b) => {
                        const priceA = parseFloat(a.stopPrice);
                        const priceB = parseFloat(b.stopPrice);
                        return isLong ? (priceA - priceB) : (priceB - priceA);
                    });
                    
                    // Assign TPs in order
                    if (tpOrders[0]) tp1 = parseFloat(tpOrders[0].stopPrice);
                    if (tpOrders[1]) tp2 = parseFloat(tpOrders[1].stopPrice);
                    if (tpOrders[2]) tp3 = parseFloat(tpOrders[2].stopPrice);
                }
            } catch (err) {
                logger.debug(`Could not fetch orders for ${symbol}`);
            }

            // Calculate leveraged PnL % (actual price movement * leverage)
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            const isLongPos = parseFloat(p.positionAmt) > 0;
            
            let priceChangePercent = 0;
            if (isLongPos) {
                priceChangePercent = ((markPrice - entryPrice) / entryPrice) * 100;
            } else {
                priceChangePercent = ((entryPrice - markPrice) / entryPrice) * 100;
            }
            
            const leveragedPnlPercent = (priceChangePercent * parseFloat(p.leverage)).toFixed(2);

            // Calculate Risk/Reward ratio with dollar amounts
            let riskReward = 'N/A';
            let riskDollar = 0;
            let rewardDollar = 0;
            if (sl && (tp1 || tp2 || tp3)) {
                const quantity = Math.abs(parseFloat(p.positionAmt));
                const slDiff = isLongPos ? (entryPrice - sl) : (sl - entryPrice);
                const risk = quantity * slDiff;
                
                const tp1Diff = tp1 ? (isLongPos ? (tp1 - entryPrice) : (entryPrice - tp1)) : 0;
                const tp2Diff = tp2 ? (isLongPos ? (tp2 - entryPrice) : (entryPrice - tp2)) : 0;
                const tp3Diff = tp3 ? (isLongPos ? (tp3 - entryPrice) : (entryPrice - tp3)) : 0;
                
                const tp1Profit = tp1 ? (quantity * 0.33) * tp1Diff : 0;
                const tp2Profit = tp2 ? (quantity * 0.33) * tp2Diff : 0;
                const tp3Profit = tp3 ? (quantity * 0.34) * tp3Diff : 0;
                
                const totalReward = tp1Profit + tp2Profit + tp3Profit;
                if (risk > 0) {
                    riskReward = `1:${(totalReward / risk).toFixed(2)}`;
                    riskDollar = risk;
                    rewardDollar = totalReward;
                }
            }

            return {
                symbol,
                side: isLongPos ? 'LONG' : 'SHORT',
                quantity: Math.abs(parseFloat(p.positionAmt)),
                entryPrice,
                markPrice,
                pnl: parseFloat(p.unRealizedProfit),
                pnlPercent: ((parseFloat(p.unRealizedProfit) / parseFloat(p.isolatedMargin)) * 100).toFixed(2),
                leveragedPnlPercent, // New field: actual % captured with leverage
                margin: parseFloat(p.isolatedMargin),
                leverage: parseFloat(p.leverage),
                stopLoss: sl,
                takeProfit1: tp1,
                takeProfit2: tp2,
                takeProfit3: tp3,
                riskReward,
                riskDollar: riskDollar.toFixed(2),
                rewardDollar: rewardDollar.toFixed(2)
            };
        }));

        res.json({ success: true, data: enrichedPositions });
    } catch (error) {
        logger.error('Error getting positions:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Close position
 */
app.post('/api/close/:symbol', async (req, res) => {
    try {
        // Get position PnL BEFORE closing
        const positions = await binanceClient.getPositions(req.params.symbol);
        const position = positions.find(p => p.symbol === req.params.symbol && parseFloat(p.positionAmt) !== 0);
        
        const pnl = position ? parseFloat(position.unRealizedProfit) : 0;
        const fees = Math.abs(pnl * 0.0004); // Estimate 0.04% trading fee
        
        const result = await executor.closePosition(req.params.symbol, 'manual');
        monitor.removePosition(req.params.symbol);
        
        // Update trade status in storage WITH PnL
        const trades = await storage.getAllTrades();
        const openTrade = trades.find(t => t.symbol === req.params.symbol && t.status === 'open');
        
        if (openTrade) {
            await storage.updateTrade(openTrade.id, {
                status: 'closed',
                closedAt: Date.now(),
                closeReason: 'manual',
                pnl,
                fees,
                netPnL: pnl - fees
            });
            logger.info(`Updated trade ${openTrade.id}: PnL=$${pnl.toFixed(2)}, Status=closed`);
        }
        
        res.json({ success: true, data: result, pnl, fees });
    } catch (error) {
        logger.error('Error closing position:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Update CTC level for a position
 */
app.post('/api/update-ctc/:symbol', async (req, res) => {
    try {
        const { ctcLevel } = req.body;
        const { symbol } = req.params;

        if (!['NONE', 'TP1', 'TP2'].includes(ctcLevel)) {
            return res.status(400).json({ success: false, error: 'Invalid CTC level' });
        }

        // Update in monitor
        const monitorStatus = monitor.getStatus();
        const position = monitorStatus.positions.find(p => p.symbol === symbol);

        if (position) {
            monitor.monitoredPositions.set(symbol, {
                ...position,
                ctcLevel,
                ctcTriggered: false // Reset trigger status
            });
            logger.info(`Updated CTC level for ${symbol} to ${ctcLevel}`);
            res.json({ success: true, message: `CTC level updated to ${ctcLevel}` });
        } else {
            res.status(404).json({ success: false, error: 'Position not found in monitor' });
        }
    } catch (error) {
        logger.error('Error updating CTC:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get statistics
 */
app.get('/api/statistics', async (req, res) => {
    try {
        const stats = await storage.getStatistics();
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Error getting statistics:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    logger.info(`🌐 Dashboard server running on http://localhost:${PORT}`);
    logger.info(`📊 Open your browser to access the dashboard`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('\n🛑 Shutting down dashboard server...');
    monitor.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('\n🛑 Shutting down dashboard server...');
    monitor.stop();
    process.exit(0);
});
