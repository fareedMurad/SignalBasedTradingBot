/**
 * Exchange Client Factory
 *
 * Controls which exchange is used via .env:
 *   EXCHANGE=binance  (default — all existing Binance behaviour)
 *   EXCHANGE=mexc     (MEXC Futures, demo or live via USE_DEMO_ENV)
 *
 * Returns an instance that implements the shared interface:
 *   getBalance()           getAvailableSymbols()  getSymbolInfo(symbol)
 *   getMaxLeverage(symbol) getPrice(symbol)        setLeverage(symbol, lev)
 *   setMarginType(sym, mt) placeOrder(params)      getOpenOrders(symbol)
 *   cancelOrder(sym, id)   cancelAllOrders(symbol) getPositions(symbol?)
 *   getAccountInfo()       isTestnet()
 */

const BinanceClient = require('./binanceClient');
const MexcClient    = require('./mexcClient');

/**
 * @param {object} config
 * @param {object} logger
 * @returns {BinanceClient|MexcClient}
 */
function createExchangeClient(config, logger) {
    const exchange = (process.env.EXCHANGE || 'binance').toLowerCase().trim();

    if (exchange === 'mexc') {
        logger.info('🔀 Exchange: MEXC Futures');
        return new MexcClient(config, logger);
    }

    logger.info('🔀 Exchange: Binance Futures');
    return new BinanceClient(config, logger);
}

module.exports = { createExchangeClient };
