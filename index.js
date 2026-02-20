/**
 * Signal-Based Trading Bot
 * Main entry point
 */

require('dotenv').config();
const Logger = require('./src/logger');
const BinanceClient = require('./src/binanceClient');
const TradeExecutor = require('./src/tradeExecutor');
const PositionMonitor = require('./src/positionMonitor');
const StorageManager = require('./src/storageManager');

class SignalTradingBot {
    constructor() {
        // Initialize logger
        this.logger = new Logger(process.env.LOG_LEVEL || 'info');

        // Configuration
        this.config = {
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

        // Initialize components
        this.binanceClient = new BinanceClient(this.config, this.logger);
        this.storage = new StorageManager(this.config, this.logger);
        this.executor = new TradeExecutor(this.binanceClient, this.logger, this.config);
        this.monitor = new PositionMonitor(this.binanceClient, this.executor, this.logger, this.storage);

        this.isRunning = false;
    }

    /**
     * Start the bot
     */
    async start() {
        try {
            this.logger.info('🚀 Starting Signal-Based Trading Bot...');

            // Check balance
            const balance = await this.binanceClient.getBalance();
            this.logger.info(`💰 Account Balance: $${balance.available.toFixed(2)} USDT`);

            if (balance.available < this.config.minMarginBalance) {
                throw new Error(`Insufficient balance: $${balance.available.toFixed(2)} < $${this.config.minMarginBalance}`);
            }

            // Start position monitor
            await this.monitor.start();

            this.isRunning = true;
            this.logger.info('✅ Bot started successfully');
            this.logger.info('📡 Waiting for trade signals...');
            this.logger.info('💡 Use the dashboard to submit trade signals');

        } catch (error) {
            this.logger.error('Failed to start bot:', error.message);
            throw error;
        }
    }

    /**
     * Stop the bot
     */
    async stop() {
        this.logger.info('🛑 Stopping bot...');
        this.monitor.stop();
        this.isRunning = false;
        this.logger.info('✅ Bot stopped');
    }

    /**
     * Execute a trade signal
     * This method is called from the dashboard API
     */
    async executeSignal(signal) {
        try {
            this.logger.info('📨 Received trade signal:', signal);

            // Validate signal
            this.validateSignal(signal);

            // Execute trade
            const result = await this.executor.executeTrade(signal);

            // Save trade to storage
            const tradeId = await this.storage.saveTrade({
                ...result,
                signal,
                status: signal.orderType === 'MARKET' ? 'open' : 'pending',
                ctcLevel: signal.ctcLevel
            });

            // Add to monitor
            if (signal.orderType === 'MARKET') {
                this.monitor.addPosition(
                    signal.symbol,
                    signal.side,
                    result.price,
                    signal.ctcLevel,
                    'MARKET'
                );
            } else {
                // Limit order - monitor for fill
                this.monitor.addPendingLimitOrder(signal.symbol, {
                    ...signal,
                    orderId: result.orderId
                });
            }

            this.logger.info(`✅ Signal executed successfully - Trade ID: ${tradeId}`);
            return { success: true, tradeId, ...result };

        } catch (error) {
            this.logger.error('Failed to execute signal:', error.message);
            throw error;
        }
    }

    /**
     * Validate trade signal
     */
    validateSignal(signal) {
        const required = ['symbol', 'side', 'orderType', 'walletPercentage', 'stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3', 'ctcLevel'];

        for (const field of required) {
            if (!signal[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        if (!['LONG', 'SHORT'].includes(signal.side)) {
            throw new Error('Invalid side: must be LONG or SHORT');
        }

        if (!['MARKET', 'LIMIT'].includes(signal.orderType)) {
            throw new Error('Invalid orderType: must be MARKET or LIMIT');
        }

        if (signal.orderType === 'LIMIT' && !signal.limitPrice) {
            throw new Error('limitPrice required for LIMIT orders');
        }

        if (!['NONE', 'TP1', 'TP2'].includes(signal.ctcLevel)) {
            throw new Error('Invalid ctcLevel: must be NONE, TP1, or TP2');
        }

        if (signal.walletPercentage < 1 || signal.walletPercentage > 100) {
            throw new Error('walletPercentage must be between 1 and 100');
        }
    }

    /**
     * Get bot status
     */
    async getStatus() {
        try {
            const balance = await this.binanceClient.getBalance();
            const positions = await this.binanceClient.getPositions();
            const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
            const monitorStatus = this.monitor.getStatus();
            const stats = await this.storage.getStatistics();

            return {
                isRunning: this.isRunning,
                balance: {
                    available: balance.available.toFixed(2),
                    total: balance.total.toFixed(2)
                },
                activePositions: activePositions.length,
                monitoredPositions: monitorStatus.monitoredPositions,
                pendingLimitOrders: monitorStatus.pendingLimitOrders,
                statistics: stats
            };
        } catch (error) {
            this.logger.error('Failed to get status:', error.message);
            throw error;
        }
    }

    /**
     * Close a position manually
     */
    async closePosition(symbol) {
        try {
            const result = await this.executor.closePosition(symbol, 'manual');
            this.monitor.removePosition(symbol);
            return result;
        } catch (error) {
            this.logger.error(`Failed to close position ${symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Get available symbols
     */
    async getAvailableSymbols() {
        try {
            return await this.binanceClient.getAvailableSymbols();
        } catch (error) {
            this.logger.error('Failed to get symbols:', error.message);
            throw error;
        }
    }
}

// Create and start bot
const bot = new SignalTradingBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

// Start bot
bot.start().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

// Export for dashboard API
module.exports = bot;
