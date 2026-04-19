/**
 * Dashboard Frontend JavaScript
 * Supports: R:R trade signals, holding candles, CTC % trigger, BUY/SELL direction, $ margin
 */

// Relative path — works on any host/port automatically (localhost, EC2 IP, domain, etc.)
const API_BASE = '/api';

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    loadSymbols();
    loadStatus();
    loadPositions();
    loadTrades();
    loadStatistics();

    setupTradeForm();
    setupOrderTypeToggle();
    setupSymbolChangeHandler();
    setupRRCalculator();

    // Auto-refresh every 5 seconds
    setInterval(() => {
        loadStatus();
        loadPositions();
        loadStatistics();
    }, 5000);

    // Refresh trades every 15 seconds (less frequent)
    setInterval(() => {
        loadTrades();
    }, 15000);
});

// ─────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────
function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });
}

// ─────────────────────────────────────────────
// LOAD SYMBOLS
// ─────────────────────────────────────────────
async function loadSymbols() {
    try {
        const response = await fetch(`${API_BASE}/symbols`);
        const data = await response.json();
        if (data.success) {
            const symbolDatalist = document.getElementById('symbolList');
            symbolDatalist.innerHTML = '';
            data.data.forEach(symbol => {
                const option = document.createElement('option');
                option.value = symbol.symbol;
                symbolDatalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading symbols:', error);
    }
}

// ─────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────
async function loadStatus() {
    try {
        const response = await fetch(`${API_BASE}/status`);
        const data = await response.json();
        if (data.success) {
            const { balance, activePositions, statistics, monitoredPositions, pendingLimitOrders } = data.data;

            document.getElementById('balance').textContent = `$${balance.available}`;
            document.getElementById('activePositions').textContent = activePositions;
            document.getElementById('winRate').textContent = `${statistics.winRate}%`;

            const netPnl = parseFloat(statistics.netPnL);
            const netPnlEl = document.getElementById('netPnl');
            netPnlEl.textContent = `$${statistics.netPnL}`;
            netPnlEl.className = 'stat-value ' + (netPnl >= 0 ? 'pnl-positive' : 'pnl-negative');

            // Update monitor stats
            const statMonitored = document.getElementById('statMonitored');
            if (statMonitored) statMonitored.textContent = monitoredPositions || 0;
            const statPending = document.getElementById('statPending');
            if (statPending) statPending.textContent = pendingLimitOrders || 0;
        }
    } catch (error) {
        console.error('Error loading status:', error);
    }
}

// ─────────────────────────────────────────────
// POSITIONS
// ─────────────────────────────────────────────
async function loadPositions() {
    try {
        const response = await fetch(`${API_BASE}/positions`);
        const data = await response.json();
        const tbody = document.getElementById('positionsBody');

        if (data.success && data.data.length > 0) {
            tbody.innerHTML = data.data.map(pos => buildPositionRow(pos)).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="12" class="loading">No active positions</td></tr>';
        }
    } catch (error) {
        console.error('Error loading positions:', error);
    }
}

function buildPositionRow(pos) {
    // Holding candle progress
    const holding = pos.holdingCandles > 0
        ? buildHoldingCell(pos)
        : `<div class="holding-cell"><span style="color:#ccc;font-size:0.82em;">No limit</span></div>`;

    // CTC status badge
    let ctcBadge = '';
    if (!pos.ctcEnabled) {
        ctcBadge = `<span class="ctc-badge off">OFF</span>`;
    } else if (pos.ctcTriggered) {
        ctcBadge = `<span class="ctc-badge triggered">✅ Triggered</span>`;
    } else {
        const pct = pos.ctcTrigger ? (pos.ctcTrigger * 100).toFixed(0) : '50';
        ctcBadge = `<span class="ctc-badge active">ON @${pct}%</span>`;
        if (pos.ctcTriggerPrice) {
            ctcBadge += `<br><small style="color:#888;">@${pos.ctcTriggerPrice.toFixed(4)}</small>`;
        }
    }

    return `
        <tr>
            <td><strong>${pos.symbol}</strong></td>
            <td><span class="side-${pos.side.toLowerCase()}">${pos.side}</span></td>
            <td>
                <div style="font-size:0.85em;color:#666;">Entry</div>
                <div style="font-weight:600;">${pos.entryPrice.toFixed(4)}</div>
                <div style="font-size:0.85em;color:#666;margin-top:4px;">Mark</div>
                <div style="font-weight:600;">${pos.markPrice.toFixed(4)}</div>
            </td>
            <td>${pos.quantity.toFixed(3)}</td>
            <td style="color:#dc3545;font-weight:600;">${pos.stopLoss ? pos.stopLoss.toFixed(4) : '—'}</td>
            <td style="color:#28a745;font-weight:600;">
                ${pos.takeProfit1 ? pos.takeProfit1.toFixed(4) : '—'}<br>
                ${pos.takeProfit2 ? pos.takeProfit2.toFixed(4) : '—'}<br>
                ${pos.takeProfit3 ? pos.takeProfit3.toFixed(4) : '—'}
            </td>
            <td>
                <div class="${pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}" style="font-weight:700;">$${pos.pnl.toFixed(2)}</div>
                <div class="${pos.pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative'}" style="font-size:0.85em;">${pos.pnlPercent}%</div>
                <div style="font-size:0.78em;color:#888;">(${pos.leveragedPnlPercent}% lev)</div>
            </td>
            <td style="color:#2196f3;font-weight:600;">
                ${pos.riskReward || 'N/A'}
                ${pos.riskReward && pos.riskReward !== 'N/A' ? `<br><span style="font-size:0.82em;color:#e74c3c;">-$${pos.riskDollar}</span><br><span style="font-size:0.82em;color:#27ae60;">+$${pos.rewardDollar}</span>` : ''}
            </td>
            <td>${pos.leverage}x</td>
            <td class="holding-cell">${holding}</td>
            <td>${ctcBadge}</td>
            <td>
                <button class="btn btn-danger" onclick="closePosition('${pos.symbol}')">Close</button>
            </td>
        </tr>
    `;
}

function buildHoldingCell(pos) {
    const elapsed = pos.elapsedCandles || 0;
    const total = pos.holdingCandles;
    const pct = total > 0 ? Math.min((elapsed / total) * 100, 100) : 0;
    const remaining = Math.max(total - elapsed, 0);

    // Progress color class
    let progressClass = 'candle-progress';
    if (pct >= 100) progressClass += ' at-limit';
    else if (pct >= 75) progressClass += ' near-limit';

    // Toggle button
    const isEnabled = pos.holdingEnabled;
    const toggleBtnColor = isEnabled ? '#4caf50' : '#aaa';
    const toggleLabel = isEnabled ? 'ON' : 'OFF';

    return `
        <div>
            <label class="switch-label" style="justify-content:center;margin-bottom:4px;">
                <label class="switch" style="width:38px;height:20px;">
                    <input type="checkbox" ${isEnabled ? 'checked' : ''} 
                           onchange="togglePositionHolding('${pos.symbol}', this.checked)"
                           style="opacity:0;width:0;height:0;">
                    <span class="slider" style="border-radius:20px;"></span>
                </label>
                <span style="font-size:0.82em;color:${toggleBtnColor};font-weight:700;">${toggleLabel}</span>
            </label>
            <div class="${progressClass}">${elapsed}/${total} candles</div>
            ${remaining > 0 ? `<div style="font-size:0.75em;color:#aaa;">${remaining} left</div>` : ''}
            <div style="background:#eee;border-radius:4px;height:4px;margin-top:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${pct >= 100 ? '#e53935' : pct >= 75 ? '#e67e22' : '#4caf50'};transition:width 0.3s;"></div>
            </div>
        </div>
    `;
}

// ─────────────────────────────────────────────
// LOAD TRADES (HISTORY TAB)
// ─────────────────────────────────────────────
async function loadTrades() {
    try {
        const response = await fetch(`${API_BASE}/trades`);
        const data = await response.json();
        const tbody = document.getElementById('tradesBody');

        if (data.success && data.data.length > 0) {
            tbody.innerHTML = data.data.slice(0, 30).map(trade => {
                const time = new Date(trade.timestamp).toLocaleString();
                const statusClass = `status-${trade.status}`;
                const side = trade.side || (trade.signal?.direction === 'BUY' ? 'LONG' : (trade.signal?.direction === 'SELL' ? 'SHORT' : '—'));

                // R:R from stored rr field or calculated
                let rr = trade.rr ? `1:${parseFloat(trade.rr).toFixed(2)}` : 'N/A';
                if (rr === 'N/A' && trade.signal && trade.signal.stopLoss && trade.price) {
                    const isLong = side === 'LONG';
                    const entry = trade.price;
                    const sl = trade.signal.stopLoss;
                    const tp1 = trade.takeProfit1 || trade.signal.takeProfit1;
                    const tp2 = trade.takeProfit2 || trade.signal.takeProfit2;
                    const tp3 = trade.takeProfit3 || trade.signal.takeProfit3;

                    if (tp1 && tp2 && tp3) {
                        const qty = trade.quantity || 1;
                        const slDiff = isLong ? (entry - sl) : (sl - entry);
                        const risk = qty * slDiff;
                        const tp1Diff = isLong ? (tp1 - entry) : (entry - tp1);
                        const tp2Diff = isLong ? (tp2 - entry) : (entry - tp2);
                        const tp3Diff = isLong ? (tp3 - entry) : (entry - tp3);
                        const reward = (qty * 0.33 * tp1Diff) + (qty * 0.33 * tp2Diff) + (qty * 0.34 * tp3Diff);
                        if (risk > 0) rr = `1:${(reward / risk).toFixed(2)}`;
                    }
                }

                // Holding info
                const holdingCandles = trade.holdingCandles || trade.signal?.holdingCandles || 0;
                const holdingDisplay = holdingCandles > 0 ? `${holdingCandles} candles` : '—';

                // PnL display
                let pnlDisplay = '—';
                if (trade.status === 'closed' && trade.pnl !== undefined) {
                    const pnlClass = trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                    pnlDisplay = `<span class="${pnlClass}" style="font-weight:700;">$${parseFloat(trade.pnl).toFixed(2)}</span>`;
                }

                // Close reason badge
                let reasonDisplay = '—';
                if (trade.closeReason) {
                    const reasonColors = {
                        'manual': '#2196f3',
                        'automatic': '#4caf50',
                        'holding-candles-limit': '#ff9800',
                        'emergency-no-sl-data': '#f44336',
                        'emergency-sl-failed': '#f44336',
                        'safety-no-sl': '#f44336'
                    };
                    const color = reasonColors[trade.closeReason] || '#999';
                    reasonDisplay = `<span style="color:${color};font-size:0.82em;font-weight:600;">${trade.closeReason}</span>`;
                }

                return `
                    <tr>
                        <td>${time}</td>
                        <td><strong>${trade.symbol}</strong></td>
                        <td><span class="side-${side.toLowerCase()}">${side}</span></td>
                        <td>${trade.orderType || 'MARKET'}</td>
                        <td>${trade.price ? parseFloat(trade.price).toFixed(4) : 'N/A'}</td>
                        <td>${trade.quantity || 'N/A'}</td>
                        <td style="color:#2196f3;font-weight:600;">${rr}</td>
                        <td>${holdingDisplay}</td>
                        <td>${pnlDisplay}</td>
                        <td><span class="${statusClass}">${trade.status}</span></td>
                        <td>${reasonDisplay}</td>
                    </tr>
                `;
            }).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="11" class="loading">No trades yet</td></tr>';
        }
    } catch (error) {
        console.error('Error loading trades:', error);
    }
}

// ─────────────────────────────────────────────
// STATISTICS
// ─────────────────────────────────────────────
async function loadStatistics() {
    try {
        const response = await fetch(`${API_BASE}/statistics`);
        const data = await response.json();
        if (data.success) {
            const stats = data.data;
            document.getElementById('totalTrades').textContent = stats.totalTrades;
            document.getElementById('wins').textContent = stats.wins;
            document.getElementById('losses').textContent = stats.losses;

            const totalPnl = parseFloat(stats.totalPnL);
            const totalPnlEl = document.getElementById('totalPnl');
            totalPnlEl.textContent = `$${stats.totalPnL}`;
            totalPnlEl.className = 'stat-number ' + (totalPnl >= 0 ? 'stat-win' : 'stat-loss');

            document.getElementById('totalFees').textContent = `$${stats.totalFees}`;

            const avgPnl = parseFloat(stats.avgPnL) || 0;
            const avgPnlEl = document.getElementById('avgPnl');
            avgPnlEl.textContent = `$${stats.avgPnL || '0.00'}`;
            avgPnlEl.className = 'stat-number ' + (avgPnl >= 0 ? 'stat-win' : 'stat-loss');
        }
    } catch (error) {
        console.error('Error loading statistics:', error);
    }
}

// ─────────────────────────────────────────────
// TRADE FORM
// ─────────────────────────────────────────────
function setupTradeForm() {
    const form = document.getElementById('tradeForm');
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Remove old messages
        form.parentElement.querySelectorAll('.message').forEach(m => m.remove());

        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Executing…';
        submitBtn.style.opacity = '0.7';

        const marginMode = document.getElementById('marginMode').value;
        const ctcEnabled = document.getElementById('ctcEnabled').checked;
        const hasEntryTime = document.getElementById('entryTime').value;
        const rr = parseFloat(document.getElementById('rrRatioInput').value) || null;

        // If manual TPs are filled, prefer them; else rely on rr
        const tp1Manual = parseFloat(document.getElementById('takeProfit1').value) || null;
        const tp2Manual = parseFloat(document.getElementById('takeProfit2').value) || null;
        const tp3Manual = parseFloat(document.getElementById('takeProfit3').value) || null;

        const signal = {
            symbol: document.getElementById('symbol').value.trim().toUpperCase(),
            direction: document.getElementById('direction').value,
            orderType: document.getElementById('orderType').value,
            leverage: parseInt(document.getElementById('leverage').value),
            riskMode: document.getElementById('riskMode').value,
            stopLoss: parseFloat(document.getElementById('stopLoss').value),
            rr: rr,
            marginMode: marginMode,
            holdingCandles: parseInt(document.getElementById('holdingCandles').value) || 0,
            ctcEnabled: ctcEnabled,
            ctcTrigger: ctcEnabled ? (parseFloat(document.getElementById('ctcTrigger').value) || 40) / 100 : null
        };

        // Margin fields
        if (marginMode === 'dollar') {
            signal.marginDollar = parseFloat(document.getElementById('marginDollar').value);
        } else {
            signal.walletPercentage = parseFloat(document.getElementById('walletPercentage').value);
        }

        // Limit price
        if (signal.orderType === 'LIMIT') {
            signal.limitPrice = parseFloat(document.getElementById('limitPrice').value);
        }

        // Manual TP override
        if (tp1Manual && tp2Manual && tp3Manual) {
            signal.takeProfit1 = tp1Manual;
            signal.takeProfit2 = tp2Manual;
            signal.takeProfit3 = tp3Manual;
        }

        // Entry time
        if (hasEntryTime) {
            signal.entryTime = parseInt(hasEntryTime);
        }

        try {
            const response = await fetch(`${API_BASE}/trade`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signal)
            });
            const data = await response.json();

            if (data.success) {
                showMessage('success', `✅ Trade executed! Order ID: ${data.data.orderId}`);
                form.reset();
                document.getElementById('marginMode').value = 'percent';
                document.getElementById('computedTPs').classList.remove('show');
                document.getElementById('riskRewardDisplay').style.display = 'none';
                loadPositions();
                loadTrades();
            } else {
                showMessage('error', `❌ ${data.error}`);
            }
        } catch (error) {
            showMessage('error', `❌ Failed: ${error.message}`);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalBtnText;
            submitBtn.style.opacity = '1';
        }
    });
}

