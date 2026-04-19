# Signal Provider — Trade Execution API Reference

Send an HTTP POST request to the bot endpoint to execute a trade.

---

## Endpoint

```
POST http://13.232.123.216:3000/api/trade
Content-Type: application/json
```

Default port is **3000** (set `DASHBOARD_PORT` in `.env`).

---

## SL / TP — Two Modes

The bot accepts SL and TP in **two flavours**. You can mix them freely:

| Mode | SL field | TP field | Notes |
|------|----------|----------|-------|
| **Absolute price** | `stopLoss` | `rr` or `takeProfit1` | Classic — send the actual price level |
| **Pips distance** | `slPips` | `rr` or `tpPips` | New — send how many USDT away from entry |

> **1 pip = 1 USDT** for all Binance Fututes pairs (e.g. BTCUSDT, ETHUSDT).

### Pips math (executed at actual fill price)

```
BUY  (LONG):
  SL = fillPrice − slPips
  TP = fillPrice + slPips × rr      (or fillPrice + tpPips if tpPips provided)

SELL (SHORT):
  SL = fillPrice + slPips
  TP = fillPrice − slPips × rr      (or fillPrice − tpPips if tpPips provided)
```

**Example:** entry fills at 75,660 | `slPips: 150` | `rr: 2.67`
```
SL = 75,660 − 150 = 75,510
TP = 75,660 + 150 × 2.67 = 75,660 + 400.5 = 76,060.5
```

---

## Signal Model

| Concept | How it works |
|---------|-------------|
| **SL** | Absolute price OR computed from `slPips` at fill price |
| **TP** | Computed from `rr` × SL distance (or `tpPips` directly) — 100% close |
| **CTC** | When price reaches `ctcTrigger × TP_distance` from entry → SL moves to break-even |
| **Holding candles** | After `holdingCandles × 3 min` from `entryTime` → force-close |

---

## Full Payload Schema

```json
{
  "symbol":         "BTCUSDT",       // required
  "direction":      "BUY",           // required — "BUY" (long) | "SELL" (short)
  "leverage":       10,              // required — 1–125
  "riskMode":       "isolated",      // required — "isolated" | "crossed"
  "marginDollar":   100,             // required — fixed $ margin per trade

  // ── SL (one of these is required) ──────────────────────────────────────
  "stopLoss":       74000,           // Option A: absolute SL price
  // OR
  "slPips":         150,             // Option B: SL distance in USDT from entry

  // ── TP (one of these is required unless takeProfit1 is sent) ───────────
  "rr":             2.67,            // Option A: risk:reward ratio  (e.g. 2.67)
  // OR
  "tpPips":         400,             // Option B: TP distance in USDT from entry

  // ── Optional ───────────────────────────────────────────────────────────
  "ctcEnabled":     true,            // enable CTC (default: false)
  "ctcTrigger":     0.4,             // CTC fires at 40% of TP dist from entry (default: 0.5)
  "holdingCandles": 10,              // force-close after N × 3-min candles
  "entryTime":      1714521600000,   // unix ms of signal (start of holding countdown)
  "orderType":      "MARKET"         // "MARKET" (default) | "LIMIT"
}
```

---

## Example Payloads

### Mode A — Absolute SL + R:R (existing style unchanged)

```json
{
  "symbol":       "BTCUSDT",
  "direction":    "BUY",
  "leverage":     10,
  "riskMode":     "isolated",
  "marginDollar": 100,
  "stopLoss":     74000,
  "rr":           2.5
}
```

Entry ≈ 75,000 | SL = 74,000 | TP = 75,000 + 1,000 × 2.5 = **77,500**

---

### Mode B — Pips SL + R:R (new style)

```json
{
  "symbol":       "BTCUSDT",
  "direction":    "BUY",
  "leverage":     10,
  "riskMode":     "isolated",
  "marginDollar": 100,
  "slPips":       150,
  "rr":           2.67,
  "ctcEnabled":   true,
  "ctcTrigger":   0.4,
  "holdingCandles": 10,
  "entryTime":    1714521600000
}
```

