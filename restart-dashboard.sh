#!/bin/bash

# Kill all node processes running the dashboard
echo "🛑 Stopping old dashboard..."
pkill -f "node dashboard/server.js" || true
sleep 2

# Start fresh dashboard
echo "🚀 Starting fresh dashboard..."
cd "$(dirname "$0")"
npm run dashboard