// ─────────────────────────────────────────────
// ORDER TYPE TOGGLE
// ─────────────────────────────────────────────
function setupOrderTypeToggle() {
    const orderTypeSelect = document.getElementById('orderType');
    const limitPriceGroup = document.getElementById('limitPriceGroup');
    const limitPriceInput = document.getElementById('limitPrice');

    orderTypeSelect.addEventListener('change', () => {
        if (orderTypeSelect.value === 'LIMIT') {
            limitPriceGroup.style.display = 'block';
            limitPriceInput.required = true;
        } else {
            limitPriceGroup.style.display = 'none';
            limitPriceInput.required = false;
        }
    });
}

// ─────────────────────────────────────────────
// MARGIN MODE TOGGLE
// ─────────────────────────────────────────────
function setMarginMode(mode) {
    document.getElementById('marginMode').value = mode;
    document.getElementById('btnPercent').classList.toggle('active', mode === 'percent');
    document.getElementById('btnDollar').classList.toggle('active', mode === 'dollar');
    document.getElementById('walletPctGroup').style.display = mode === 'percent' ? 'block' : 'none';
    document.getElementById('marginDollarGroup').style.display = mode === 'dollar' ? 'block' : 'none';
    // Recalculate preview
    calculateRiskReward();
}

// ─────────────────────────────────────────────
// CTC TOGGLE
// ─────────────────────────────────────────────
function toggleCTCTrigger() {
    const enabled = document.getElementById('ctcEnabled').checked;
    document.getElementById('ctcTriggerGroup').style.display = enabled ? 'block' : 'none';
    document.getElementById('ctcEnabledLabel').textContent = enabled ? 'Enabled' : 'Disabled';
}

