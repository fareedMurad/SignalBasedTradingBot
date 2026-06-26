#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  start-tunnel.sh
#
#  Opens an SSH reverse tunnel from this Mac to your EC2 instance.
#  capie-mvp (on EC2) then calls:  http://localhost:9090/api/trade
#
#  Usage:
#    1. Fill in EC2_IP and SSH_KEY below (or export them before running)
#    2. bash start-tunnel.sh
#
#  The tunnel runs in foreground — Ctrl+C to stop.
#  To run in background: bash start-tunnel.sh &
# ─────────────────────────────────────────────────────────────────────────────

EC2_USER="${EC2_USER:-ubuntu}"
EC2_IP="${EC2_IP:-YOUR_EC2_IP}"          # ← fill in your EC2 IP
SSH_KEY="${SSH_KEY:-~/.ssh/id_rsa}"      # ← fill in your .pem key path
LOCAL_PORT=3000                          # dashboard port on this Mac
REMOTE_PORT=9090                         # port exposed on EC2 localhost (8080 = capie-mvp own server)

if [ "$EC2_IP" = "YOUR_EC2_IP" ]; then
    echo "❌ Set EC2_IP first!"
    echo "   Usage: EC2_IP=1.2.3.4 SSH_KEY=~/.ssh/key.pem bash start-tunnel.sh"
    exit 1
fi

# Fix .pem permissions automatically (SSH requires 600, macOS Downloads sets 644)
chmod 600 "${SSH_KEY}" 2>/dev/null && echo "🔑 Key permissions set to 600"

echo "🔌 Opening SSH reverse tunnel (auto-reconnect on drop)..."
echo "   Mac:${LOCAL_PORT}  →  ${EC2_USER}@${EC2_IP}:${REMOTE_PORT}"
echo "   capie-mvp endpoint: http://localhost:${REMOTE_PORT}/api/trade"
echo "   Press Ctrl+C to stop"
echo ""

# Auto-reconnect loop — restarts the tunnel within 5s if it drops
while true; do
    echo "$(date '+%Y-%m-%dT%H:%M:%S') 🔌 Connecting tunnel..."

    # Start SSH in background so we can print a confirmation once it stabilises
    ssh -N \
        -R ${REMOTE_PORT}:localhost:${LOCAL_PORT} \
        -i "${SSH_KEY}" \
        -o ServerAliveInterval=20 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 \
        ${EC2_USER}@${EC2_IP} &
    SSH_PID=$!

    # Give SSH 3 seconds to connect; if it's still alive → tunnel is up
    sleep 3
    if kill -0 $SSH_PID 2>/dev/null; then
        echo "$(date '+%Y-%m-%dT%H:%M:%S') ✅ Tunnel CONNECTED — Mac:${LOCAL_PORT} → EC2:${REMOTE_PORT} (pid:${SSH_PID})"
        echo "   Waiting silently while tunnel is live... Ctrl+C to stop."
        wait $SSH_PID   # blocks here until tunnel dies
    else
        echo "$(date '+%Y-%m-%dT%H:%M:%S') ❌ SSH failed to start (port may already be in use?)"
    fi

    EXIT_CODE=$?
    echo "$(date '+%Y-%m-%dT%H:%M:%S') ⚠️  Tunnel exited (code ${EXIT_CODE}) — reconnecting in 5s..."
    sleep 5
done
