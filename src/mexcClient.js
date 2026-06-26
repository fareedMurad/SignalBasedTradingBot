/**
 * MEXC Futures Client
 * Implements the same interface as BinanceClient so every consumer
 * (TradeExecutor, PositionMonitor, dashboard/server.js) works unchanged.
 *
 * MEXC Futures REST API: https://contract.mexc.com/api/v1/…
 *
 * Two modes controlled by USE_DEMO_ENV in .env:
 *   USE_DEMO_ENV=true  → MEXC Demo account (same URL, different API keys)
 *   USE_DEMO_ENV=false → MEXC Live account
 *
 * SL/TP strategy: Software SL/TP (same as Binance testnet).
 *   isTestnet() always returns true so positionMonitor uses price-polling.
 *
 * Symbol mapping: BTCUSDT ↔ BTC_USDT (underscore convention on MEXC)
 */

const https  = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const MEXC_HOST   = 'contract.mexc.com';
const MEXC_WS_URL = 'wss://contract.mexc.com/edge';

class MexcClient {
    constructor(config, logger) {
        this.config    = config;
        this.logger    = logger;
        this.apiKey    = config.mexcApiKey    || config.apiKey;    // fallback to generic keys
        this.apiSecret = config.mexcApiSecret || config.apiSecret;
        this.isDemo    = config.useDemoEnv === true || config.useDemoEnv === 'true';

        this._contractCache    = null;
        this._contractCacheTs  = 0;

        // ── Live price cache — populated by WS kline/ticker (avoids REST round-trip) ──
        this._livePriceCache  = new Map();   // symbol → { price, updatedAt }       (last trade price)
        this._candleOpenCache = new Map();   // symbol → { price, updatedAt, candleTs }  (3m candle OPEN)
        this._wsWatchers      = new Map();   // symbol → WebSocket instance

        this.initialize();
    }

    initialize() {
        const mode = this.isDemo ? '🧪 DEMO' : '💰 LIVE';
        this.logger.info(`${mode} MEXC Mode: contract.mexc.com`);
        if (this.isDemo) {
            this.logger.info('✅ Software SL/TP active for MEXC demo');
        } else {
            this.logger.info('⚠️  MEXC LIVE mode — REAL MONEY TRADING!');
            this.logger.info('✅ Software SL/TP active for MEXC live');
        }
        this.logger.info(`✅ MEXC Futures client initialized [${this.isDemo ? 'DEMO' : 'LIVE'}]`);
    }

    /**
     * positionMonitor checks isTestnet() to decide between
     * software SL/TP (true) or exchange conditional orders (false).
     * We always return true for MEXC — software SL/TP on both demo and live.
     */
    isTestnet() { return true; }

    // ─────────────────────────────────────────────────────────────────────────
    //  Symbol helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** BTCUSDT → BTC_USDT */
    _toMexc(sym) {
        if (!sym || sym.includes('_')) return sym;
        // Handle common quote assets
        for (const q of ['USDT', 'USDC', 'BTC', 'ETH', 'BNB']) {
            if (sym.endsWith(q)) {
                return sym.slice(0, -q.length) + '_' + q;
            }
        }
        return sym;
    }

