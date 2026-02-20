/**
 * Storage Manager Module
 * Handles AWS S3 storage for trade history
 */

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class StorageManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.s3 = null;
        this.localTradesDir = path.join(process.cwd(), 'trades');
        this.trades = [];

        // Create local trades directory
        if (!fs.existsSync(this.localTradesDir)) {
            fs.mkdirSync(this.localTradesDir, { recursive: true });
        }

        this.initializeS3();
    }

    /**
     * Initialize AWS S3 client
     */
    initializeS3() {
        if (!this.config.awsAccessKeyId || !this.config.awsSecretAccessKey) {
            this.logger.warn('⚠️ AWS credentials not provided, using local storage only');
            return;
        }

        try {
            AWS.config.update({
                accessKeyId: this.config.awsAccessKeyId,
                secretAccessKey: this.config.awsSecretAccessKey,
                region: this.config.awsRegion
            });

            this.s3 = new AWS.S3();
            this.logger.info('✅ AWS S3 client initialized');
        } catch (error) {
            this.logger.error('Failed to initialize S3:', error.message);
            this.logger.warn('⚠️ Falling back to local storage only');
        }
    }

    /**
     * Save trade to storage
     */
    async saveTrade(trade) {
        const tradeId = trade.id || uuidv4();
        const tradeData = {
            id: tradeId,
            timestamp: Date.now(),
            ...trade
        };

        // Save locally
        await this.saveLocally(tradeData);

        // Save to S3 if available
        if (this.s3) {
            await this.saveToS3(tradeData);
        }

        this.trades.push(tradeData);
        return tradeId;
    }

    /**
     * Save trade locally
     */
    async saveLocally(trade) {
        try {
            const filename = `${trade.id}.json`;
            const filepath = path.join(this.localTradesDir, filename);
            fs.writeFileSync(filepath, JSON.stringify(trade, null, 2));
            this.logger.debug(`Trade saved locally: ${filename}`);
        } catch (error) {
            this.logger.error('Failed to save trade locally:', error.message);
        }
    }

    /**
     * Save trade to S3
     */
    async saveToS3(trade) {
        try {
            // Use original timestamp to maintain same date folder
            const tradeDate = new Date(trade.timestamp).toISOString().split('T')[0];
            const key = `trades/${tradeDate}/${trade.id}.json`;

            await this.s3.putObject({
                Bucket: this.config.s3BucketName,
                Key: key,
                Body: JSON.stringify(trade, null, 2),
                ContentType: 'application/json',
                ACL: 'private'  
            }).promise();

            this.logger.info(`✅ Trade saved to S3: ${key}`);
        } catch (error) {
            this.logger.error(`❌ Failed to save to S3: ${error.message}`);
            
            if (error.message.includes('not authorized') || error.message.includes('Access Denied')) {
                this.logger.error('⚠️ S3 PERMISSIONS REQUIRED:');
                this.logger.error('   1. Go to AWS IAM Console');
                this.logger.error('   2. Find user: apkjeeto-s3-uploader');
                this.logger.error('   3. Add permissions: s3:PutObject, s3:GetObject, s3:ListBucket');
                this.logger.error('   4. Resource ARN: arn:aws:s3:::signal-trades/*');
            }
            throw error;
        }
    }

    /**
     * Update trade status
     */
    async updateTrade(tradeId, updates) {
        try {
            // Load trade
            const trade = await this.loadTrade(tradeId);
            if (!trade) {
                this.logger.warn(`Trade ${tradeId} not found`);
                return;
            }

            // Update trade
            const updatedTrade = {
                ...trade,
                ...updates,
                updatedAt: Date.now()
            };

            // Save updated trade
            await this.saveLocally(updatedTrade);
            if (this.s3) {
                await this.saveToS3(updatedTrade);
            }

            this.logger.debug(`Trade ${tradeId} updated`);
        } catch (error) {
            this.logger.error(`Failed to update trade ${tradeId}:`, error.message);
        }
    }

    /**
     * Load trade from local storage
     */
    async loadTrade(tradeId) {
        try {
            const filepath = path.join(this.localTradesDir, `${tradeId}.json`);
            if (fs.existsSync(filepath)) {
                const data = fs.readFileSync(filepath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            this.logger.error(`Failed to load trade ${tradeId}:`, error.message);
        }
        return null;
    }

    /**
     * Get all trades (from S3 if available, otherwise local)
     */
    async getAllTrades() {
        // Try S3 first
        if (this.s3) {
            try {
                return await this.getAllTradesFromS3();
            } catch (error) {
                this.logger.warn('Failed to fetch from S3, falling back to local:', error.message);
            }
        }

        // Fallback to local storage
        try {
            const files = fs.readdirSync(this.localTradesDir);
            const trades = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filepath = path.join(this.localTradesDir, file);
                    const data = fs.readFileSync(filepath, 'utf8');
                    trades.push(JSON.parse(data));
                }
            }

            // Sort by timestamp (newest first)
            trades.sort((a, b) => b.timestamp - a.timestamp);
            return trades;
        } catch (error) {
            this.logger.error('Failed to get all trades:', error.message);
            return [];
        }
    }

    /**
     * Get all trades from S3
     */
    async getAllTradesFromS3() {
        try {
            const trades = [];
            
            // List all objects in the trades prefix
            const params = {
                Bucket: this.config.s3BucketName,
                Prefix: 'trades/'
            };

            const data = await this.s3.listObjectsV2(params).promise();

            if (!data.Contents || data.Contents.length === 0) {
                return [];
            }

            // Fetch each trade file
            for (const item of data.Contents) {
                if (item.Key.endsWith('.json')) {
                    try {
                        const object = await this.s3.getObject({
                            Bucket: this.config.s3BucketName,
                            Key: item.Key
                        }).promise();

                        const trade = JSON.parse(object.Body.toString('utf-8'));
                        trades.push(trade);
                    } catch (err) {
                        this.logger.debug(`Failed to fetch ${item.Key}:`, err.message);
                    }
                }
            }

            // Sort by timestamp (newest first)
            trades.sort((a, b) => b.timestamp - a.timestamp);
            return trades;
        } catch (error) {
            this.logger.error('Error fetching trades from S3:', error.message);
            throw error;
        }
    }

    /**
     * Get trade statistics
     */
    async getStatistics() {
        const trades = await this.getAllTrades();
        const closedTrades = trades.filter(t => t.status === 'closed');

        if (closedTrades.length === 0) {
            return {
                totalTrades: 0,
                wins: 0,
                losses: 0,
                winRate: 0,
                totalPnL: 0,
                totalFees: 0,
                netPnL: 0
            };
        }

        const wins = closedTrades.filter(t => t.pnl > 0).length;
        const losses = closedTrades.filter(t => t.pnl <= 0).length;
        const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const totalFees = closedTrades.reduce((sum, t) => sum + (t.fees || 0), 0);

        return {
            totalTrades: closedTrades.length,
            wins,
            losses,
            winRate: ((wins / closedTrades.length) * 100).toFixed(2),
            totalPnL: totalPnL.toFixed(2),
            totalFees: totalFees.toFixed(2),
            netPnL: (totalPnL - totalFees).toFixed(2),
            avgPnL: (totalPnL / closedTrades.length).toFixed(2)
        };
    }

    /**
     * Sync local trades to S3
     */
    async syncToS3() {
        if (!this.s3) {
            this.logger.warn('S3 not configured, skipping sync');
            return;
        }

        try {
            const trades = await this.getAllTrades();
            this.logger.info(`Syncing ${trades.length} trades to S3...`);

            for (const trade of trades) {
                await this.saveToS3(trade);
            }

            this.logger.info('✅ Sync to S3 completed');
        } catch (error) {
            this.logger.error('Failed to sync to S3:', error.message);
        }
    }
}

module.exports = StorageManager;
