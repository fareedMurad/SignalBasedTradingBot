# Signal-Based Trading Bot

A clean, modern signal-based trading bot for Binance Futures with an intuitive admin dashboard. Execute trades based on signals with advanced features like multiple take-profits, stop-loss management, and Close-to-Cost (CTC) functionality.

## ✨ Features

- **📊 Signal-Based Trading**: Execute trades based on provided signals
- **🎯 Market & Limit Orders**: Choose between market execution or limit orders
- **💰 Flexible Position Sizing**: Set wallet percentage (1-100%) for each trade
- **🎚️ 3-Level Take Profits**: Distribute exits across TP1 (33%), TP2 (33%), TP3 (34%)
- **🛡️ Stop Loss Protection**: Automatic stop-loss placement with 5-tier safety system
- **🔄 CTC (Close to Cost)**: Automatically move SL to break-even after TP1 or TP2 hits
- **📈 Real-time Dashboard**: Beautiful, responsive admin interface
- **☁️ AWS S3 Integration**: Store trade history in the cloud (optional)
- **📱 Live Updates**: Dashboard auto-refreshes every 5 seconds
- **📊 Performance Statistics**: Track wins, losses, PnL, and win rate

## 🚀 Quick Start

### 1. Installation

```bash
cd /Users/4star/Desktop/Trading/SignalBasedTradingBot
npm install
```

### 2. Configuration

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Binance API Credentials (from existing bot)
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here

# Trading Mode
USE_TESTNET=true
USE_DEMO_ENV=true

# AWS S3 Configuration (you will provide these)
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=trading-bot-history

# Risk Management
LEVERAGE=10
RISK_MODE=isolated
MIN_MARGIN_BALANCE=50

# Dashboard Server
DASHBOARD_PORT=3000

# Logging
LOG_LEVEL=info
```

### 3. Run the Dashboard

```bash
npm run dashboard
```

The dashboard will be available at: **http://localhost:3000**

## 📖 How to Use

### Submit a Trade Signal

1. Open the dashboard at http://localhost:3000
2. Fill in the trade signal form:
   - **Symbol**: Select from available Binance Futures pairs
   - **Side**: LONG or SHORT
   - **Order Type**: MARKET (instant) or LIMIT (wait for price)
   - **Limit Price**: Only for limit orders
   - **Wallet %**: Percentage of available balance to use (1-100%)
   - **Stop Loss**: Price level for stop loss
   - **Take Profit 1, 2, 3**: Three take profit levels
   - **CTC Level**: When to move SL to break-even (NONE, TP1, or TP2)

3. Click "Execute Trade"

### Example Trade Signal

**LONG Trade on BTCUSDT:**
- Symbol: BTCUSDT
- Side: LONG
- Order Type: MARKET
- Wallet %: 10
- Stop Loss: 95000
- TP1: 98000 (33% of position)
- TP2: 99000 (33% of position)
- TP3: 100000 (34% of position)
- CTC: After TP1 (moves SL to break-even after TP1 hits)

## 🎯 CTC (Close to Cost) Feature

The CTC feature automatically protects your profits by moving the stop-loss to break-even:

- **NONE**: SL stays at original level
- **After TP1**: When TP1 hits, SL moves to break-even
- **After TP2**: When TP2 hits, SL moves to break-even

This ensures you lock in profits and eliminate risk once targets are hit.

## 📊 Dashboard Features

### Header Stats
- **Balance**: Available USDT balance
- **Active Positions**: Number of open positions
- **Win Rate**: Percentage of winning trades
- **Net PnL**: Total profit/loss after fees

### Active Positions Table
- Real-time position monitoring
- PnL tracking with percentage
- One-click position closing
- Entry/Mark price display

### Trade History
- Last 20 trades
- Status tracking (open, pending, closed)
- Order type and CTC level display

### Performance Statistics
- Total trades count
- Wins vs Losses
- Total PnL and fees
- Average PnL per trade

## 🔧 Advanced Features

### Position Monitor
- Automatically monitors all positions
- Detects TP hits and triggers CTC
- Handles limit order fills
- Sets SL/TP after limit orders fill

### AWS S3 Storage
- Automatic backup of all trades
- Organized by date
- Local fallback if S3 unavailable
- Easy sync command

### Safety Features
- 5-tier stop-loss system (ensures SL placement)
- Minimum balance checks
- Position size validation
- Duplicate order prevention

## 📁 Project Structure

```
SignalBasedTradingBot/
├── src/
│   ├── logger.js           # Logging utility
│   ├── binanceClient.js    # Binance API wrapper
│   ├── tradeExecutor.js    # Trade execution logic
│   ├── positionMonitor.js  # Position monitoring & CTC
│   └── storageManager.js   # AWS S3 & local storage
├── dashboard/
│   ├── server.js           # Express API server
│   └── public/
│       ├── index.html      # Dashboard UI
│       ├── style.css       # Styling
│       └── app.js          # Frontend logic
├── index.js                # Main bot entry (optional)
├── package.json
├── .env.example
└── README.md
```

## 🔐 Security Notes

- Never commit your `.env` file
- Keep API keys secure
- Use testnet for testing
- Start with small position sizes

## 🐛 Troubleshooting

### Dashboard won't start
```bash
# Check if port 3000 is available
lsof -i :3000

# Try a different port in .env
DASHBOARD_PORT=3001
```

### Can't connect to Binance
- Verify API keys in `.env`
- Check if `USE_TESTNET=true` for testing
- Ensure API keys have Futures trading permissions

### AWS S3 errors
- Bot works without S3 (uses local storage)
- Verify AWS credentials
- Check S3 bucket exists and has write permissions

## 📝 Notes

- This bot uses the same test environment as your existing Smart Trading Bot
- Trade history is stored both locally (in `trades/` folder) and on AWS S3
- The dashboard auto-refreshes every 5 seconds
- All trades are logged to `logs/` folder
- CTC can be updated even while a trade is running

## 🎨 Dashboard Preview

The dashboard features:
- Modern gradient design (purple theme)
- Responsive layout (works on mobile)
- Real-time updates
- Clean, intuitive interface
- Color-coded PnL (green for profit, red for loss)

## 🚦 Running in Production

When ready for live trading:

1. Set `USE_TESTNET=false` in `.env`
2. Use your live Binance API keys
3. Start with small position sizes
4. Monitor the dashboard closely
5. Keep logs for analysis

## 📞 Support

For issues or questions:
- Check the logs in `logs/` folder
- Review trade history in `trades/` folder
- Verify `.env` configuration

---

**Built with ❤️ for clean, reliable signal-based trading**