    /** BTC_USDT → BTCUSDT */
    _fromMexc(sym) {
        return sym ? sym.replace(/_/g, '') : sym;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HTTP helpers
    // ─────────────────────────────────────────────────────────────────────────

    _sign(str) {
        return crypto.createHmac('sha256', this.apiSecret).update(str).digest('hex');
    }

    /**
     * Authenticated request with automatic retry for transient network errors.
     * MEXC signature: HmacSHA256( apiKey + RequestTime + paramString )
     *   GET / DELETE → paramString = sorted query string (without ?)
     *   POST         → paramString = JSON.stringify(body)
     *
     * Retries on: ENOTFOUND, ECONNRESET, ETIMEDOUT, ECONNREFUSED, ECONNABORTED
     *   - 3 attempts total
     *   - Backoff: 1s → 2s → give up
     *   - No retry on MEXC API errors (4xx/5xx business logic errors)
     */
    async _req(method, path, params = {}, _attempt = 1) {
        const ts = Date.now().toString();
        let url  = path;
        let body = '';
        const headers = {
            'ApiKey'       : this.apiKey,
            'Request-Time' : ts,
            'Content-Type' : 'application/json'
        };

        if (method === 'GET' || method === 'DELETE') {
            const qs = Object.keys(params).length
                ? new URLSearchParams(params).toString()
                : '';
            headers['Signature'] = this._sign(this.apiKey + ts + qs);
            url = qs ? `${path}?${qs}` : path;
        } else {
            body = Object.keys(params).length ? JSON.stringify(params) : '';
            headers['Signature']      = this._sign(this.apiKey + ts + body);
            headers['Content-Length'] = Buffer.byteLength(body || '');
        }

        const RETRYABLE = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED'];
        const MAX_ATTEMPTS = 3;
        const BACKOFF_MS   = [0, 1000, 2000]; // indexed by attempt (1-based)

        try {
            return await new Promise((resolve, reject) => {
                const req = https.request(
                    { hostname: MEXC_HOST, path: url, method, headers },
                    (res) => {
                        let data = '';
                        res.on('data', c => data += c);
                        res.on('end', () => {
                            let json;
                            try { json = JSON.parse(data); } catch (e) {
                                return reject(new Error(`MEXC parse error: ${data.slice(0, 200)}`));
                            }
                            if (json.code !== 0 && json.code !== undefined) {
                                return reject(new Error(`MEXC API ${json.code}: ${json.msg || 'unknown'}`));
                            }
                            resolve(json.data !== undefined ? json.data : json);
                        });
                    }
                );
                req.on('error', reject);
                if (body) req.write(body);
                req.end();
            });
        } catch (err) {
            const isNetworkErr = RETRYABLE.some(code => err.code === code || (err.message || '').includes(code));
            if (isNetworkErr && _attempt < MAX_ATTEMPTS) {
                const delay = BACKOFF_MS[_attempt] || 2000;
                this.logger.warn(`⚠️ MEXC network error (${err.code || err.message}) — retrying in ${delay}ms (attempt ${_attempt}/${MAX_ATTEMPTS - 1})`);
                await new Promise(r => setTimeout(r, delay));
                return this._req(method, path, params, _attempt + 1);
            }
            throw err;
        }
    }

    /** Public (unauthenticated) GET */
    async _pub(path, params = {}) {
        const qs = Object.keys(params).length
            ? '?' + new URLSearchParams(params).toString()
            : '';
        return new Promise((resolve, reject) => {
            const req = https.request(
                { hostname: MEXC_HOST, path: path + qs, method: 'GET',
                  headers: { 'Content-Type': 'application/json' } },
                (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        let json;
                        try { json = JSON.parse(data); } catch (e) {
                            return reject(new Error(`MEXC parse error: ${data.slice(0, 200)}`));
                        }
                        if (json.code !== 0 && json.code !== undefined) {
                            return reject(new Error(`MEXC API ${json.code}: ${json.msg || 'unknown'}`));
                        }
                        resolve(json.data !== undefined ? json.data : json);
                    });
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Contract detail cache (public endpoint, 10-min TTL)
    // ─────────────────────────────────────────────────────────────────────────

    async _contracts() {
        const now = Date.now();
        if (this._contractCache && now - this._contractCacheTs < 10 * 60 * 1000) {
            return this._contractCache;
        }
        const list = await this._pub('/api/v1/contract/detail');
        const idx = {};
        for (const c of (list || [])) {
            idx[c.symbol] = c;                         // BTC_USDT
            idx[this._fromMexc(c.symbol)] = c;         // BTCUSDT
        }
        this._contractCache   = idx;
        this._contractCacheTs = now;
        return idx;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public interface — mirrors BinanceClient
    // ─────────────────────────────────────────────────────────────────────────

    /** Get USDT available / total balance */
    async getBalance() {
        try {
            const d = await this._req('GET', '/api/v1/private/account/asset/USDT');
            return {
                available : parseFloat(d.availableBalance ?? d.available   ?? 0),
                total     : parseFloat(d.equity          ?? d.cashBalance  ?? d.available ?? 0)
            };
        } catch (err) {
            this.logger.error('MEXC getBalance:', err.message);
            throw err;
        }
    }

    /** List all active USDT-margined futures symbols */
    async getAvailableSymbols() {
        try {
            const contracts = await this._contracts();
            return Object.values(contracts)
                .filter(c => c.symbol && c.symbol.endsWith('_USDT') && c.state === 0)
                // deduplicate (we stored each contract twice: MEXC + Binance key)
                .filter((c, i, a) => a.findIndex(x => x.symbol === c.symbol) === i)
                .map(c => ({
                    symbol          : this._fromMexc(c.symbol),
                    baseAsset       : c.symbol.split('_')[0],
                    pricePrecision  : c.pricePrecision  ?? 2,
                    quantityPrecision: c.volPrecision   ?? 0
                }));
        } catch (err) {
            this.logger.error('MEXC getAvailableSymbols:', err.message);
            throw err;
        }
    }

    /** Get detailed info for one symbol */
    async getSymbolInfo(symbol) {
        try {
            const contracts  = await this._contracts();
            const c          = contracts[this._toMexc(symbol)] || contracts[symbol];
            if (!c) throw new Error(`Symbol ${symbol} not found on MEXC`);

            const contractSize = parseFloat(c.contractSize ?? 1);
            const maxLeverage  = parseFloat(c.maxLeverage  ?? 200);

            return {
                symbol,
                mexcSymbol       : c.symbol,
                pricePrecision   : c.pricePrecision  ?? 2,
                quantityPrecision: c.volPrecision    ?? 0,
                contractSize,
                stepSize         : contractSize,          // 1 contract = contractSize base coins
                tickSize         : Math.pow(10, -(c.pricePrecision ?? 2)),
                minQuantity      : contractSize,
                maxQuantity      : parseFloat(c.maxVol ?? 100000) * contractSize,
                minNotional      : 1,
                maxLeverage
            };
        } catch (err) {
            this.logger.error(`MEXC getSymbolInfo [${symbol}]:`, err.message);
            throw err;
        }
    }

    /**
     * Get max leverage for symbol.
     * Called by dashboard/server.js /api/symbol-info/:symbol route.
     */
    async getMaxLeverage(symbol) {
        const info = await this.getSymbolInfo(symbol);
        return info.maxLeverage;
    }

    /** Current mark price — REST fallback (use getLivePrice() for 0ms cached version) */
    async getPrice(symbol) {
        try {
            const d = await this._pub('/api/v1/contract/ticker', { symbol: this._toMexc(symbol) });
            const price = parseFloat(d.lastPrice ?? d.last ?? 0);
            // Also update cache so getLivePrice() is always fresh
            if (price > 0) {
                this._livePriceCache.set(this._toMexc(symbol), { price, updatedAt: Date.now() });
                this._livePriceCache.set(symbol, { price, updatedAt: Date.now() });
            }
            return price;
        } catch (err) {
            this.logger.error(`MEXC getPrice [${symbol}]:`, err.message);
            throw err;
        }
    }

    /**
     * Fetch the OPEN price of the current 3-minute candle via REST (live, not cache).
     *
     * WHY THIS INSTEAD OF getCandleOpen() (WS cache):
     *   The WS push.kline message for a NEW candle fires ~200ms AFTER the candle opens.
     *   Signals fire at T=0ms of the new candle. In that 0-200ms window getCandleOpen()
     *   returns null (stale guard) and the code falls back to the live ticker — which has
     *   already moved from the candle open. This creates SL drift (observed: 53 pts on BTC).
     *
     * WHY NOT the signal payload price:
     *   capie-mvp runs on Binance.US data. The MEXC futures price has a non-trivial basis
     *   vs Binance.US spot (20-80 USDT on BTC). Using a payload price would misplace SL/TP.
     *
     * This method: hits the public MEXC kline REST endpoint — no auth, no signing overhead.
     * Typical round-trip from Mac: 80-150ms. Fired in PARALLEL with the bot connection
     * check so it adds near-zero extra latency in the normal (bot-already-connected) case.
     *
     * Also updates the in-memory WS cache so getCandleOpen() and positionMonitor
     * (CTC trigger price) stay fresh after the REST call.
     *
     * @param {string} symbol   e.g. 'BTCUSDT' or 'BTC_USDT'
     * @returns {Promise<number>}  open price of the current 3m candle, or 0 on failure
     */
    async getCandleOpenREST(symbol) {
        const mexcSym = this._toMexc(symbol);
        try {
            // /api/v1/contract/kline/<symbol>?interval=Min3&limit=1
            // Returns { time:[...], open:[...], close:[...], high:[...], low:[...], vol:[...] }
            // limit=1 → only the current (most recent) candle
            const klineData = await this._pub(
                `/api/v1/contract/kline/${mexcSym}`,
                { interval: 'Min3', limit: 1 }
            );

            let openPrice = 0;
            if (Array.isArray(klineData?.open) && klineData.open.length > 0) {
                openPrice = parseFloat(klineData.open[0]);
            } else if (klineData?.open != null && !Array.isArray(klineData.open)) {
                openPrice = parseFloat(klineData.open);   // scalar fallback
            }

            if (openPrice > 0) {
                // Update WS candle-open cache — keeps getCandleOpen() / CTC trigger fresh
                const now = Date.now();
                this._candleOpenCache.set(mexcSym,               { price: openPrice, updatedAt: now });
                this._candleOpenCache.set(this._fromMexc(mexcSym), { price: openPrice, updatedAt: now });
                // Also update symbol key as-provided (covers both BTCUSDT and BTC_USDT callers)
                if (symbol !== mexcSym && symbol !== this._fromMexc(mexcSym)) {
                    this._candleOpenCache.set(symbol, { price: openPrice, updatedAt: now });
                }
            }

            return openPrice;
        } catch (err) {
            this.logger.warn(`⚠️  getCandleOpenREST [${symbol}]: ${err.message} — caller will use fallback`);
            return 0;   // never throw — caller has fallback chain
        }
    }

    /**
     * Return the OPEN price of the current 3-minute MEXC candle (0ms, from WS cache).
     * This is the correct reference price for SL/TP computation:
     *   - Signal fires at 3m candle CLOSE → new candle OPEN = that close price
     *   - Using the candle open ensures SL/TP are anchored to the actual MEXC entry bar
     *   - Stale guard: returns null if data is >15s old (3m candle still forming) or WS not connected
     * Falls back to getLivePrice() → REST in server.js
     */
    getCandleOpen(symbol) {
        const key    = this._toMexc(symbol);
        const cached = this._candleOpenCache.get(key) || this._candleOpenCache.get(symbol);
        if (!cached) return null;
        if (Date.now() - cached.updatedAt > 15000) return null; // stale — new candle may have opened
        return cached.price;
    }

    /**
     * Return the last trade price from WS ticker cache (0ms latency).
     * Returns null if WS not started or data is stale (>5s old).
     * Used as fallback when candle open is not yet available.
     */
    getLivePrice(symbol) {
        const key    = this._toMexc(symbol);
        const cached = this._livePriceCache.get(key) || this._livePriceCache.get(symbol);
        if (!cached) return null;
        if (Date.now() - cached.updatedAt > 5000) return null; // stale — fall back to REST
        return cached.price;
    }

    /**
     * Subscribe to MEXC 3m kline + ticker WebSocket for live price updates.
     *
     * Two channels subscribed per symbol:
     *   1. push.kline (Min3) → caches the candle OPEN price (used for SL/TP reference)
     *   2. push.ticker       → caches the last trade price (used as fallback)
     *
     * Candle open is available within ~200ms of the new candle forming.
     * Auto-reconnects on disconnect with exponential backoff.
     *
     * Usage (in server.js after creating exchangeClient):
     *   exchangeClient.startPriceWatcher(['BTCUSDT']);
     *
     * @param {string[]} symbols  e.g. ['BTCUSDT', 'ETHUSDT']
     */
    startPriceWatcher(symbols = []) {
        for (const symbol of symbols) {
            this._connectPriceWatcher(symbol, 0);
        }
    }

    _connectPriceWatcher(symbol, retryCount) {
        const mexcSym = this._toMexc(symbol);
        const backoff = Math.min(1000 * Math.pow(2, retryCount), 30000); // max 30s

        try {
            const ws = new WebSocket(MEXC_WS_URL);
            this._wsWatchers.set(symbol, ws);

            ws.on('open', () => {
                this.logger.info(`📡 WS kline+ticker subscribed for ${symbol} (${mexcSym})`);
                // ── Subscribe to 3-minute kline — gives candle OPEN price ────────────
                ws.send(JSON.stringify({ method: 'sub.kline', param: { symbol: mexcSym, interval: 'Min3' } }));
                // ── Subscribe to ticker — gives last trade price as fallback ─────────
                ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: mexcSym } }));
                // ── Heartbeat every 15s to keep connection alive ──────────────────────
                ws._pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ method: 'ping' }));
                    }
                }, 15000);
            });

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);

                    // ── 3m kline update — cache the candle OPEN price ─────────────────
                    // 'o' = open, 'c' = close, 'h' = high, 'l' = low of current candle
                    if (msg.channel === 'push.kline' && msg.data) {
                        const open    = parseFloat(msg.data.o ?? msg.data.open ?? 0);
                        const symRaw  = msg.data.symbol; // BTC_USDT
                        if (open > 0 && symRaw) {
                            const now = Date.now();
                            const entry = { price: open, updatedAt: now, candleTs: msg.data.t ?? now };
                            this._candleOpenCache.set(symRaw, entry);
                            this._candleOpenCache.set(this._fromMexc(symRaw), entry);
                            this.logger.debug(`📊 3m candle open cached for ${symRaw}: ${open}`);
                        }
                    }

                    // ── Ticker update — cache the last trade price as fallback ─────────
                    if (msg.channel === 'push.ticker' && msg.data) {
                        const price  = parseFloat(msg.data.lastPrice ?? msg.data.last ?? 0);
                        const symRaw = msg.data.symbol; // BTC_USDT
                        if (price > 0 && symRaw) {
                            const now = Date.now();
                            this._livePriceCache.set(symRaw, { price, updatedAt: now });
                            this._livePriceCache.set(this._fromMexc(symRaw), { price, updatedAt: now });
                        }
                    }
                } catch (_) {}
            });

            ws.on('close', () => {
                clearInterval(ws._pingInterval);
                this.logger.warn(`⚠️ WS closed for ${symbol} — reconnecting in ${backoff}ms`);
                setTimeout(() => this._connectPriceWatcher(symbol, retryCount + 1), backoff);
            });

            ws.on('error', (err) => {
                this.logger.warn(`⚠️ WS error for ${symbol}: ${err.message}`);
                // 'close' event fires after 'error', which triggers reconnect
            });

        } catch (err) {
            this.logger.warn(`⚠️ WS connect failed for ${symbol}: ${err.message} — retry in ${backoff}ms`);
            setTimeout(() => this._connectPriceWatcher(symbol, retryCount + 1), backoff);
        }
    }

    /** Change leverage for an open or future position */
    async setLeverage(symbol, leverage) {
        try {
            // MEXC requires positionType (1=long,2=short); try both silently
            for (const positionType of [1, 2]) {
                try {
                    await this._req('POST', '/api/v1/private/position/change_leverage', {
                        symbol      : this._toMexc(symbol),
                        leverage    : parseInt(leverage),
                        openType    : 1,           // isolated (override per-order too)
                        positionType
                    });
                } catch (_) { /* ignore "no position" errors */ }
            }
            this.logger.info(`Leverage set to ${leverage}x for ${symbol}`);
        } catch (err) {
            if (/same|already|no.*need/i.test(err.message)) {
                this.logger.debug(`MEXC: leverage already ${leverage}x for ${symbol}`);
            } else {
                this.logger.error(`MEXC setLeverage [${symbol}]:`, err.message);
                throw err;
            }
        }
    }

    /**
     * Set margin type.
     * On MEXC the margin mode (isolated/cross) is set per order via openType field.
     * This method is a no-op but kept for interface compatibility.
     */
    async setMarginType(symbol, marginType) {
        this.logger.debug(`MEXC: marginType=${marginType} applied per-order for ${symbol}`);
    }

    /**
     * Place an order using the NEW /order/create endpoint.
     *
     * MEXC side mapping (order/create):
     *   1 = open long    (BUY to open)
     *   2 = close short  (BUY to close short)
     *   3 = open short   (SELL to open)
     *   4 = close long   (SELL to close long)
     *
     * For OPEN orders: stopLossPrice + takeProfitPrice are embedded directly
     * so they appear in MEXC app immediately on fill.
     *
     * For CLOSE orders: use flashClose=true (market taker) via /order/create.
     * Falls back to /position/close_all if /order/create close fails.
     */
    async placeOrder(params) {
        try {
            const mexcSym    = this._toMexc(params.symbol);
            const contracts  = await this._contracts();
            const c          = contracts[mexcSym] || contracts[params.symbol] || {};
            const contractSz = parseFloat(c.contractSize ?? 1);

            // ── Side mapping ─────────────────────────────────────────────────
            // order/create: 1=open long, 2=close short, 3=open short, 4=close long
            const isReduce = params.reduceOnly === true || params.reduceOnly === 'true';
            const bSide    = (params.side || 'BUY').toUpperCase();
            let mexcSide;
            if (isReduce) {
                // close short = side 2 (BUY to close); close long = side 4 (SELL to close)
                mexcSide = bSide === 'BUY' ? 2 : 4;
            } else {
                mexcSide = bSide === 'BUY' ? 1 : 3;
            }

            // ── CLOSE ORDERS via /order/create with flashClose=true ───────────
            if (isReduce || mexcSide === 2 || mexcSide === 4) {
                try {
                    const closeSide = mexcSide === 2 ? 2 : 4;  // close short or close long
                    const orderId = await this._req('POST', '/api/v1/private/order/create', {
                        symbol    : mexcSym,
                        vol       : Math.max(1, Math.floor(parseFloat(params.quantity ?? 0) / contractSz)),
                        side      : closeSide,
                        type      : 5,        // market
                        openType  : params.openType ?? 1,
                        flashClose: true
                    });
                    this.logger.info(`✅ MEXC position closed for ${params.symbol} via /order/create [flashClose]`);
                    return {
                        orderId : orderId || Date.now().toString(),
                        symbol  : params.symbol,
                        side    : params.side,
                        type    : 'MARKET',
                        origQty : String(params.quantity ?? 0),
                        status  : 'FILLED'
                    };
                } catch (closeErr) {
                    // Fallback: /position/close_all (proven to work)
                    this.logger.warn(`⚠️ /order/create close failed (${closeErr.message}), using /position/close_all fallback`);
                    await this._req('POST', '/api/v1/private/position/close_all', { symbol: mexcSym });
                    this.logger.info(`✅ MEXC position closed for ${params.symbol} via /position/close_all`);
                    return {
                        orderId : Date.now().toString(),
                        symbol  : params.symbol,
                        side    : params.side,
                        type    : 'MARKET',
                        origQty : String(params.quantity ?? 0),
                        status  : 'FILLED'
                    };
                }
            }

            // ── OPEN ORDERS via /order/create ─────────────────────────────────
            const mexcType = (params.type || 'MARKET') === 'LIMIT' ? 1 : 5;
            const qtyBase  = parseFloat(params.quantity ?? 0);
            const vol      = Math.max(1, Math.floor(qtyBase / contractSz));
            const openType = params.openType ??
                ((this.config.riskMode || 'isolated') === 'isolated' ? 1 : 2);

            const body = {
                symbol  : mexcSym,
                vol,
                leverage: parseInt(params.leverage ?? this.config.leverage ?? 10),
                side    : mexcSide,
                type    : mexcType,
                openType,
                ...(mexcType === 1 ? { price: parseFloat(params.price ?? 0) } : {})
            };

            // Embed SL/TP directly in open order (makes them visible in MEXC app)
            if (params.stopLossPrice && params.stopLossPrice > 0) {
                body.stopLossPrice = params.stopLossPrice;
                body.lossTrend     = 1;  // 1=latest price
            }
            if (params.takeProfitPrice && params.takeProfitPrice > 0) {
                body.takeProfitPrice = params.takeProfitPrice;
                body.profitTrend     = 1;  // 1=latest price
            }

            // /order/create returns {orderId: "...", ts: ...} or a plain string
            const result  = await this._req('POST', '/api/v1/private/order/create', body);
            const orderId = (result && typeof result === 'object' && result.orderId)
                ? result.orderId
                : result;
            this.logger.info(`✅ MEXC order created via /order/create — orderId: ${orderId}`);

            return {
                orderId : orderId,
                symbol  : params.symbol,
                side    : params.side,
                type    : params.type,
                origQty : qtyBase.toString(),
                status  : 'NEW'
            };
        } catch (err) {
            this.logger.error('MEXC placeOrder:', err.message);
            throw err;
        }
    }

    /**
     * Place TP/SL order tied to an open position by positionId.
     * Uses POST /api/v1/private/stoporder/place
     * This makes SL/TP visible in the MEXC app's position view.
     *
     * @param {string|number} positionId  - from getPositions()._positionId
     * @param {number}        vol         - contract quantity (same as position holdVol)
     * @param {number|null}   slPrice     - stop-loss price (null to skip)
     * @param {number|null}   tpPrice     - take-profit price (null to skip)
     * @returns {Promise<string|null>}     - TP/SL order ID or null on failure
     */
    async setPositionSLTP(positionId, vol, slPrice, tpPrice) {
        if (!positionId) {
            this.logger.warn('⚠️ setPositionSLTP: no positionId — skipping exchange SL/TP');
            return null;
        }
        if (!slPrice && !tpPrice) {
            this.logger.warn('⚠️ setPositionSLTP: both slPrice and tpPrice are null — skipping');
            return null;
        }
        try {
            const body = {
                positionId  : positionId,
                vol         : vol,
                lossTrend   : 1,    // 1=latest price
                profitTrend : 1     // 1=latest price
            };
            if (slPrice && slPrice > 0) {
                body.stopLossPrice = slPrice;
                body.stopLossType  = 0;  // 0=market SL
            }
            if (tpPrice && tpPrice > 0) {
                body.takeProfitPrice = tpPrice;
                body.takeProfitType  = 0;  // 0=market TP
            }

            const result = await this._req('POST', '/api/v1/private/stoporder/place', body);
            this.logger.info(
                `🎯 Exchange SL/TP set for positionId=${positionId}: ` +
                `SL=${slPrice ?? 'none'} TP=${tpPrice ?? 'none'} → stopOrderId=${result}`
            );
            return result;
        } catch (err) {
            // 5004 = "stop order already exists for this position" (created by /order/create embedding)
            // Treat as success — the exchange SL/TP is already set
            if (err.message && err.message.includes('5004')) {
                this.logger.info(
                    `ℹ️ Exchange SL/TP already exists for positionId=${positionId} (set via /order/create) — OK`
                );
                return 'existing';
            }
            // Non-fatal — software SL/TP polling will handle it
            this.logger.warn(`⚠️ setPositionSLTP failed (positionId=${positionId}): ${err.message} — software SL/TP active as backup`);
            return null;
        }
    }

    /**
     * Cancel all TP/SL orders for a symbol (called when closing position)
     */
    async cancelPositionSLTP(symbol) {
        try {
            await this._req('POST', '/api/v1/private/stoporder/cancel_all', {
                symbol: this._toMexc(symbol)
            });
            this.logger.debug(`Cancelled exchange SL/TP orders for ${symbol}`);
        } catch (err) {
            this.logger.debug(`cancelPositionSLTP for ${symbol}: ${err.message}`);
        }
    }

    /**
     * Get current (open/untriggered) stop orders for a symbol.
     * Uses GET /api/v1/private/stoporder/open_orders
     */
    async getStopOrders(symbol) {
        try {
            const params = symbol ? { symbol: this._toMexc(symbol) } : {};
            const data   = await this._req('GET', '/api/v1/private/stoporder/open_orders', params);
            return Array.isArray(data) ? data : (data?.resultList ?? []);
        } catch (err) {
            this.logger.error(`MEXC getStopOrders [${symbol}]:`, err.message);
            return [];
        }
    }

    /** Get open orders for a symbol */
    async getOpenOrders(symbol) {
        try {
            const mexcSym = this._toMexc(symbol);
            const data    = await this._req('GET', `/api/v1/private/order/list/open_orders/${mexcSym}`);
            // MEXC may wrap in { resultList: [...] }
            const list    = Array.isArray(data) ? data : (data?.resultList ?? []);
            return list.map(o => ({
                orderId     : o.orderId ?? o.id,
                symbol,
                side        : (o.side === 1 || o.side === 4) ? 'BUY' : 'SELL',
                type        : o.type === 1 ? 'LIMIT' : 'MARKET',
                origQty     : String(o.vol       ?? 0),
                executedQty : String(o.dealVol   ?? 0),
                status      : o.state === 2 ? 'FILLED' : 'NEW',
                price       : String(o.price     ?? 0)
            }));
        } catch (err) {
            this.logger.error(`MEXC getOpenOrders [${symbol}]:`, err.message);
            throw err;
        }
    }

    /** Cancel a single order */
    async cancelOrder(symbol, orderId) {
        try {
            await this._req('DELETE', '/api/v1/private/order/cancel', {
                symbol  : this._toMexc(symbol),
                orderId : String(orderId)
            });
            return { orderId, status: 'CANCELED' };
        } catch (err) {
            this.logger.error(`MEXC cancelOrder [${orderId}]:`, err.message);
            throw err;
        }
    }

    /** Cancel all open orders for a symbol */
    async cancelAllOrders(symbol) {
        try {
            const orders = await this.getOpenOrders(symbol);
            for (const o of orders) await this.cancelOrder(symbol, o.orderId);
            return { count: orders.length };
        } catch (err) {
            this.logger.error(`MEXC cancelAllOrders [${symbol}]:`, err.message);
            throw err;
        }
    }

    /**
     * Get open positions — returns Binance-compatible shape so
     * positionMonitor and dashboard work unchanged:
     *   { symbol, positionAmt, entryPrice, markPrice, unrealizedProfit, leverage, marginType }
     */
    async getPositions(symbol = null) {
        try {
            const params    = symbol ? { symbol: this._toMexc(symbol) } : {};
            const data      = await this._req('GET', '/api/v1/private/position/open_positions', params);
            const contracts = await this._contracts();

            // Batch-fetch mark prices for unrealized PnL calculation
            // Use a single /ticker call (no symbol = all tickers) for efficiency
            let markPriceMap = {};
            try {
                // Fetch one specific ticker if single symbol, else all
                const tickerParams = symbol ? { symbol: this._toMexc(symbol) } : {};
                const tickers = await this._pub('/api/v1/contract/ticker', tickerParams);
                const tickerList = Array.isArray(tickers) ? tickers : (tickers ? [tickers] : []);
                for (const t of tickerList) {
                    markPriceMap[t.symbol]                    = parseFloat(t.lastPrice ?? 0);
                    markPriceMap[this._fromMexc(t.symbol)]    = parseFloat(t.lastPrice ?? 0);
                }
            } catch (_) { /* non-critical — markPrice falls back to entryPrice */ }

            const positions = (data || []).map(p => {
                const cSz     = parseFloat(contracts[p.symbol]?.contractSize ?? 1);
                const qty     = parseFloat(p.holdVol ?? 0) * cSz;
                const isLong  = p.positionType === 1;
                const entry   = parseFloat(p.openAvgPrice ?? p.holdAvgPrice ?? 0);

                // Use live mark price for unrealized PnL; fall back to entry
                const mark    = markPriceMap[p.symbol] || markPriceMap[this._fromMexc(p.symbol)] || entry;

                // Unrealized PnL = price diff × qty (for MEXC: qty is already in base units)
                // First try MEXC's own field (profitAmount), then calculate
                let unrealizedPnl;
                if (p.profitAmount !== undefined && p.profitAmount !== null) {
                    unrealizedPnl = parseFloat(p.profitAmount);
                } else if (mark && entry) {
                    unrealizedPnl = isLong
                        ? (mark - entry) * qty
                        : (entry - mark) * qty;
                } else {
                    unrealizedPnl = 0;
                }
                const pnlStr = unrealizedPnl.toFixed(4);

                return {
                    symbol            : this._fromMexc(p.symbol),
                    positionAmt       : (isLong ? qty : -qty).toString(),
                    entryPrice        : String(entry),
                    markPrice         : String(mark),
                    // Both key variants so positionMonitor (unRealizedProfit) and dashboard (unrealizedProfit) work
                    unrealizedProfit  : pnlStr,
                    unRealizedProfit  : pnlStr,
                    // isolatedMargin from MEXC position's "im" (initial margin)
                    isolatedMargin    : String(p.im ?? p.oim ?? 0),
                    leverage          : String(p.leverage      ?? 1),
                    marginType        : p.openType === 1 ? 'isolated' : 'cross',
                    positionSide      : isLong ? 'LONG' : 'SHORT',
                    // MEXC extras (used for close-order generation)
                    _mexcSymbol       : p.symbol,
                    _holdVol          : p.holdVol,
                    _contractSize     : cSz,
                    _positionId       : p.positionId ?? null
                };
            });

            if (symbol) {
                const norm = this._fromMexc(this._toMexc(symbol));
                return positions.filter(p => p.symbol === norm || p.symbol === symbol);
            }
            return positions;
        } catch (err) {
            this.logger.error('MEXC getPositions:', err.message);
            throw err;
        }
    }

    /**
     * Fetch realized PnL from the most recent closed position in MEXC history.
     * Called after a position closes to get the actual exchange-confirmed profit/loss.
     *
     * @param {string} symbol  e.g. 'BTCUSDT'
     * @returns {Promise<number|null>}
     */
    async getHistoricalPnL(symbol) {
        try {
            const data = await this._req('GET', '/api/v1/private/position/list/history_positions', {
                symbol  : this._toMexc(symbol),
                page_num: 1,
                page_size: 5
            });
            const list = Array.isArray(data) ? data : (data?.resultList ?? []);
            if (list.length > 0) {
                // realised = cumulative realized PnL on this position lifecycle
                const pnl = parseFloat(list[0].realised ?? list[0].profit ?? 0);
                this.logger.debug(`📈 Historical PnL for ${symbol}: $${pnl.toFixed(4)}`);
                return pnl;
            }
            return null;
        } catch (err) {
            this.logger.debug(`getHistoricalPnL [${symbol}]: ${err.message}`);
            return null;
        }
    }

    /** Get account summary */
    async getAccountInfo() {
        try {
            return await this._req('GET', '/api/v1/private/account/assets');
        } catch (err) {
            this.logger.error('MEXC getAccountInfo:', err.message);
            throw err;
        }
    }
}

module.exports = MexcClient;
