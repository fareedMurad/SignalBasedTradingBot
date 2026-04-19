# Signal Provider — Trade Execution API Reference

This document is for the signal provider. Send an HTTP POST request to the bot endpoint to execute a trade.

---

## Endpoint

```
POST http://13.232.123.216:3000/api/trade
Content-Type: application/json
```

Default port is **3000** (configurable via `DASHBOARD_PORT` in `.env`).

---

## Signal Model (how the bot works)

| Concept | How it works |
|---------|-------------|
| **TP** | Single take profit, computed as `entry ± (entry - SL) × rr`. 100% of position closes at this level. |
| **SL** | If mark price hits SL → 100% close |
| **CTC** | When price reaches `ctcTrigger × TP_distance` from entry → SL is moved to break-even. Trade continues. |
| **Holding candles** | After `holdingCandles × 3 minutes` from `entryTime` → force close entire position |

---

## Payload Schema

```json
{
  "symbol":         "BTCUSDT",       // required — Binance Futures pair
  "direction":      "BUY",           // required — "BUY" (long) | "SELL" (short)
  "stopLoss":       74000,           // required — stop loss price
  "rr":             2.5,             // required — risk:reward ratio (e.g. 2.5)
                                     //   TP = entry + (entry - SL) × 2.5  (for BUY)
                                     //   TP = entry - (SL - entry) × 2.5  (for SELL)
  "leverage":       10,              // required — 1–125
  "riskMode":       "isolated",      // required — "isolated" | "crossed"
  "marginDollar":   100,             // required — fixed $ margin per trade

  "ctcEnabled":     true,            // optional — enable CTC (default: false)
  "ctcTrigger":     0.4,             // optional — fraction of TP dist to fire CTC
                                     //   0.4 = when price moves 40% toward TP → move SL to BE

  "holdingCandles": 10,              // optional — close after 10 × 3-min candles from entryTime
  "entryTime":      1714521600000,   // optional — unix ms of signal birth (for holding countdown)

  "orderType":      "MARKET"         // optional — "MARKET" (default) | "LIMIT"
}
```

> **Note:** `marginMode` defaults to `"dollar"`. Do not send `walletPercentage`.

---

## Example Payloads

### BUY (long) with CTC and holding

```json
{
  "symbol":         "BTCUSDT",
  "direction":      "BUY",
  "stopLoss":       74000,
  "rr":             2.5,
  "leverage":       10,
  "riskMode":       "isolated",
  "marginDollar":   100,
  "ctcEnabled":     true,
  "ctcTrigger":     0.4,
  "holdingCandles": 10,
  "entryTime":      1714521600000
}
```

**What happens:**
- Entry (market) ≈ 75,000. SL distance = 1,000. `rr = 2.5` → TP = 75,000 + 2,500 = **77,500**
- CTC fires at 75,000 + 0.4 × 2,500 = **76,000** → SL moves to break-even (~75,003)
- If 10 × 3-min candles (30 min) pass since `entryTime` → force-close
- If TP 77,500 is hit first → 100% close ✅

---

### SELL (short), no CTC, no holding

```json
{
  "symbol":         "ETHUSDT",
  "direction":      "SELL",
  "stopLoss":       3200,
  "rr":             2.0,
  "leverage":       5,
  "riskMode":       "isolated",
  "marginDollar":   50
}
```

**What happens:**
- Entry ≈ 3,000. SL distance = 200. `rr = 2.0` → TP = 3,000 - 400 = **2,600**
- No CTC, no holding — pure SL/TP trade.

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | ✅ | Binance Futures pair, e.g. `BTCUSDT` |
| `direction` | string | ✅ | `"BUY"` (long) or `"SELL"` (short) |
| `stopLoss` | number | ✅ | Stop loss price |
| `rr` | number | ✅ | Risk:reward ratio. e.g. `2.5` = TP is 2.5× the SL distance away |
| `leverage` | number | ✅ | 1 to 125 |
| `riskMode` | string | ✅ | `"isolated"` or `"crossed"` |
| `marginDollar` | number | ✅ | Fixed dollar margin per trade, e.g. `100` |
| `ctcEnabled` | boolean | ❌ | Enable CTC (move SL to BE before TP is hit). Default: `false` |
| `ctcTrigger` | number | ❌ | Fraction of TP distance to fire CTC. `0.4` = 40%. Default: `0.5` |
| `holdingCandles` | number | ❌ | Max 3-min candles before force-close. `0` = no limit. Default: `0` |
| `entryTime` | number (ms) | ❌ | Unix ms timestamp of signal entry (start of holding countdown) |
| `orderType` | string | ❌ | `"MARKET"` (default) or `"LIMIT"` |

---

## Successful Response

```json
{
  "success": true,
  "data": {
    "tradeId":        "daf8579a-e930-4bf8-b95c-bef438442239",
    "orderId":        13050663972,
    "symbol":         "BTCUSDT",
    "side":           "LONG",
    "orderType":      "MARKET",
    "quantity":       0.0132,
    "price":          75000,
    "stopLoss":       74000,
    "takeProfit1":    77500,
    "rr":             2.5,
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
  "error": "Missing required field: rr (risk:reward ratio, e.g. 2.5)"
}
```

---

## CTC — Close to Cost

CTC = move Stop Loss to break-even **before** TP is hit (protecting your entry).

- Does **not** close the trade — it just moves the SL to entry price (+ small fee buffer)
- Example: Entry 75,000 | TP 77,500 | `ctcTrigger: 0.4`
  - CTC fires when price reaches: 75,000 + 0.4 × 2,500 = **76,000**
  - SL is moved to ≈75,030 (entry + 0.04% fee buffer)
  - Trade continues running toward TP at 77,500

---

## Holding Candles

- `holdingCandles: 10` = force-close after **10 × 3-minute candles = 30 minutes** from `entryTime`
- Counted from `entryTime` (unix ms). If `entryTime` not sent, countdown starts from when the bot placed the order
- Each position has a **holding toggle** in the dashboard Active Positions table:
  - Toggle **OFF** → bot ignores the candle limit, trade runs until SL/TP
  - Toggle **ON** → bot resumes watching. If limit is already past → closes **immediately**

---

## TP Computation

```
BUY:  TP = entryPrice + abs(entryPrice - stopLoss) × rr
SELL: TP = entryPrice - abs(entryPrice - stopLoss) × rr
```

Example: entry=75,000 | SL=74,000 | rr=2.5
```
TP = 75,000 + 1,000 × 2.5 = 77,500
```

---

## Server Setup

```bash
cd SignalBasedTradingBot
node dashboard/server.js
```

API available at `http://<your-ip>:3000`.

### Expose to the internet (for webhook)

```bash
# Quick test with ngrok
ngrok http 3000
# Provider sends to: https://xxxx.ngrok.io/api/trade

# Production: use a VPS with your public IP
```

---

## Security (Recommended)

Add `WEBHOOK_SECRET=mysecret` to `.env` and send it in every request:

```
X-Webhook-Secret: mysecret
```
