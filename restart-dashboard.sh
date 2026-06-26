#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  restart-dashboard.sh
#  Kills any leftover bot processes, then starts the dashboard with live logs.
#  Usage:  bash restart-dashboard.sh
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")"

echo "🛑 Stopping old dashboard (if running)..."
pkill -f "node dashboard/server.js" 2>/dev/null; sleep 1

echo "🛑 Killing stale mexc-bot (if running)..."
pkill -f "mexc-bot/server.js" 2>/dev/null; sleep 0.5

echo ""
echo "🚀 Starting Signal Trading Bot Dashboard..."
echo "   → Dashboard: http://localhost:${DASHBOARD_PORT:-3000}"
echo "   → Press Ctrl+C to stop"
echo ""

npm run dashboard
