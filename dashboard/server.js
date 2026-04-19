/**
 * Dashboard Server
 * Express API server for the trading dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const Logger = require('../src/logger');
const BinanceClient = require('../src/binanceClient');
const TradeExecutor = require('../src/tradeExecutor');
const PositionMonitor = require('../src/positionMonitor');
const StorageManager = require('../src/storageManager');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  Simple session-based auth (no extra packages needed)
// ─────────────────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const activeSessions = new Set();   // in-memory session tokens

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const [k, v] = c.trim().split('=');
        if (k) out[k.trim()] = (v || '').trim();
    });
    return out;
}

function requireAuth(req, res, next) {
    // Always allow: signal provider webhook + login page + login POST + logout
    const open = ['/login', '/logout'];
    if (open.includes(req.path)) return next();
    if (req.path === '/api/trade' && req.method === 'POST') return next();

    const cookies = parseCookies(req);
    if (cookies.dash_session && activeSessions.has(cookies.dash_session)) {
        return next();
    }

    // API calls → 401 JSON
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Unauthorized — please log in at the dashboard' });
    }

    // Browser requests → redirect to login
    res.redirect('/login');
}

// Login page HTML (inline — no extra files needed)
const loginHTML = (error = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trading Bot — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; width: 360px; }
    h1 { color: #e6edf3; font-size: 20px; margin-bottom: 8px; text-align: center; }
    p.sub { color: #8b949e; font-size: 13px; text-align: center; margin-bottom: 28px; }
    label { color: #8b949e; font-size: 13px; display: block; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 10px 14px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font-size: 15px; outline: none; transition: border .2s; }
    input[type=password]:focus { border-color: #58a6ff; }
    button { width: 100%; margin-top: 18px; padding: 11px; background: #238636; border: none; border-radius: 8px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .2s; }
    button:hover { background: #2ea043; }
    .err { margin-top: 14px; padding: 10px 14px; background: #3d1f1f; border: 1px solid #f85149; border-radius: 8px; color: #f85149; font-size: 13px; text-align: center; }
    .icon { text-align: center; font-size: 36px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📊</div>
    <h1>Trading Bot Dashboard</h1>
    <p class="sub">Enter your dashboard password to continue</p>
    <form method="POST" action="/login">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" placeholder="••••••••" autofocus required>
      <button type="submit">Sign In</button>
      ${error ? `<div class="err">${error}</div>` : ''}
    </form>
  </div>
</body>
</html>`;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth guard — comes BEFORE static files so dashboard HTML is also protected
app.use(requireAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ── Login / Logout routes ────────────────────────────────────────────────────
app.get('/login', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.dash_session && activeSessions.has(cookies.dash_session)) {
        return res.redirect('/');
    }
    res.send(loginHTML());
});

app.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (password === DASHBOARD_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.add(token);
        res.setHeader('Set-Cookie', `dash_session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
        return res.redirect('/');
    }
    res.send(loginHTML('Incorrect password. Please try again.'));
});

app.post('/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.dash_session) activeSessions.delete(cookies.dash_session);
    res.setHeader('Set-Cookie', 'dash_session=; HttpOnly; Path=/; Max-Age=0');
    res.redirect('/login');
});
// ────────────────────────────────────────────────────────────────────────────

// Initialize bot components
const logger = new Logger(process.env.LOG_LEVEL || 'info');
const config = {
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    // TRADE_MODE: 'testnet' | 'live'
    tradeMode: process.env.TRADE_MODE || 'live',
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
                // Resolve side from signal (support both direction and side fields)
                const sig = trade.signal || {};
                let side = sig.side;
                if (!side && sig.direction) {
                    side = sig.direction === 'BUY' ? 'LONG' : 'SHORT';
                }
                if (!side) side = 'LONG';

                const isSoftware = config.tradeMode === 'testnet' || !!trade.softwareSLTP;
                monitor.addPosition(trade.symbol, {
                    side,
                    entryPrice:      trade.price || parseFloat(position.entryPrice),
                    orderType:       trade.orderType || 'MARKET',
                    ctcEnabled:      trade.ctcEnabled  || sig.ctcEnabled  || false,
                    ctcTrigger:      trade.ctcTrigger  || sig.ctcTrigger  || 0.5,
                    holdingCandles:  trade.holdingCandles || sig.holdingCandles || 0,
                    tradeStartTime:  trade.tradeStartTime || sig.entryTime || trade.timestamp || Date.now(),
                    softwareSLTP:    isSoftware,
                    stopLoss:        trade.stopLoss    || sig.stopLoss    || null,
                    takeProfit1:     trade.takeProfit1 || sig.takeProfit1 || null
                });

                logger.info(`🔄 Restored monitoring for ${trade.symbol}`);
            }
        }
    } catch (err) {
        logger.error('Failed to restore monitored positions:', err.message);
    }
}

initializeMonitor();

// ─────────────────────────────────────────────
//  API Routes
// ─────────────────────────────────────────────

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
                tradeMode: config.tradeMode,
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
 *
 * Accepts signals from external providers with these fields:
 *   direction     - 'BUY' | 'SELL'  (or side: 'LONG' | 'SHORT')
 *   rr            - risk:reward ratio (TPs computed automatically)
 *   marginMode    - 'percent' | 'dollar'
 *   marginDollar  - $ amount per trade (when marginMode=dollar)
 *   ctcEnabled    - boolean
 *   ctcTrigger    - fraction of TP dist (0.4 = 40%)
 *   holdingCandles- number of 3-min candles before force-close
 *   entryTime     - unix ms timestamp of signal entry
 */
