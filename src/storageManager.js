/**
 * Storage Manager Module
 * Handles trade history — local JSON files (primary) with optional AWS S3 backup.
 *
 * S3 is tested ONCE on startup.  If the bucket is unreachable the manager falls
 * back to local storage for the entire session, logging only a single warning.
 */

const AWS = require('aws-sdk');
const fs  = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class StorageManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.s3     = null;
        this.localTradesDir = path.join(process.cwd(), 'trades');
        this.trades = [];

        // Create local trades directory
        if (!fs.existsSync(this.localTradesDir)) {
            fs.mkdirSync(this.localTradesDir, { recursive: true });
        }

        this._initializeS3();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  S3 INIT + CONNECTIVITY CHECK
    // ─────────────────────────────────────────────────────────────────────────

    _initializeS3() {
        if (!this.config.awsAccessKeyId || !this.config.awsSecretAccessKey || !this.config.s3BucketName) {
            this.logger.warn('⚠️  AWS credentials / bucket not set — using local storage only');
            return;
        }

        try {
            AWS.config.update({
                accessKeyId    : this.config.awsAccessKeyId,
                secretAccessKey: this.config.awsSecretAccessKey,
                region         : this.config.awsRegion || 'us-east-1',
                httpOptions    : { timeout: 5000, connectTimeout: 3000 }
            });

            this.s3 = new AWS.S3();
            // Test connectivity once — non-blocking (add .catch so unhandled rejection never escapes)
            this._checkS3Connectivity().catch(err => {
                this.s3 = null;
                this.logger.warn(`⚠️  S3 connectivity check threw unexpectedly: ${err?.message || err}`);
            });
        } catch (err) {
            this.logger.warn(`⚠️  S3 init failed (${err.message}) — using local storage only`);
        }
    }

    /**
     * Test the bucket with a HEAD request.
     * If it fails for ANY reason, disable S3 for this session.
     */
    async _checkS3Connectivity() {
        try {
            await this.s3.headBucket({ Bucket: this.config.s3BucketName }).promise();
            this.logger.info(`✅ S3 bucket "${this.config.s3BucketName}" reachable — using S3 backup`);
        } catch (err) {
            this.s3 = null; // disable for entire session — no further S3 calls
            // err.message can be null for AWS SDK timeout / network errors — guard it
            const errText = (err?.message || err?.code || String(err)).replace(/\n/g, ' ');
            this.logger.warn(
                `⚠️  S3 bucket "${this.config.s3BucketName}" unreachable ` +
                `(${errText}) — falling back to local storage only`
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  WRITE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Save trade to storage (local always, S3 when reachable).
     */
    async saveTrade(trade) {
        const tradeId   = trade.id || uuidv4();
        const tradeData = { id: tradeId, timestamp: Date.now(), ...trade };

        await this._saveLocally(tradeData);

        if (this.s3) {
            // Fire-and-forget — never block the calling path
            this._saveToS3(tradeData).catch(() => {});
        }

        this.trades.push(tradeData);
        return tradeId;
    }

    /**
     * Update an existing trade by id.
     */
    async updateTrade(tradeId, updates) {
        try {
            const trade = await this._loadTrade(tradeId);
            if (!trade) {
                this.logger.warn(`Trade ${tradeId} not found locally`);
                return;
            }

            const updated = { ...trade, ...updates, updatedAt: Date.now() };
            await this._saveLocally(updated);

            if (this.s3) {
                this._saveToS3(updated).catch(() => {});
            }

            this.logger.debug(`Trade ${tradeId} updated`);
        } catch (err) {
            this.logger.error(`Failed to update trade ${tradeId}:`, err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  READ
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get all trades.
     * Order of preference: S3 (when available) → local JSON files.
     */
    async getAllTrades() {
        if (this.s3) {
            try {
                return await this._getAllTradesFromS3();
            } catch (err) {
                // S3 was available at startup but failed mid-session — fall through
                this.logger.warn(`S3 read failed, using local: ${err.message}`);
            }
        }

        return this._getAllTradesLocal();
    }

    /**
     * Get statistics from trade history.
     */
    async getStatistics() {
        const trades      = await this.getAllTrades();
        const closed      = trades.filter(t => t.status === 'closed');
        const wins        = closed.filter(t => (t.pnl || 0) > 0).length;
        const losses      = closed.filter(t => (t.pnl || 0) <= 0).length;
        const totalPnL    = closed.reduce((s, t) => s + (t.pnl || 0), 0);
        const totalFees   = closed.reduce((s, t) => s + (t.fees || 0), 0);
        const all         = await this.getAllTrades();
        const netPnL      = totalPnL - totalFees;
        const openTrades  = all.filter(t => t.status === 'open').length;

        if (closed.length === 0) {
            return {
                totalTrades: 0, wins: 0, losses: 0,
                winRate: '0.00', totalPnL: '0.00', totalFees: '0.00',
                netPnL: '0.00', avgPnL: '0.00', openTrades
            };
        }

        return {
            totalTrades : closed.length,
            wins,
            losses,
            winRate     : ((wins / closed.length) * 100).toFixed(2),
            totalPnL    : totalPnL.toFixed(2),
            totalFees   : totalFees.toFixed(2),
            netPnL      : netPnL.toFixed(2),
            avgPnL      : (totalPnL / closed.length).toFixed(2),
            openTrades
        };
    }

    /**
     * Sync all local trades to S3 (manual / startup utility).
     */
    async syncToS3() {
        if (!this.s3) {
            this.logger.warn('S3 not available — skipping sync');
            return;
        }
        const trades = this._getAllTradesLocal();
        this.logger.info(`Syncing ${trades.length} local trades to S3…`);
        for (const trade of trades) {
            await this._saveToS3(trade);
        }
        this.logger.info('✅ S3 sync complete');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    async _saveLocally(trade) {
        try {
            const fp = path.join(this.localTradesDir, `${trade.id}.json`);
            fs.writeFileSync(fp, JSON.stringify(trade, null, 2));
            this.logger.debug(`Trade saved locally: ${trade.id}.json`);
        } catch (err) {
            this.logger.error('Local save failed:', err.message);
        }
    }

    async _saveToS3(trade) {
        const date = new Date(trade.timestamp).toISOString().split('T')[0];
        const key  = `trades/${date}/${trade.id}.json`;
        try {
            await this.s3.putObject({
                Bucket     : this.config.s3BucketName,
                Key        : key,
                Body       : JSON.stringify(trade, null, 2),
                ContentType: 'application/json'
            }).promise();
            this.logger.debug(`✅ S3 saved: ${key}`);
        } catch (err) {
            // Never throw — S3 is backup, not primary
            this.logger.warn(`S3 save skipped (${key}): ${err.message}`);
        }
    }

    async _loadTrade(tradeId) {
        try {
            const fp = path.join(this.localTradesDir, `${tradeId}.json`);
            if (fs.existsSync(fp)) {
                return JSON.parse(fs.readFileSync(fp, 'utf8'));
            }
        } catch (err) {
            this.logger.error(`Failed to load trade ${tradeId}:`, err.message);
        }
        return null;
    }

    _getAllTradesLocal() {
        try {
            const files = fs.readdirSync(this.localTradesDir);
            const trades = [];
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                try {
                    const data = fs.readFileSync(path.join(this.localTradesDir, f), 'utf8');
                    trades.push(JSON.parse(data));
                } catch (_) { /* skip corrupt files */ }
            }
            trades.sort((a, b) => b.timestamp - a.timestamp);
            return trades;
        } catch (err) {
            this.logger.error('Failed to read local trades:', err.message);
            return [];
        }
    }

    async _getAllTradesFromS3() {
        const params = { Bucket: this.config.s3BucketName, Prefix: 'trades/' };
        const list   = await this.s3.listObjectsV2(params).promise();
        if (!list.Contents || list.Contents.length === 0) return [];

        const trades = [];
        for (const item of list.Contents) {
            if (!item.Key.endsWith('.json')) continue;
            try {
                const obj   = await this.s3.getObject({ Bucket: this.config.s3BucketName, Key: item.Key }).promise();
                trades.push(JSON.parse(obj.Body.toString('utf-8')));
            } catch (err) {
                this.logger.debug(`S3 object skip (${item.Key}): ${err.message}`);
            }
        }
        trades.sort((a, b) => b.timestamp - a.timestamp);
        return trades;
    }
}

module.exports = StorageManager;