Fill ≈ 75,660 | SL = 75,660 − 150 = **75,510** | TP = 75,660 + 150×2.67 = **76,060.5**

---

### Mode B — Pips SL + Pips TP (fully pips-based)

```json
{
  "symbol":       "ETHUSDT",
  "direction":    "SELL",
  "leverage":     5,
  "riskMode":     "isolated",
  "marginDollar": 50,
  "slPips":       80,
  "tpPips":       200
}
```

Fill ≈ 3,000 | SL = 3,000 + 80 = **3,080** | TP = 3,000 − 200 = **2,800**

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | ✅ | Binance Futures pair, e.g. `BTCUSDT` |
| `direction` | string | ✅ | `"BUY"` or `"SELL"` |
| `leverage` | number | ✅ | 1 to 125 |
| `riskMode` | string | ✅ | `"isolated"` or `"crossed"` |
| `marginDollar` | number | ✅ | Fixed dollar margin e.g. `100` |
| `stopLoss` | number | ✅* | Absolute SL price (*one of stopLoss/slPips required) |
| `slPips` | number | ✅* | SL distance in USDT from fill price (*one of stopLoss/slPips required) |
| `rr` | number | ✅** | Risk:reward ratio (**required unless tpPips or takeProfit1 provided) |
| `tpPips` | number | ❌ | TP distance in USDT from fill price (overrides rr) |
| `takeProfit1` | number | ❌ | Explicit TP price (overrides rr and tpPips) |
| `ctcEnabled` | boolean | ❌ | Enable CTC. Default: `false` |
| `ctcTrigger` | number | ❌ | CTC fires at this fraction of TP dist. Default: `0.5` |
| `holdingCandles` | number | ❌ | Force-close after N × 3-min candles. Default: `0` (off) |
| `entryTime` | number | ❌ | Unix ms of signal entry (holding countdown start) |
| `orderType` | string | ❌ | `"MARKET"` (default) or `"LIMIT"` |

---

## Successful Response

```json
{
  "success": true,
  "data": {
    "tradeId":        "daf8579a-...",
    "orderId":        13050663972,
    "symbol":         "BTCUSDT",
    "side":           "LONG",
    "quantity":       0.0132,
    "price":          75660,
    "stopLoss":       75510,
    "takeProfit1":    76060.5,
    "rr":             2.67,
    "slPips":         150,
    "tpPips":         null,
    "ctcEnabled":     true,
    "ctcTrigger":     0.4,
    "holdingCandles": 10,
    "tradeStartTime": 1714521600000,
    "softwareSLTP":   false
  }
}
```

---

## Error Response

```json
{
  "success": false,
  "error": "Missing required field: stopLoss (price) OR slPips (distance in USDT from entry)"
}
```

---

## CTC — Close to Cost

Moves SL to break-even before TP is hit (does **not** close the trade).

```
ctcTrigger: 0.4 → CTC fires when price reaches 40% of the way from entry to TP
```

Example: entry 75,660 | TP 76,060.5 | `ctcTrigger: 0.4`
- CTC price = 75,660 + 0.4 × 400.5 = **75,820.2**
- At 75,820 → SL moves to ≈75,690 (entry + ~0.04% fee buffer)
- Trade continues toward TP 76,060.5

---

## Holding Candles

- `holdingCandles: 10` = force-close after **10 × 3 min = 30 min** from `entryTime`
- Dashboard Active Positions table has a per-position **holding toggle**:
  - Toggle **OFF** → candle limit paused, trade runs to SL/TP normally
  - Toggle **ON**  → if limit already passed → closes **immediately**

---

## Server Setup (EC2)

See `DEPLOY.md` for full EC2 + PM2 + AWS Security Group steps.

Quick start:
```bash
cd ~/SignalBasedTradingBot
npm install
cp .env.example .env  # fill in API_KEY, API_SECRET, DASHBOARD_PASSWORD
pm2 start dashboard/server.js --name trading-bot --cwd ~/SignalBasedTradingBot
pm2 save && pm2 startup
```

Webhook URL for signal provider:
```
POST http://<your-ec2-ip>:3000/api/trade
```
