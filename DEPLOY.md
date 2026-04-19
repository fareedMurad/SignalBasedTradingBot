# EC2 Deployment Guide — Signal Trading Bot

Follow these steps exactly on your EC2 instance after pulling the folder.

---

## Step 1 — SSH into your EC2

```bash
ssh -i your-key.pem ubuntu@13.232.123.216
```

---

## Step 2 — Go to the bot folder

```bash
cd /path/to/SignalBasedTradingBot
# example:
cd ~/SignalBasedTradingBot
```

---

## Step 3 — Install dependencies

```bash
npm install
```

---

## Step 4 — Create your `.env` file

```bash
cp .env.example .env
nano .env
```

Fill in these values (minimum required):

```env
# Binance
API_KEY=your_binance_api_key
API_SECRET=your_binance_api_secret

# Mode: 'live' for real trading, 'testnet' for testing
TRADE_MODE=live

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_PASSWORD=your_strong_password_here

# Logging
LOG_LEVEL=info
```

Save and exit: `Ctrl+O` → `Enter` → `Ctrl+X`

---

## Step 5 — Install PM2 (if not already installed)

```bash
# Check if already installed
pm2 --version

# If not installed:
npm install -g pm2
```

---

## Step 6 — Start the bot with PM2

```bash
pm2 start dashboard/server.js \
  --name "trading-bot" \
  --cwd ~/SignalBasedTradingBot \
  --log logs/bot.log \
  --time
```

> **Replace** `/home/ubuntu/SignalBasedTradingBot` with your actual absolute path.

---

## Step 7 — Save PM2 process list (auto-restart on reboot)

```bash
pm2 save
pm2 startup
```

PM2 will print a command like:
```
sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

**Copy and run that exact command** it generates.

---

## Step 8 — Verify it's running

```bash
pm2 status
pm2 logs trading-bot --lines 50
```

Expected output in logs:
```
🌐 Dashboard server running on http://localhost:3000
🔍 Position monitor started
```

---

## Step 9 — AWS Security Group — Inbound Rules

Go to **AWS Console → EC2 → Instances → your instance → Security tab → Security groups → Edit inbound rules**

Add these rules:

| Type | Protocol | Port | Source | Purpose |
|------|----------|------|--------|---------|
| Custom TCP | TCP | **3000** | `0.0.0.0/0` | Dashboard + trade webhook |
| SSH | TCP | 22 | Your IP | You only (already set) |

> **Tip:** Instead of `0.0.0.0/0`, restrict port 3000 to your signal provider's IP + your own IP for better security.

**Outbound rules:** No changes needed — all outbound is open by default on EC2.

---

## Step 10 — Access the dashboard

Open your browser:

```
http://13.232.123.216:3000
```

You'll see the login page. Enter the password from your `.env` → `DASHBOARD_PASSWORD`.

---

## Step 11 — Give signal provider the webhook URL

```
POST http://13.232.123.216:3000/api/trade
```

The `/api/trade` endpoint **does not require the dashboard password** — it only needs the correct JSON payload.

---

## Common PM2 Commands

```bash
# View live logs
pm2 logs trading-bot

# Restart
pm2 restart trading-bot

# Stop
pm2 stop trading-bot

# Delete
pm2 delete trading-bot

# Show all processes
pm2 list

# Monitor CPU/memory
pm2 monit
```

---

## Updating the bot (after git pull)

```bash
cd ~/SignalBasedTradingBot
git pull
npm install
pm2 restart trading-bot
```

---

## Check if port 3000 is already in use

```bash
sudo lsof -i :3000
```

If occupied, change `DASHBOARD_PORT=3001` (or any free port) in your `.env` and update the Security Group inbound rule to match.

---

## Notes

- **Session tokens** are in-memory — they reset on `pm2 restart`. You'll need to log in again after a restart. This is normal.
- **Trade data** is stored in the `trades/` folder (JSON files) locally on EC2.
- If you configured **AWS S3**, trades are also backed up to S3 automatically.
- Logs are stored in `logs/bot.log` — rotate if needed with `pm2 install pm2-logrotate`.