app.post('/api/trade', async (req, res) => {
    try {
        const signal = req.body;

        // ---- Validation ----
        if (!signal.symbol) {
            return res.status(400).json({ success: false, error: 'Missing required field: symbol' });
        }
        if (!signal.side && !signal.direction) {
            return res.status(400).json({ success: false, error: 'Missing required field: side or direction (BUY/SELL)' });
        }
        if (!signal.stopLoss) {
            return res.status(400).json({ success: false, error: 'Missing required field: stopLoss' });
        }
        if (!signal.leverage) {
            return res.status(400).json({ success: false, error: 'Missing required field: leverage' });
        }
        if (!signal.riskMode) {
            return res.status(400).json({ success: false, error: 'Missing required field: riskMode' });
        }

        // R:R is always required — bot computes single TP from it
        if (!signal.rr || signal.rr <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: rr (risk:reward ratio, e.g. 2.5)'
            });
        }

        // Margin: dollar (default for signal provider) or percent
        const marginMode = signal.marginMode || 'dollar';
        if (marginMode === 'dollar') {
            if (!signal.marginDollar || signal.marginDollar <= 0) {
                return res.status(400).json({ success: false, error: 'marginDollar must be > 0 when marginMode=dollar' });
            }
        } else {
            if (!signal.walletPercentage || signal.walletPercentage < 1 || signal.walletPercentage > 100) {
                return res.status(400).json({ success: false, error: 'walletPercentage must be between 1 and 100' });
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

        // Set default orderType
        if (!signal.orderType) signal.orderType = 'MARKET';

        // Execute trade
        const result = await executor.executeTrade(signal);

        // Save trade to storage with all new fields
        const tradeId = await storage.saveTrade({
            ...result,
            signal,
            status: signal.orderType === 'MARKET' ? 'open' : 'pending',
            ctcEnabled: result.ctcEnabled,
            ctcTrigger: result.ctcTrigger,
            holdingCandles: result.holdingCandles,
            tradeStartTime: result.tradeStartTime
        });

        // Resolve side for monitor (direction → side mapping)
        const monitorSide = result.side;

        // Add to monitor
        if (signal.orderType === 'MARKET') {
            monitor.addPosition(signal.symbol, {
                side:           monitorSide,
                entryPrice:     result.price,
                orderType:      'MARKET',
                ctcEnabled:     result.ctcEnabled,
                ctcTrigger:     result.ctcTrigger,
                holdingCandles: result.holdingCandles,
                tradeStartTime: result.tradeStartTime,
                // software SL/TP (testnet)
                softwareSLTP:   result.softwareSLTP || false,
                stopLoss:       result.stopLoss     || null,
                takeProfit1:    result.takeProfit1   || null
            });
        } else {
            monitor.addPendingLimitOrder(signal.symbol, {
                ...signal,
                side:           monitorSide,
                takeProfit1:    result.takeProfit1,
                orderId:        result.orderId,
                ctcEnabled:     result.ctcEnabled,
                ctcTrigger:     result.ctcTrigger,
                holdingCandles: result.holdingCandles,
                tradeStartTime: result.tradeStartTime
            });
        }

        logger.info(`✅ Trade executed — ID: ${tradeId}`);
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
 * Get active positions enriched with SL/TP orders and monitor data
 */
app.get('/api/positions', async (req, res) => {
    try {
        const positions = await binanceClient.getPositions();
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const monitorStatus = monitor.getStatus();

        const enrichedPositions = await Promise.all(activePositions.map(async (p) => {
            const symbol = p.symbol;
            const isLongPos = parseFloat(p.positionAmt) > 0;

            // Merge monitor data
            const monitorPos = monitorStatus.positions.find(mp => mp.symbol === symbol) || {};

            // SL/TP: use software monitor data (testnet) or exchange orders (live)
            let sl = null, tp1 = null;
            if (monitorPos.softwareSLTP) {
                sl  = monitorPos.stopLoss    || null;
                tp1 = monitorPos.takeProfit1 || null;
            } else {
                try {
                    const orders = await binanceClient.getOpenOrders(symbol);
                    const slOrder = orders.find(o => o.type === 'STOP_MARKET');
                    if (slOrder) sl = parseFloat(slOrder.stopPrice);

                    const tpOrders = orders.filter(o => o.type === 'TAKE_PROFIT_MARKET');
                    if (tpOrders.length > 0) {
                        tpOrders.sort((a, b) => {
                            const pa = parseFloat(a.stopPrice);
                            const pb = parseFloat(b.stopPrice);
                            return isLongPos ? (pa - pb) : (pb - pa);
                        });
                        if (tpOrders[0]) tp1 = parseFloat(tpOrders[0].stopPrice);
                    }
                } catch (err) {
                    logger.debug(`Could not fetch orders for ${symbol}`);
                }
            }

            // PnL % with leverage
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            let priceChangePct = isLongPos
                ? ((markPrice - entryPrice) / entryPrice) * 100
                : ((entryPrice - markPrice) / entryPrice) * 100;
            const leveragedPnlPercent = (priceChangePct * parseFloat(p.leverage)).toFixed(2);

            // Risk/Reward calculation
            let riskReward = 'N/A';
            let riskDollar = 0;
            let rewardDollar = 0;
            if (sl && tp1) {
                const quantity = Math.abs(parseFloat(p.positionAmt));
                const slDiff   = isLongPos ? (entryPrice - sl)  : (sl  - entryPrice);
                const tpDiff   = isLongPos ? (tp1 - entryPrice) : (entryPrice - tp1);
                const risk     = quantity * slDiff;
                const reward   = quantity * tpDiff;
                if (risk > 0) {
                    riskReward   = `1:${(reward / risk).toFixed(2)}`;
                    riskDollar   = risk;
                    rewardDollar = reward;
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
                leveragedPnlPercent,
                margin: parseFloat(p.isolatedMargin),
                leverage: parseFloat(p.leverage),
                stopLoss: sl,
                takeProfit1: tp1,
                riskReward,
                riskDollar: riskDollar.toFixed(2),
                rewardDollar: rewardDollar.toFixed(2),
                // Holding candle info
                holdingEnabled: monitorPos.holdingEnabled ?? false,
                holdingCandles: monitorPos.holdingCandles || 0,
                elapsedCandles: monitorPos.elapsedCandles || 0,
                tradeStartTime: monitorPos.tradeStartTime || null,
                // CTC info
                ctcEnabled:      monitorPos.ctcEnabled      || false,
                ctcTriggered:    monitorPos.ctcTriggered     || false,
                ctcTrigger:      monitorPos.ctcTrigger       || null,
                ctcTriggerPrice: monitorPos.ctcTriggerPrice  || null,
                // Software SL/TP mode info
                softwareSLTP:    monitorPos.softwareSLTP     || false,
                tpHit:           monitorPos.tpHit            || false
            };
        }));

        res.json({ success: true, data: enrichedPositions });
    } catch (error) {
        logger.error('Error getting positions:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Close position manually
 */
app.post('/api/close/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;

        // Capture PnL before closing
        const positions = await binanceClient.getPositions(symbol);
        const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        const pnl = position ? parseFloat(position.unRealizedProfit) : 0;
        const fees = Math.abs(pnl * 0.0004);

        const result = await executor.closePosition(symbol, 'manual');
        monitor.removePosition(symbol);

        // Update trade record
        const trades = await storage.getAllTrades();
        const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
        if (openTrade) {
            await storage.updateTrade(openTrade.id, {
                status: 'closed',
                closedAt: Date.now(),
                closeReason: 'manual',
                pnl,
                fees,
                netPnL: pnl - fees
            });
            logger.info(`Trade ${openTrade.id} closed manually: PnL=$${pnl.toFixed(2)}`);
        }

        res.json({ success: true, data: result, pnl, fees });
    } catch (error) {
        logger.error('Error closing position:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * ─────────────────────────────────────────────
 * HOLDING CANDLE ENDPOINTS (per-position only)
 * ─────────────────────────────────────────────
 */

/**
 * Get holding monitor status (per-position data)
 */
app.get('/api/monitor/holding', (req, res) => {
    const status = monitor.getStatus();
    res.json({ success: true, data: status });
});

/**
 * Toggle per-position holding ON/OFF
 * Body: { "enabled": true | false }
 * When re-enabled, immediately closes if holding limit already reached
 */
app.post('/api/positions/:symbol/holding', async (req, res) => {
    try {
        const { enabled } = req.body;
        const { symbol } = req.params;

        if (typeof enabled === 'undefined') {
            return res.status(400).json({ success: false, error: 'Missing: enabled (boolean)' });
        }

        const result = await monitor.setPositionHolding(symbol, !!enabled);
        if (result) {
            res.json({
                success: true,
                message: `${symbol} holding ${!!enabled ? 'ENABLED' : 'DISABLED'}`,
                data: { symbol, holdingEnabled: !!enabled }
            });
        } else {
            res.status(404).json({ success: false, error: `Position ${symbol} not found in monitor` });
        }
    } catch (error) {
        logger.error(`Error toggling holding for ${req.params.symbol}:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * ─────────────────────────────────────────────
 * CTC UPDATE ENDPOINT (legacy + new)
 * ─────────────────────────────────────────────
 */

/**
 * Update CTC settings for an active position
 * Body: { "ctcEnabled": true, "ctcTrigger": 0.4 }
 */
app.post('/api/update-ctc/:symbol', async (req, res) => {
    try {
        const { ctcEnabled, ctcTrigger, ctcLevel } = req.body;
        const { symbol } = req.params;

        const positionData = monitor.monitoredPositions.get(symbol);
        if (!positionData) {
            return res.status(404).json({ success: false, error: 'Position not found in monitor' });
        }

        // Support both old (ctcLevel=NONE/TP1/TP2) and new (ctcEnabled + ctcTrigger) formats
        let newCtcEnabled = positionData.ctcEnabled;
        let newCtcTrigger = positionData.ctcTrigger;

        if (typeof ctcEnabled !== 'undefined') {
            newCtcEnabled = !!ctcEnabled;
        }
        if (typeof ctcTrigger !== 'undefined') {
            newCtcTrigger = parseFloat(ctcTrigger);
        }
        // Legacy support
        if (ctcLevel === 'NONE') newCtcEnabled = false;
        if (ctcLevel === 'TP1') { newCtcEnabled = true; newCtcTrigger = 0.33; }
        if (ctcLevel === 'TP2') { newCtcEnabled = true; newCtcTrigger = 0.67; }

        // Recompute trigger price from takeProfit1
        let newCtcTriggerPrice = null;
        if (newCtcEnabled && positionData.takeProfit1 && positionData.entryPrice) {
            const isLong = positionData.side === 'LONG';
            newCtcTriggerPrice = isLong
                ? positionData.entryPrice + newCtcTrigger * (positionData.takeProfit1 - positionData.entryPrice)
                : positionData.entryPrice - newCtcTrigger * (positionData.entryPrice - positionData.takeProfit1);
        }

        monitor.monitoredPositions.set(symbol, {
            ...positionData,
            ctcEnabled: newCtcEnabled,
            ctcTrigger: newCtcTrigger,
            ctcTriggerPrice: newCtcTriggerPrice,
            ctcTriggered: false // reset trigger status on update
        });

        logger.info(`Updated CTC for ${symbol}: enabled=${newCtcEnabled}, trigger=${(newCtcTrigger * 100).toFixed(0)}%`);
        res.json({
            success: true,
            message: `CTC updated for ${symbol}`,
            data: { ctcEnabled: newCtcEnabled, ctcTrigger: newCtcTrigger, ctcTriggerPrice: newCtcTriggerPrice }
        });
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
