/**
 * Binance Client Module
 * Handles all Binance API interactions
 *
 * TRADE_MODE env controls which environment is used:
 *   testnet  → testnet.binancefuture.com  (conditional orders NOT supported, software SL/TP used)
 *   live     → fapi.binance.com            (full API support, real money)
 */

const Binance = require('binance-api-node').default;

class BinanceClient {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.client = null;
        this.tradeMode = null;
        this.initialize();
    }

    initialize() {
        const apiConfig = {
            apiKey: this.config.apiKey,
            apiSecret: this.config.apiSecret
        };

        this.tradeMode = this.config.tradeMode || 'live';

        switch (this.tradeMode) {
            case 'testnet':
                apiConfig.httpBase    = 'https://testnet.binancefuture.com';
                apiConfig.httpFutures = 'https://testnet.binancefuture.com';
                apiConfig.wsBase      = 'wss://stream.binancefuture.com';
                apiConfig.wsFutures   = 'wss://stream.binancefuture.com';
                this.logger.info('🧪 Mode: TESTNET (testnet.binancefuture.com)');
                this.logger.info('⚠️  Conditional orders (STOP_MARKET/TP_MARKET) blocked on testnet');
                this.logger.info('✅ Software SL/TP will be used for position protection');
                break;

            case 'live':
            default:
                // binance-api-node defaults to fapi.binance.com — no override needed
                this.tradeMode = 'live';
                this.logger.info('💰 Mode: LIVE (fapi.binance.com) — REAL MONEY TRADING!');
                break;
        }

        this.client = Binance(apiConfig);
        this.logger.info(`✅ Binance client initialized [${this.tradeMode.toUpperCase()}]`);
    }

    /** Returns true when running on testnet */
    isTestnet() {
        return this.tradeMode === 'testnet';
    }

    /**
     * Get account balance
     */
    async getBalance() {
        try {
            const account = await this.client.futuresAccountBalance();
            const usdtBalance = account.find(b => b.asset === 'USDT');
            return {
                available: parseFloat(usdtBalance.availableBalance),
                total: parseFloat(usdtBalance.balance)
            };
        } catch (error) {
            this.logger.error('Error fetching balance:', error.message);
            throw error;
        }
    }

    /**
     * Get all available futures symbols
     */
    async getAvailableSymbols() {
        try {
            const exchangeInfo = await this.client.futuresExchangeInfo();
            return exchangeInfo.symbols
                .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
                .map(s => ({
                    symbol: s.symbol,
                    baseAsset: s.baseAsset,
                    pricePrecision: s.pricePrecision,
                    quantityPrecision: s.quantityPrecision
                }));
        } catch (error) {
            this.logger.error('Error fetching symbols:', error.message);
            throw error;
        }
    }

    /**
     * Get symbol info
     */
    async getSymbolInfo(symbol) {
        try {
            const exchangeInfo = await this.client.futuresExchangeInfo();
            const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

            if (!symbolInfo) {
                throw new Error(`Symbol ${symbol} not found`);
            }

            const filters = {};
            symbolInfo.filters.forEach(filter => {
                filters[filter.filterType] = filter;
            });

            return {
                symbol: symbolInfo.symbol,
                pricePrecision: symbolInfo.pricePrecision,
                quantityPrecision: symbolInfo.quantityPrecision,
                minQuantity: parseFloat(filters.LOT_SIZE?.minQty || 0),
                maxQuantity: parseFloat(filters.LOT_SIZE?.maxQty || 0),
                stepSize: parseFloat(filters.LOT_SIZE?.stepSize || 0.001),
                tickSize: parseFloat(filters.PRICE_FILTER?.tickSize || 0.01),
                minNotional: parseFloat(filters.MIN_NOTIONAL?.notional || 0)
            };
        } catch (error) {
            this.logger.error(`Error fetching symbol info for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Get current price for a symbol
     */
    async getPrice(symbol) {
        try {
            const ticker = await this.client.futuresPrices({ symbol });
            return parseFloat(ticker[symbol]);
        } catch (error) {
            this.logger.error(`Error fetching price for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Set leverage for a symbol
     */
    async setLeverage(symbol, leverage) {
        try {
            await this.client.futuresLeverage({ symbol, leverage });
            this.logger.info(`Leverage set to ${leverage}x for ${symbol}`);
        } catch (error) {
            this.logger.error(`Error setting leverage for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Set margin type for a symbol
     */
    async setMarginType(symbol, marginType) {
        try {
            await this.client.futuresMarginType({
                symbol,
                marginType: marginType.toUpperCase()
            });
            this.logger.info(`Margin type set to ${marginType} for ${symbol}`);
        } catch (error) {
            if (error.message.includes('No need to change margin type')) {
                this.logger.debug(`Margin type already ${marginType} for ${symbol}`);
            } else {
                this.logger.error(`Error setting margin type for ${symbol}:`, error.message);
                throw error;
            }
        }
    }

    /**
     * Place an order
     */
    async placeOrder(params) {
        try {
            const order = await this.client.futuresOrder(params);
            return order;
        } catch (error) {
            this.logger.error('Error placing order:', error.message);
            throw error;
        }
    }

    /**
     * Get open orders for a symbol
     */
    async getOpenOrders(symbol) {
        try {
            return await this.client.futuresOpenOrders({ symbol });
        } catch (error) {
            this.logger.error(`Error fetching open orders for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Cancel an order
     */
    async cancelOrder(symbol, orderId) {
        try {
            return await this.client.futuresCancelOrder({ symbol, orderId });
        } catch (error) {
            this.logger.error(`Error canceling order ${orderId}:`, error.message);
            throw error;
        }
    }

    /**
     * Cancel all orders for a symbol
     */
    async cancelAllOrders(symbol) {
        try {
            return await this.client.futuresCancelAllOpenOrders({ symbol });
        } catch (error) {
            this.logger.error(`Error canceling all orders for ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Get position risk
     */
    async getPositions(symbol = null) {
        try {
            const params = symbol ? { symbol } : {};
            return await this.client.futuresPositionRisk(params);
        } catch (error) {
            this.logger.error('Error fetching positions:', error.message);
            throw error;
        }
    }

    /**
     * Get account information
     */
    async getAccountInfo() {
        try {
            return await this.client.futuresAccountInfo();
        } catch (error) {
            this.logger.error('Error fetching account info:', error.message);
            throw error;
        }
    }
}

module.exports = BinanceClient;
