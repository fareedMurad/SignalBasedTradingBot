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
const { createExchangeClient } = require('../src/exchangeClient');
const TradeExecutor = require('../src/tradeExecutor');
const PositionMonitor = require('../src/positionMonitor');
const StorageManager = require('../src/storageManager');

// ── MEXC Browser Bot — embedded when MEXC_BROWSER_MODE=true ─────────────────
// Single process, zero extra HTTP hops.  Set in .env:
//   MEXC_BROWSER_MODE=true
const MEXC_BROWSER_MODE = process.env.MEXC_BROWSER_MODE === 'true';
let mexcBot = null;
if (MEXC_BROWSER_MODE) {
    const MexcBrowserBot = require('../src/mexcBrowserBot');
    mexcBot = new MexcBrowserBot();
}

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
    // Always allow: signal provider webhook + login page + login POST + logout + ping
    const open = ['/login', '/logout'];
    if (open.includes(req.path)) return next();
    if (req.path === '/api/trade' && req.method === 'POST') return next();
    if (req.path === '/api/ping') return next();  // ConnectionWarmer keep-alive probe (no auth needed)

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
    // Binance keys (EXCHANGE=binance)
    apiKey    : process.env.API_KEY,
    apiSecret : process.env.API_SECRET,
    // MEXC keys (EXCHANGE=mexc)
    mexcApiKey    : process.env.MEXC_API_KEY,
    mexcApiSecret : process.env.MEXC_API_SECRET,
    // Trade mode
    tradeMode  : process.env.TRADE_MODE || (process.env.USE_TESTNET === 'true' ? 'testnet' : 'live'),
    useTestnet : process.env.USE_TESTNET === 'true',
    useDemoEnv : process.env.USE_DEMO_ENV === 'true',
    // Risk
    leverage         : parseInt(process.env.LEVERAGE) || 10,
    riskMode         : process.env.RISK_MODE || 'isolated',
    minMarginBalance : parseFloat(process.env.MIN_MARGIN_BALANCE) || 50,
    // Storage
    awsAccessKeyId    : process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsRegion         : process.env.AWS_REGION || 'us-east-1',
    s3BucketName      : process.env.S3_BUCKET_NAME
};

// Exchange client — Binance or MEXC based on EXCHANGE= in .env
const exchangeClient = createExchangeClient(config, logger);
const storage  = new StorageManager(config, logger);
const executor = new TradeExecutor(exchangeClient, logger, config);
const monitor  = new PositionMonitor(exchangeClient, executor, logger, storage);