// ─────────────────────────────────────────────
// R:R CALCULATOR + COMPUTED TPs
// ─────────────────────────────────────────────
function setupRRCalculator() {
    const inputs = ['symbol', 'direction', 'stopLoss', 'rrRatioInput', 'walletPercentage', 'marginDollar', 'leverage', 'limitPrice'];
    let debounceTimer;

    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(calculateRiskReward, 350);
            });
            el.addEventListener('change', calculateRiskReward);
        }
    });

    // Also listen to direction and orderType selects
    ['direction', 'orderType'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', calculateRiskReward);
    });
}

function calculateRiskReward() {
    const symbol = document.getElementById('symbol').value;
    const direction = document.getElementById('direction').value; // BUY / SELL
    const side = direction === 'BUY' ? 'LONG' : 'SHORT';
    const orderType = document.getElementById('orderType').value;
    const rr = parseFloat(document.getElementById('rrRatioInput').value);
    const sl = parseFloat(document.getElementById('stopLoss').value);

    // Entry price: use limit price if LIMIT order, otherwise use displayed symbol price
    let entry = 0;
    if (orderType === 'LIMIT') {
        entry = parseFloat(document.getElementById('limitPrice').value) || 0;
    } else {
        const priceText = document.getElementById('symbolPrice').textContent.replace(/[^0-9.]/g, '');
        entry = parseFloat(priceText) || 0;
    }

    // Computed TPs from R:R
    if (rr && sl && entry) {
        const isLong = side === 'LONG';
        const slDist = Math.abs(entry - sl);
        const tpDist = slDist * rr;
        const tp1 = isLong ? entry + tpDist * 0.33 : entry - tpDist * 0.33;
        const tp2 = isLong ? entry + tpDist * 0.67 : entry - tpDist * 0.67;
        const tp3 = isLong ? entry + tpDist : entry - tpDist;

        document.getElementById('computedTP1').textContent = tp1.toFixed(6);
        document.getElementById('computedTP2').textContent = tp2.toFixed(6);
        document.getElementById('computedTP3').textContent = tp3.toFixed(6);
        document.getElementById('computedTPs').classList.add('show');

        // Trade analysis preview
        const marginMode = document.getElementById('marginMode').value;
        const leverage = parseInt(document.getElementById('leverage').value) || 10;
        const balanceText = document.getElementById('balance').textContent;
        const balance = parseFloat(balanceText.replace('$', '').replace(',', '')) || 0;

        let margin = 0;
        if (marginMode === 'dollar') {
            margin = parseFloat(document.getElementById('marginDollar').value) || 0;
        } else {
            const walletPct = parseFloat(document.getElementById('walletPercentage').value) || 0;
            margin = (balance * walletPct) / 100;
        }

        if (margin > 0 && entry > 0) {
            const qty = (margin * leverage) / entry;
            const slDiff = isLong ? (entry - sl) : (sl - entry);
            const riskAmount = qty * slDiff;
            const tp1Diff = isLong ? (tp1 - entry) : (entry - tp1);
            const tp2Diff = isLong ? (tp2 - entry) : (entry - tp2);
            const tp3Diff = isLong ? (tp3 - entry) : (entry - tp3);
            const tp1Profit = qty * 0.33 * tp1Diff;
            const tp2Profit = qty * 0.33 * tp2Diff;
            const tp3Profit = qty * 0.34 * tp3Diff;
            const totalProfit = tp1Profit + tp2Profit + tp3Profit;
            const rrRatio = riskAmount > 0 ? totalProfit / riskAmount : 0;

            document.getElementById('rrPositionSize').textContent = `${qty.toFixed(3)} ${symbol.replace('USDT', '')}`;
            document.getElementById('rrRisk').textContent = `-$${riskAmount.toFixed(2)}`;
            document.getElementById('rrTP1').textContent = `+$${tp1Profit.toFixed(2)}`;
            document.getElementById('rrTP2').textContent = `+$${tp2Profit.toFixed(2)}`;
            document.getElementById('rrTP3').textContent = `+$${tp3Profit.toFixed(2)}`;
            document.getElementById('rrRatio').textContent = `1:${rrRatio.toFixed(2)}`;
            document.getElementById('riskRewardDisplay').style.display = 'block';
        }
    } else {
        document.getElementById('computedTPs').classList.remove('show');
        document.getElementById('riskRewardDisplay').style.display = 'none';
    }
}

