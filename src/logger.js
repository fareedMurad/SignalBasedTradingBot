/**
 * Logger Module
 * Simple, clean logging utility
 */

const fs = require('fs');
const path = require('path');

class Logger {
    constructor(level = 'info') {
        this.level = level;
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };

        // Create logs directory if it doesn't exist
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        this.logFile = path.join(logsDir, `bot-${new Date().toISOString().split('T')[0]}.log`);
    }

    formatMessage(level, message, data = null) {
        const timestamp = new Date().toISOString();
        let logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

        if (data) {
            logMessage += ` ${JSON.stringify(data)}`;
        }

        return logMessage;
    }

    writeToFile(message) {
        try {
            fs.appendFileSync(this.logFile, message + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }

    log(level, message, data = null) {
        if (this.levels[level] >= this.levels[this.level]) {
            const formattedMessage = this.formatMessage(level, message, data);
            console.log(formattedMessage);
            this.writeToFile(formattedMessage);
        }
    }

    debug(message, data = null) {
        this.log('debug', message, data);
    }

    info(message, data = null) {
        this.log('info', message, data);
    }

    warn(message, data = null) {
        this.log('warn', message, data);
    }

    error(message, data = null) {
        this.log('error', message, data);
    }
}

module.exports = Logger;