// Start monitor and restore positions
async function initializeMonitor() {
    monitor.start();

    // Restore open positions to monitoring after restart
    try {
        const trades = await storage.getAllTrades();
        const openTrades = trades.filter(t => t.status === 'open' && t.signal);

        for (const trade of openTrades) {
            const positions = await exchangeClient.getPositions(trade.symbol);
            const position = positions.find(p => p.symbol === trade.symbol && parseFloat(p.positionAmt) !== 0);

            if (position) {
                // Resolve side from signal (support both direction and side fields)
                const sig = trade.signal || {};
                let side = sig.side;
                if (!side && sig.direction) {
                    side = sig.direction === 'BUY' ? 'LONG' : 'SHORT';
                }
                if (!side) side = 'LONG';

                // In browser-bot mode softwareSLTP is always false:
                // MEXC handles TP/SL via its own stop orders — enabling software mode
                // would fire a REST market close on every TP hit (bad fills, -$37 bleed).
                const isSoftware = MEXC_BROWSER_MODE
                    ? false
                    : (config.tradeMode === 'testnet' || !!trade.softwareSLTP);

                const restoredHoldingCandles = trade.holdingCandles || sig.holdingCandles || 0;
                // Restore the user's manual holdingEnabled toggle (persisted to S3 when toggled).
                // Fall back to (holdingCandles > 0) so new trades auto-enable holding.
                const restoredHoldingEnabled = trade.holdingEnabled !== undefined
                    ? trade.holdingEnabled
                    : restoredHoldingCandles > 0;

                monitor.addPosition(trade.symbol, {
                    side,
                    entryPrice:      trade.price || parseFloat(position.entryPrice),
                    orderType:       trade.orderType || 'MARKET',
                    ctcEnabled:      trade.ctcEnabled  || sig.ctcEnabled  || false,
                    ctcTrigger:      trade.ctcTrigger  || sig.ctcTrigger  || 0.5,
                    holdingCandles:  restoredHoldingCandles,
                    holdingEnabled:  restoredHoldingEnabled,
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

// ── WS price watcher — start immediately so price is cached before first signal ──
// startPriceWatcher is only available on MexcClient (not BinanceClient).
// It subscribes to MEXC's push.ticker WebSocket and caches the price in memory.
// When a signal arrives, getLivePrice() returns the cached value at 0ms instead
// of calling getPrice() REST (~200ms round-trip).
if (typeof exchangeClient.startPriceWatcher === 'function') {
    // Watch all symbols configured — BTCUSDT by default, plus anything in WATCHED_SYMBOLS env
    const watchSymbols = (process.env.WATCHED_SYMBOLS || 'BTCUSDT')
        .split(',').map(s => s.trim()).filter(Boolean);
    exchangeClient.startPriceWatcher(watchSymbols);
    logger.info(`📡 WS price watcher started for: ${watchSymbols.join(', ')}`);
}

// Pre-connect MEXC browser bot (non-blocking — will retry on first request)
if (MEXC_BROWSER_MODE && mexcBot) {
    // Keep-alive must never refresh while a position is open (would detach frame)
    mexcBot.setPositionChecker(() => monitor.monitoredPositions.size > 0);

    // ── UI close handler ─────────────────────────────────────────────────────
    // ALL forced closes (holding-candle, emergency) go through Puppeteer Flash
    // Close — never through the REST API.  REST market orders on MEXC execute at
    // spot price and bypass the exchange's own TP limit order, causing large slippage.
    monitor.setUICloseHandler(async (symbol, side) => {
        if (!mexcBot.page || mexcBot.page.isClosed()) await mexcBot.connect();
        await mexcBot.closeTrade({ symbol, direction: side, flash: true });
    });

    // ── UI TP/SL update handler ───────────────────────────────────────────────
    // CTC break-even SL moves and all in-monitor SL/TP updates go through
    // Puppeteer (mexcBot.updateTpSl) — zero REST API calls in browser mode.
    monitor.setUIUpdateTpSlHandler(async (symbol, direction, tpPrice, slPrice) => {
        if (!mexcBot.page || mexcBot.page.isClosed()) await mexcBot.connect();
        await mexcBot.updateTpSl({ symbol, direction, tpPrice: tpPrice || undefined, slPrice: slPrice || undefined });
    });

    mexcBot.connect()
        .then(() => logger.info('🤖 MEXC Browser Bot connected in-process'))
        .catch(err => logger.warn(`⚠️  MEXC Browser Bot pre-connect skipped: ${err.message} — will retry on first trade`));
}

// ─────────────────────────────────────────────
//  API Routes
// ─────────────────────────────────────────────

/**
 * Get bot status
 */
app.get('/api/status', async (req, res) => {
    try {
        const balance = await exchangeClient.getBalance();
        const positions = await exchangeClient.getPositions();
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
        const symbols = await exchangeClient.getAvailableSymbols();
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
        const price = await exchangeClient.getPrice(req.params.symbol);
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
        const symbolInfo   = await exchangeClient.getSymbolInfo(req.params.symbol);
        const maxLeverage  = await exchangeClient.getMaxLeverage(req.params.symbol);

        res.json({
            success: true,
            data: { ...symbolInfo, maxLeverage }
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

        // SL: must have EITHER stopLoss (absolute price) OR slPips (distance from entry)
        const hasSL = signal.stopLoss || signal.slPips;
        if (!hasSL) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: stopLoss (price) OR slPips (distance in USDT from entry)'
            });
        }

        if (!signal.leverage) {
            return res.status(400).json({ success: false, error: 'Missing required field: leverage' });
        }
        if (!signal.riskMode) {
            return res.status(400).json({ success: false, error: 'Missing required field: riskMode' });
        }

        // TP: must have EITHER rr OR tpPips (can't compute TP without one of them)
        if (!signal.tpPips && !signal.takeProfit1) {
            if (!signal.rr || signal.rr <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required field: rr (risk:reward, e.g. 2.5) or tpPips (TP distance in USDT from entry)'
                });
            }
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
        if (signal.leverage < 1 || signal.leverage > 500) {
            return res.status(400).json({ success: false, error: 'Leverage must be between 1 and 500' });
        }

        // Validate risk mode
        if (!['isolated', 'crossed'].includes(signal.riskMode.toLowerCase())) {
            return res.status(400).json({ success: false, error: 'Risk mode must be isolated or crossed' });
        }

        // Set default orderType
        if (!signal.orderType) signal.orderType = 'MARKET';

        // ── Position deduplication guard ─────────────────────────────────────
        // If a position for this symbol is already being monitored, reject the
        // trade with 409.  This is the last-resort safety net against duplicate
        // trades caused by EC2 retrying a signal that the Mac already executed
        // (but whose response timed out before EC2 received it).
        //
        // The EC2 side treats 409 as a non-retryable error (HTTP status is not
        // in the retryable list), so it stops retrying immediately.
        if (monitor.monitoredPositions.has(signal.symbol)) {
            const existing = monitor.monitoredPositions.get(signal.symbol);
            logger.warn(`🚫 [DeDup] Rejected duplicate signal for ${signal.symbol} — ` +
                `${existing.side} position already open (entered @ ${existing.entryPrice}). ` +
                `EC2 may have retried a signal whose first response was delayed.`);
            return res.status(409).json({
                success: false,
                error: `Duplicate signal rejected: a ${existing.side} position for ${signal.symbol} ` +
                    `is already open (entry ${existing.entryPrice}). ` +
                    `Close the existing position before opening another.`
            });
        }

        // ── MEXC Browser Bot path (in-process, zero extra hops) ───────────────
        if (MEXC_BROWSER_MODE && mexcBot) {
            // ── Precision timing — every step logged so we can pinpoint latency ──
            const receivedAt = Date.now();
            logger.info(`📨 [TIMING] Signal received for ${signal.symbol} at ${new Date(receivedAt).toISOString()}`);
            // ── Upstream latency: time from signal generation → bot received ────
            if (signal.entryTime && signal.entryTime > 0) {
                const upstreamMs = receivedAt - signal.entryTime;
                logger.info(`🌐 [TIMING] Upstream latency: ${upstreamMs}ms (${(upstreamMs/1000).toFixed(2)}s) | signal generated at ${new Date(signal.entryTime).toISOString()}`);
            }

    // ── Resolve side (pure computation — no I/O) ──────────────────────────
    let side = signal.side;
    if (!side && signal.direction) side = signal.direction === 'BUY' ? 'LONG' : 'SHORT';
    if (!side) side = 'LONG';
    const direction = signal.direction || (side === 'LONG' ? 'BUY' : 'SELL');

    // ── STEP 1: Fire REST kline IMMEDIATELY — parallel pipeline ───────────
    // Promise is started here at T=0ms and runs concurrently with STEP 2
    // (bot connection check). We await the result in STEP 3 below.
    //
    // WHY ALWAYS REST — NEVER WS CACHE:
    //   The WS push.kline message for a NEW 3m candle fires ~200ms after candle open.
    //   Signals fire at T=0ms of the new candle. In that window getCandleOpen() = null
    //   → code falls back to the live ticker, which has already moved.
    //   Observed: ticker=65308 vs true candle open=65255 → SL 53pts too tight.
    //
    // WHY NEVER signal payload prices (entry/price from capie):
    //   capie-mvp is trained on Binance.US spot data. MEXC futures has a 20-80 USDT
    //   basis vs Binance.US. Any payload price would misplace SL/TP by that spread.
    //
    // LATENCY IMPACT (parallel trick):
    //   REST kline ~80-150ms. But it starts HERE and runs in parallel with STEP 2.
    //   • Bot already connected: kline REST waits ~80-150ms → total ~680ms (still <1s)
    //   • Bot needs reconnect (~300ms): kline REST FINISHES DURING reconnect → +0ms
    let currentPrice = null;
    const _klinePromise = (typeof exchangeClient.getCandleOpenREST === 'function')
        ? exchangeClient.getCandleOpenREST(signal.symbol).catch(() => 0)
        : Promise.resolve(0);
    logger.info(`🔌 [TIMING] REST kline fired at T=0 (parallel) | since receive: ${Date.now() - receivedAt}ms`);

    // ── STEP 2: Ensure bot connection is alive ────────────────────────────
    // Three-level staleness check:
    //   1. page reference is null
    //   2. page.isClosed() — Puppeteer closed the page object
    //   3. browser.connected=false — CDP WebSocket to Chrome has dropped silently.
    //      Old code only checked isClosed(), which misses silent WS drops leaving
    //      page.isClosed()=false while every page.evaluate() would throw.
    //
    // The background _healthProbe() (every 60s, added to MexcBrowserBot) calls
    // connect() proactively so this branch should almost never be needed on a
    // live signal. When it IS needed, explicit timing shows exactly how long it took.
    const needsConnect = !mexcBot.page
        || mexcBot.page.isClosed()
        || !(mexcBot.browser?.connected ?? true);
    if (needsConnect) {
        const connectStart = Date.now();
        logger.warn(`⚠️ [TIMING] Bot page stale at signal arrival — reconnecting… (${Date.now() - receivedAt}ms since signal)`);
        await mexcBot.connect();
        logger.info(`✅ [TIMING] Bot reconnected in ${Date.now() - connectStart}ms | total latency so far: ${Date.now() - receivedAt}ms`);
    }

    // ── STEP 3: Await the REST kline open fired at STEP 1 ────────────────
    // The promise has been running in parallel since STEP 1. By now (after
    // the synchronous side-resolution + STEP 2 bot check) most or all of the
    // 80-150ms round-trip has already elapsed — await here adds near-zero wait.
    //
    // Fallback chain (if kline REST failed):
    //   WS kline cache (getCandleOpen) → WS ticker cache (getLivePrice) → REST ticker
    // The WS caches are acceptable SECONDARY fallbacks — we just don't want them
    // as the PRIMARY source (they can be null or stale at T=0 of a new candle).
    const klineAwaitStart = Date.now();
    const klineOpen = await _klinePromise;
    const klineWaitMs = Date.now() - klineAwaitStart;   // typically 0ms (already resolved)

    if (klineOpen > 0) {
        currentPrice = klineOpen;
        logger.info(
            `⚡ [TIMING] REST kline open: ${currentPrice}` +
            ` (parallel — awaited in ${klineWaitMs}ms) | since receive: ${Date.now() - receivedAt}ms`
        );
    } else {
        // Kline REST failed — secondary fallbacks
        logger.warn(`⚠️  [TIMING] REST kline failed — using WS cache fallback`);
        const wsCandle  = typeof exchangeClient.getCandleOpen === 'function'
            ? exchangeClient.getCandleOpen(signal.symbol)  : null;
        const wsTicker  = typeof exchangeClient.getLivePrice === 'function'
            ? exchangeClient.getLivePrice(signal.symbol)   : null;
        currentPrice = wsCandle || wsTicker || null;

        if (wsCandle)       logger.info(`⚡ [TIMING] WS kline cache: ${currentPrice} (fallback) | since receive: ${Date.now() - receivedAt}ms`);
        else if (wsTicker)  logger.info(`⚡ [TIMING] WS ticker cache: ${currentPrice} (fallback) | since receive: ${Date.now() - receivedAt}ms`);
    }

    // Absolute last resort: REST ticker (only if kline REST + all WS caches failed)
    if (!currentPrice) {
        const restStart = Date.now();
        currentPrice = await exchangeClient.getPrice(signal.symbol);
        logger.info(`⏱️ [TIMING] REST ticker (last resort): ${Date.now() - restStart}ms | since receive: ${Date.now() - receivedAt}ms`);
    }

    const { stopLoss: slPrice, takeProfit1: tpPrice } = executor.resolveSLTP(currentPrice, side, signal);

            logger.info(`🤖 Browser Bot: ${direction} ${signal.symbol} @ ${currentPrice} | SL=${slPrice} TP=${tpPrice} margin=$${signal.marginDollar}`);

            const tradeParams = {
                direction,
                marginUsdt: signal.marginDollar,
                leverage:   signal.leverage,
                tpPrice,
                slPrice
            };

            // Auto-recover on detached frame (MEXC page navigated while idle)
            const execStart = Date.now();
            try {
                await mexcBot.placeTrade(tradeParams);
            } catch (botErr) {
                if (/detached Frame|Execution context was destroyed|Cannot find context|Target closed/i.test(botErr.message)) {
                    logger.warn(`⚠️  Browser frame detached — reloading page and retrying… (${botErr.message})`);
                    try {
                        await mexcBot.reconnect();
                        await mexcBot.placeTrade(tradeParams);
                        logger.info('✅ Browser Bot recovered and trade executed on retry');
                    } catch (retryErr) {
                        throw new Error(`Browser Bot failed after reconnect: ${retryErr.message}`);
                    }
                } else {
                    throw botErr;
                }
            }
            const totalMs = Date.now() - receivedAt;
            logger.info(`⏱️ [TIMING] placeTrade DOM: ${Date.now() - execStart}ms | ✅ total signal→filled: ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`);

            const tradeStartTime = signal.entryTime || Date.now();
            // CTC defaults to ON — signal provider enables it per trade; only
            // explicitly set ctcEnabled:false in the payload to disable it.
            const ctcEnabled     = signal.ctcEnabled     ?? true;
            const ctcTrigger     = signal.ctcTrigger     ?? 0.5;
            // holdingCandles from signal — 0 means no holding-candle limit
            const holdingCandles = signal.holdingCandles ?? 0;

            // Notional = margin × leverage — needed for correct MEXC fee calculation
            // MEXC charges 0.01% (0.0001) per execution leg, not on pnl.
            const notional = (signal.marginDollar || 0) * (signal.leverage || 1);

            // ── Pre-generate tradeId so the response is not blocked by S3 ──
            const tradeId = crypto.randomUUID();

            // ── Fire-and-forget S3 save — does NOT block the HTTP response ──
            // softwareSLTP=false: MEXC handles TP/SL via its own exchange stop orders.
            // If we set it true, the software checker fires a REST market close on TP hit
            // which bypasses MEXC's limit TP order and causes severe slippage (-$37 vs -$6).
            storage.saveTrade({
                id: tradeId,
                symbol: signal.symbol, side, orderType: 'MARKET',
                price: currentPrice, stopLoss: slPrice, takeProfit1: tpPrice,
                rr: signal.rr || null, ctcEnabled, ctcTrigger,
                holdingCandles, tradeStartTime, signal, status: 'open', softwareSLTP: false
            }).catch(err => logger.error(`S3 save failed for ${tradeId}:`, err.message));

            monitor.addPosition(signal.symbol, {
                side, entryPrice: currentPrice, orderType: 'MARKET',
                ctcEnabled, ctcTrigger, holdingCandles, tradeStartTime,
                // ctcBasePrice = MEXC kline WS candle open (getCandleOpen()).
                // NEVER use signal.price / signal.entry — those come from Binance spot
                // which has a non-trivial basis vs MEXC futures and would misplace the
                // CTC trigger.  currentPrice is already getCandleOpen() || getLivePrice()
                // i.e. the MEXC-native candle open.  No signal payload price is used.
                ctcBasePrice: currentPrice,
                softwareSLTP: false, stopLoss: slPrice, takeProfit1: tpPrice,
                notional // margin × leverage for correct MEXC fee calculation
            });

            logger.info(`✅ Browser Bot trade executed — ID: ${tradeId}`);
            return res.json({
                success: true,
                data: {
                    tradeId, symbol: signal.symbol, side, direction,
                    price: currentPrice, stopLoss: slPrice, takeProfit1: tpPrice,
                    ctcEnabled, ctcTrigger, holdingCandles, tradeStartTime
                }
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        // Execute trade
        const result = await executor.executeTrade(signal);

        // ── Pre-generate tradeId so the response is not blocked by S3 ──
        const tradeId = crypto.randomUUID();

        // ── Fire-and-forget S3 save — does NOT block the HTTP response ──
        storage.saveTrade({
            id: tradeId,
            ...result,
            signal,
            status: signal.orderType === 'MARKET' ? 'open' : 'pending',
            ctcEnabled: result.ctcEnabled,
            ctcTrigger: result.ctcTrigger,
            holdingCandles: result.holdingCandles,
            tradeStartTime: result.tradeStartTime
        }).catch(err => logger.error(`S3 save failed for ${tradeId}:`, err.message));

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
                // ctcBasePrice = MEXC getCandleOpen() WS price already resolved into currentPrice.
                // result.price is the fill price; for CTC we need the candle open.
                // Never use signal.price/signal.entry (Binance spot ≠ MEXC futures).
                ctcBasePrice:   currentPrice || result.price,
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
 * Cancel / hide a stale trade record
 * PATCH /api/trades/:id/cancel
 * Marks status = 'cancelled' in S3 so it disappears from the Trade History table.
 * Does NOT close any exchange position.
 */
app.patch('/api/trades/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        await storage.updateTrade(id, { status: 'cancelled', cancelledAt: Date.now() });
        logger.info(`🗑️  Trade ${id} hidden (cancelled)`);
        res.json({ success: true, message: `Trade ${id} hidden` });
    } catch (error) {
        logger.error(`Error cancelling trade ${req.params.id}:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get active positions enriched with SL/TP orders and monitor data
 */
app.get('/api/positions', async (req, res) => {
    try {
        const positions = await exchangeClient.getPositions();
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
                    const orders = await exchangeClient.getOpenOrders(symbol);
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
                // ── Fallback: MEXC browser-set TP/SL are embedded in the position
                // and NOT returned as separate stop orders via getOpenOrders().
                // Fall back to the values the bot computed and stored in the monitor.
                if (!sl  && monitorPos.stopLoss)    sl  = monitorPos.stopLoss;
                if (!tp1 && monitorPos.takeProfit1) tp1 = monitorPos.takeProfit1;
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

            // Handle both Binance (unRealizedProfit) and MEXC (unrealizedProfit) field names
            const pnl    = parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? 0) || 0;
            const margin = parseFloat(p.isolatedMargin   ?? p.initialMargin    ?? 0) || 0;

            return {
                symbol,
                side: isLongPos ? 'LONG' : 'SHORT',
                quantity: Math.abs(parseFloat(p.positionAmt)),
                entryPrice,
                markPrice,
                pnl,
                pnlPercent: margin > 0 ? ((pnl / margin) * 100).toFixed(2) : '0.00',
                leveragedPnlPercent,
                margin,
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
                tpHit:           monitorPos.tpHit            || false,
                // Manual mode — user has taken over this trade, bot hands-off
                manualMode:      monitorPos.manualMode       || false
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

        // Capture snapshot PnL and notional BEFORE closing
        const positions = await exchangeClient.getPositions(symbol);
        const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        const snapshotPnl = position ? parseFloat(position.unRealizedProfit ?? position.unrealizedProfit ?? 0) : 0;

        // ── MEXC Browser Bot close ─────────────────────────────────────────
        if (MEXC_BROWSER_MODE && mexcBot) {
            if (!mexcBot.page) await mexcBot.connect();
            const isLong    = position ? parseFloat(position.positionAmt) > 0 : true;
            const direction = isLong ? 'LONG' : 'SHORT';

            const botResult = await mexcBot.closeTrade({ symbol, direction, flash: true });
            monitor.removePosition(symbol);

            // Wait 3s for MEXC to record the close before fetching realized PnL
            await new Promise(r => setTimeout(r, 3000));

            // Use exchange-confirmed realized PnL if available
            let finalPnl = snapshotPnl;
            let pnlSource = 'snapshot-unrealized';
            try {
                const histPnl = await exchangeClient.getHistoricalPnL(symbol);
                if (histPnl !== null && histPnl !== undefined) {
                    finalPnl  = histPnl;
                    pnlSource = 'mexc-history-api';
                    logger.info(`💰 Manual close PnL from MEXC history: $${finalPnl.toFixed(4)}`);
                }
            } catch (_) {}

            // Correct MEXC fee: notional × 0.0002 (0.01% per leg × 2 legs)
            const monData    = monitor.monitoredPositions.get(symbol); // may be removed already
            const closeTrades = await storage.getAllTrades();
            const openTrade  = closeTrades.find(t => t.symbol === symbol && t.status === 'open');

            const tradeNotional = (openTrade?.signal?.marginDollar || 0) * (openTrade?.signal?.leverage || 1);
            const fees    = tradeNotional > 0 ? tradeNotional * 0.0002 : Math.abs(snapshotPnl) * 0.05;
            const netPnL  = finalPnl - fees;

            if (openTrade) {
                await storage.updateTrade(openTrade.id, {
                    status: 'closed', closedAt: Date.now(),
                    closeReason: 'manual', pnl: finalPnl, fees, netPnL, pnlSource
                });
                logger.info(`Trade ${openTrade.id} closed manually: gross=$${finalPnl.toFixed(2)} fees=$${fees.toFixed(2)} net=$${netPnL.toFixed(2)} [${pnlSource}]`);
            }
            return res.json({ success: true, data: botResult, pnl: finalPnl, fees, netPnL });
        }
        // ──────────────────────────────────────────────────────────────────

        const result = await executor.closePosition(symbol, 'manual');
        monitor.removePosition(symbol);

        // Update trade record — Binance/testnet path
        const trades = await storage.getAllTrades();
        const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
        const tradeNotional = (openTrade?.signal?.marginDollar || 0) * (openTrade?.signal?.leverage || 1);
        const fees    = tradeNotional > 0 ? tradeNotional * 0.0002 : Math.abs(snapshotPnl) * 0.05;
        const netPnL  = snapshotPnl - fees;
        if (openTrade) {
            await storage.updateTrade(openTrade.id, {
                status: 'closed', closedAt: Date.now(),
                closeReason: 'manual', pnl: snapshotPnl, fees, netPnL
            });
            logger.info(`Trade ${openTrade.id} closed manually: PnL=$${snapshotPnl.toFixed(2)}`);
        }

        res.json({ success: true, data: result, pnl: snapshotPnl, fees, netPnL });
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
 * ─────────────────────────────────────────────
 * MANUAL MODE ENDPOINT
 * ─────────────────────────────────────────────
 *
 * Toggle manual-mode (Stop Monitor) for an active position.
 * Body: { "enabled": true | false }
 *
 * When enabled=true:
 *   - Bot suspends ALL automated actions: holding-candle close, CTC,
 *     SL guardian, software SL/TP. The position stays tracked so the
 *     dashboard still shows live PnL and the dedup guard stays active.
 *   - User is responsible for managing the trade directly on MEXC.
 * When enabled=false — normal bot behavior resumes immediately.
 */
app.post('/api/positions/:symbol/manual-mode', async (req, res) => {
    try {
        const { enabled } = req.body;
        const { symbol } = req.params;

        if (typeof enabled === 'undefined') {
            return res.status(400).json({ success: false, error: 'Missing: enabled (boolean)' });
        }

        const result = monitor.setManualMode(symbol, !!enabled);
        if (result) {
            logger.info(`🎮 Manual mode ${!!enabled ? 'ENABLED' : 'DISABLED'} for ${symbol} via dashboard`);
            res.json({
                success: true,
                message: `${symbol} manual mode ${!!enabled ? 'ENABLED — bot standing by' : 'DISABLED — bot resuming'}`,
                data: { symbol, manualMode: !!enabled }
            });
        } else {
            res.status(404).json({ success: false, error: `Position ${symbol} not found in monitor` });
        }
    } catch (error) {
        logger.error(`Error toggling manual mode for ${req.params.symbol}:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
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
            // ── Persist holdingEnabled to S3 so it survives server restart ──
            // Without this, a manual "disable holding" toggle is lost on restart
            // because initializeMonitor re-derives holdingEnabled from holdingCandles > 0.
            try {
                const trades    = await storage.getAllTrades();
                const openTrade = trades.find(t => t.symbol === symbol && t.status === 'open');
                if (openTrade) {
                    await storage.updateTrade(openTrade.id, { holdingEnabled: !!enabled });
                    logger.info(`💾 holdingEnabled=${!!enabled} persisted to trade ${openTrade.id}`);
                }
            } catch (persistErr) {
                logger.warn(`⚠️ Could not persist holdingEnabled for ${symbol}: ${persistErr.message}`);
            }

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
 * ─────────────────────────────────────────────
 * EDIT SL / TP for an active position
 * ─────────────────────────────────────────────
 *
 * Body: { stopLoss?: number, takeProfit1?: number }
 *   - At least one of stopLoss / takeProfit1 must be provided.
 *   - Omit a field to keep it unchanged.
 *
 * History policy:
 *   - Original trade.stopLoss / trade.takeProfit1 are NEVER overwritten.
 *   - Adjustment is appended to trade.slTpAdjustments[].
 *   - trade.currentSL / trade.currentTP reflect the live levels.
 */
app.post('/api/positions/:symbol/sl-tp', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { stopLoss, takeProfit1 } = req.body;

        if (stopLoss === undefined && takeProfit1 === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Provide at least one of: stopLoss, takeProfit1'
            });
        }

        const newSL = stopLoss   !== undefined ? parseFloat(stopLoss)   : null;
        const newTP = takeProfit1 !== undefined ? parseFloat(takeProfit1) : null;

        if (newSL !== null && isNaN(newSL)) {
            return res.status(400).json({ success: false, error: 'stopLoss must be a valid number' });
        }
        if (newTP !== null && isNaN(newTP)) {
            return res.status(400).json({ success: false, error: 'takeProfit1 must be a valid number' });
        }
        if (newSL !== null && newSL <= 0) {
            return res.status(400).json({ success: false, error: 'stopLoss must be > 0' });
        }
        if (newTP !== null && newTP <= 0) {
            return res.status(400).json({ success: false, error: 'takeProfit1 must be > 0' });
        }

        // ── MEXC Browser Bot: update TP/SL via UI ─────────────────────────
        if (MEXC_BROWSER_MODE && mexcBot) {
            if (!mexcBot.page) await mexcBot.connect();
            const posData   = monitor.monitoredPositions.get(symbol);
            const direction = posData?.side || 'LONG';
            const botResult = await mexcBot.updateTpSl({
                symbol,
                direction,
                tpPrice: newTP || undefined,
                slPrice: newSL || undefined
            });
            // Sync monitor in-memory state so the dashboard reflects new values
            if (posData) {
                monitor.monitoredPositions.set(symbol, {
                    ...posData,
                    ...(newSL !== null ? { stopLoss:    newSL } : {}),
                    ...(newTP !== null ? { takeProfit1: newTP } : {})
                });
            }
            logger.info(`✏️ SL/TP updated via browser bot for ${symbol}: SL=${newSL} TP=${newTP}`);
            return res.json({
                success: true,
                message: `SL/TP updated for ${symbol}`,
                data: { newSL, newTP, ...botResult }
            });
        }
        // ──────────────────────────────────────────────────────────────────

        const result = await monitor.updateSLTP(symbol, newSL, newTP);

        if (result.success) {
            logger.info(`✏️ SL/TP updated for ${symbol}: SL=${result.newSL} TP=${result.newTP}`);
            res.json({
                success: true,
                message: `SL/TP updated for ${symbol}`,
                data: result
            });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.error(`Error updating SL/TP for ${req.params.symbol}:`, error.message);
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

// ── /api/ping — lightweight keep-alive probe ─────────────────────────────────
//
//  Used by signalAlertEngine.js ConnectionWarmer on EC2.
//
//  WHY NOT /api/status:
//    /api/status calls getBalance() + getPositions() (REST round-trip to MEXC).
//    At candle-close time MEXC is busy; those calls can take 5+ seconds.
//    The background warmer interval lands at exactly T+0.5s after every candle
//    close (startup offset makes the 30s timer align with each 3-min boundary).
//    With maxSockets:1 on the EC2 agent, the warmer holds the ONLY socket for
//    5+ seconds — the trade POST arriving at T=0 is QUEUED behind it.
//    When the 5-second axios timeout kills the warmer request, the socket is
//    destroyed; the trade then needs a brand-new SSH channel: ~6.7s cold start.
//
//  FIX:
//    /api/ping returns {ok:true} in < 1ms (zero MEXC API calls, no auth needed).
//    The warmer completes before the trade even arrives → socket stays alive and
//    free → trade reuses the warm socket → < 0.1s connection overhead.
//
//  No auth token required: there is nothing sensitive to protect here; the
//  endpoint reveals only the server timestamp.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

// Start server
const server = app.listen(PORT, () => {
    logger.info(`🌐 Dashboard server running on http://localhost:${PORT}`);
    logger.info(`📊 Open your browser to access the dashboard`);
});

// Keep HTTP keep-alive sockets open for 65s.
// The SSH reverse-tunnel connection warmer on EC2 pings every 30s using the
// same persistent socket.  Node.js defaults keepAliveTimeout to 5s, which
// closes the socket before the next ping arrives → ECONNABORTED on every
// ping → no warming benefit.  65s > 30s interval ensures the socket stays
// alive between pings so the warmer always reuses it (0ms connection cost).
server.keepAliveTimeout = 65000;  // 65s — survives one 30s ping interval
server.headersTimeout   = 66000;  // must be slightly > keepAliveTimeout

// Handle graceful shutdown
async function shutdown() {
    logger.info('\n🛑 Shutting down dashboard server...');
    monitor.stop();
    if (mexcBot) {
        try { await mexcBot.disconnect(); } catch (_) {}
    }
    process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Crash safety net — log the actual error before dying ────────────────────
process.on('uncaughtException', (err) => {
    logger.error(`💀 UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stk = reason instanceof Error ? reason.stack  : '';
    logger.error(`💀 UNHANDLED REJECTION: ${msg}\n${stk}`);
    process.exit(1);
});