// ─────────────────────────────────────────────
// SYMBOL CHANGE HANDLER
// ─────────────────────────────────────────────
function setupSymbolChangeHandler() {
    const symbolInput = document.getElementById('symbol');
    const leverageInput = document.getElementById('leverage');
    const symbolPriceSpan = document.getElementById('symbolPrice');
    let debounceTimer;

    const updateSymbolInfo = async () => {
        const symbol = symbolInput.value.trim().toUpperCase();
        if (!symbol) {
            symbolPriceSpan.textContent = '';
            return;
        }

        const datalist = document.getElementById('symbolList');
        const options = Array.from(datalist.options).map(opt => opt.value);
        if (!options.includes(symbol)) {
            symbolPriceSpan.textContent = '';
            return;
        }

        try {
            const infoResponse = await fetch(`${API_BASE}/symbol-info/${symbol}`);
            const infoData = await infoResponse.json();
            if (infoData.success) {
                const maxLeverage = infoData.data.maxLeverage;
                leverageInput.max = maxLeverage;
                const leverageInfo = document.getElementById('leverageInfo');
                if (leverageInfo) leverageInfo.textContent = `Max: ${maxLeverage}x`;
                if (parseInt(leverageInput.value) > maxLeverage) leverageInput.value = maxLeverage;
            }

            const priceResponse = await fetch(`${API_BASE}/price/${symbol}`);
            const priceData = await priceResponse.json();
            if (priceData.success) {
                const price = priceData.data.price;
                symbolPriceSpan.textContent = `(${price.toFixed(6)})`;
                calculateRiskReward();
            }
        } catch (error) {
            console.error('Error fetching symbol info:', error);
        }
    };

    symbolInput.addEventListener('blur', updateSymbolInfo);
    symbolInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateSymbolInfo, 500);
    });
}

// ─────────────────────────────────────────────
// HOLDING TOGGLES
// ─────────────────────────────────────────────

/**
 * Toggle per-position holding
 * @param {string} symbol
 * @param {boolean} enabled
 */
async function togglePositionHolding(symbol, enabled) {
    try {
        const response = await fetch(`${API_BASE}/positions/${symbol}/holding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await response.json();
        if (data.success) {
            // The position might have closed immediately (if enabled and already exceeded)
            loadPositions();
            loadTrades();
        } else {
            showMessage('error', `❌ ${data.error}`);
            loadPositions(); // refresh to revert toggle UI
        }
    } catch (error) {
        showMessage('error', `❌ Failed: ${error.message}`);
        loadPositions();
    }
}

// ─────────────────────────────────────────────
// CLOSE POSITION
// ─────────────────────────────────────────────
async function closePosition(symbol) {
    if (!confirm(`Close ${symbol} position?`)) return;

    try {
        const response = await fetch(`${API_BASE}/close/${symbol}`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            showMessage('success', `✅ ${symbol} closed. PnL: $${data.pnl?.toFixed(2) || 'N/A'}`);
            loadPositions();
            loadTrades();
        } else {
            showMessage('error', `❌ ${data.error}`);
        }
    } catch (error) {
        showMessage('error', `❌ Failed: ${error.message}`);
    }
}

// ─────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────
function showMessage(type, message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message message-${type}`;
    messageDiv.textContent = message;

    const form = document.getElementById('tradeForm');
    const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

    if (submitBtn) {
        submitBtn.parentNode.insertBefore(messageDiv, submitBtn.nextSibling);
    } else {
        document.querySelector('.container').prepend(messageDiv);
    }

    setTimeout(() => messageDiv.remove(), 8000);
}
