/**
 * Dashboard Frontend JavaScript
 */

const API_BASE = 'http://localhost:3000/api';

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    loadSymbols();
    loadStatus();
    loadPositions();
    loadTrades();
    loadStatistics();

    // Setup form handlers
    setupTradeForm();
    setupOrderTypeToggle();
    setupSymbolChangeHandler();

    // Auto-refresh every 5 seconds
    setInterval(() => {
        loadStatus();
        loadPositions();
        loadTrades();
        loadStatistics();
    }, 5000);
});

/**
 * Load available symbols
 */
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

/**
 * Load bot status
 */
async function loadStatus() {
    try {
        const response = await fetch(`${API_BASE}/status`);
        const data = await response.json();

        if (data.success) {
            const { balance, activePositions, statistics } = data.data;

            document.getElementById('balance').textContent = `$${balance.available}`;
            document.getElementById('activePositions').textContent = activePositions;
            document.getElementById('winRate').textContent = `${statistics.winRate}%`;

            const netPnl = parseFloat(statistics.netPnL);
            const netPnlEl = document.getElementById('netPnl');
            netPnlEl.textContent = `$${statistics.netPnL}`;
            netPnlEl.className = 'stat-value ' + (netPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
        }
    } catch (error) {
        console.error('Error loading status:', error);
    }
}

/**
 * Load active positions
 */
async function loadPositions() {
    try {
        const response = await fetch(`${API_BASE}/positions`);
        const data = await response.json();

        const tbody = document.getElementById('positionsBody');

        if (data.success && data.data.length > 0) {
            tbody.innerHTML = data.data.map(pos => `
                <tr>
                    <td><strong>${pos.symbol}</strong></td>
                    <td><span class="side-${pos.side.toLowerCase()}">${pos.side}</span></td>
                    <td>
                        <div style="font-size: 0.85em; color: #666;">Entry</div>
                        <div style="font-weight: 600;">${pos.entryPrice.toFixed(4)}</div>
                        <div style="font-size: 0.85em; color: #666; margin-top: 4px;">Mark</div>
                        <div style="font-weight: 600;">${pos.markPrice.toFixed(4)}</div>
                    </td>
                    <td>${pos.quantity.toFixed(2)}</td>
                    <td style="color: #dc3545; font-weight: 600;">${pos.stopLoss ? pos.stopLoss.toFixed(4) : '—'}</td>
                    <td style="color: #28a745; font-weight: 600;">
                        ${pos.takeProfit1 ? pos.takeProfit1.toFixed(4) : '—'}<br>
                        ${pos.takeProfit2 ? pos.takeProfit2.toFixed(4) : '—'}<br>
                        ${pos.takeProfit3 ? pos.takeProfit3.toFixed(4) : '—'}
                    </td>
                    <td>
                        <div class="${pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}" style="font-weight: 700;">$${pos.pnl.toFixed(2)}</div>
                        <div class="${pos.pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative'}" style="font-size: 0.9em;">${pos.pnlPercent}%</div>
                    </td>
                    <td style="color: #2196f3; font-weight: 600;">
                        ${pos.riskReward || 'N/A'}
                        ${pos.riskReward && pos.riskReward !== 'N/A' ? `<br><span style="font-size: 0.85em; color: #e74c3c;">Risk: -$${pos.riskDollar}</span><br><span style="font-size: 0.85em; color: #27ae60;">Reward: +$${pos.rewardDollar}</span>` : ''}
                    </td>
                    <td>${pos.leverage}x</td>
                    <td>
                        <button class="btn btn-danger" onclick="closePosition('${pos.symbol}')">Close</button>
                    </td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="10" class="loading">No active positions</td></tr>';
        }
    } catch (error) {
        console.error('Error loading positions:', error);
    }
}

/**
 * Load trade history
 */
async function loadTrades() {
    try {
        const response = await fetch(`${API_BASE}/trades`);
        const data = await response.json();

        const tbody = document.getElementById('tradesBody');

        if (data.success && data.data.length > 0) {
            tbody.innerHTML = data.data.slice(0, 20).map(trade => {
                const time = new Date(trade.timestamp).toLocaleString();
                const statusClass = `status-${trade.status}`;

                // Calculate R:R from signal data
                let rr = 'N/A';
                if (trade.signal && trade.signal.stopLoss && trade.price) {
                    const isLong = trade.side === 'LONG';
                    const entry = trade.price;
                    const sl = trade.signal.stopLoss;
                    const tp1 = trade.signal.takeProfit1;
                    const tp2 = trade.signal.takeProfit2;
                    const tp3 = trade.signal.takeProfit3;
                    
                    if (tp1 && tp2 && tp3) {
                        const qty = trade.quantity || 1;
                        const slDiff = isLong ? (entry - sl) : (sl - entry);
                        const risk = qty * slDiff;
                        
                        const tp1Diff = isLong ? (tp1 - entry) : (entry - tp1);
                        const tp2Diff = isLong ? (tp2 - entry) : (entry - tp2);
                        const tp3Diff = isLong ? (tp3 - entry) : (entry - tp3);
                        
                        const reward = (qty * 0.33 * tp1Diff) + (qty * 0.33 * tp2Diff) + (qty * 0.34 * tp3Diff);
                        
                        if (risk > 0) {
                            rr = `1:${(reward / risk).toFixed(2)}`;
                        }
                    }
                }

                // Display PnL if trade is closed
                let pnlDisplay = '—';
                if (trade.status === 'closed' && trade.pnl !== undefined) {
                    const pnlClass = trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                    pnlDisplay = `<span class="${pnlClass}" style="font-weight: 700;">$${trade.pnl.toFixed(2)}</span>`;
                }

                return `
                    <tr>
                        <td>${time}</td>
                        <td><strong>${trade.symbol}</strong></td>
                        <td><span class="side-${trade.side.toLowerCase()}">${trade.side}</span></td>
                        <td>${trade.orderType}</td>
                        <td>${trade.price ? trade.price.toFixed(4) : 'N/A'}</td>
                        <td>${trade.quantity || 'N/A'}</td>
                        <td style="color: #2196f3; font-weight: 600;">${rr}</td>
                        <td>${pnlDisplay}</td>
                        <td><span class="${statusClass}">${trade.status}</span></td>
                        <td>${trade.ctcLevel}</td>
                    </tr>
                `;
            }).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="10" class="loading">No trades yet</td></tr>';
        }
    } catch (error) {
        console.error('Error loading trades:', error);
    }
}

/**
 * Load statistics
 */
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

/**
 * Setup trade form submission
 */
function setupTradeForm() {
    const form = document.getElementById('tradeForm');
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Clear any existing messages
        const existingMessages = form.parentElement.querySelectorAll('.message');
        existingMessages.forEach(msg => msg.remove());

        // Set loading state
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Executing Trade...';
        submitBtn.style.opacity = '0.7';

        const signal = {
            symbol: document.getElementById('symbol').value,
            side: document.getElementById('side').value,
            orderType: document.getElementById('orderType').value,
            walletPercentage: parseFloat(document.getElementById('walletPercentage').value),
            leverage: parseInt(document.getElementById('leverage').value),
            riskMode: document.getElementById('riskMode').value,
            stopLoss: parseFloat(document.getElementById('stopLoss').value),
            takeProfit1: parseFloat(document.getElementById('takeProfit1').value),
            takeProfit2: parseFloat(document.getElementById('takeProfit2').value),
            takeProfit3: parseFloat(document.getElementById('takeProfit3').value),
            ctcLevel: document.getElementById('ctcLevel').value
        };

        // Add limit price if order type is LIMIT
        if (signal.orderType === 'LIMIT') {
            signal.limitPrice = parseFloat(document.getElementById('limitPrice').value);
        }

        try {
            const response = await fetch(`${API_BASE}/trade`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(signal)
            });

            const data = await response.json();

            if (data.success) {
                showMessage('success', `✅ Trade executed successfully! Order ID: ${data.data.orderId}`);
                form.reset();
                loadPositions();
                loadTrades();
            } else {
                showMessage('error', `❌ ${data.error}`);
            }
        } catch (error) {
            showMessage('error', `❌ Failed to execute trade: ${error.message}`);
        } finally {
            // Reset button state
            submitBtn.disabled = false;
            submitBtn.textContent = originalBtnText;
            submitBtn.style.opacity = '1';
        }
    });
}

/**
 * Setup order type toggle
 */
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

/**
 * Calculate and display risk/reward
 */
function calculateRiskReward() {
    const symbol = document.getElementById('symbol').value;
    const side = document.getElementById('side').value;
    const entry = parseFloat(document.getElementById('limitPrice').value || document.getElementById('symbolPrice').textContent.replace(/[^0-9.]/g, ''));
    const sl = parseFloat(document.getElementById('stopLoss').value);
    const tp1 = parseFloat(document.getElementById('takeProfit1').value);
    const tp2 = parseFloat(document.getElementById('takeProfit2').value);
    const tp3 = parseFloat(document.getElementById('takeProfit3').value);
    const walletPct = parseFloat(document.getElementById('walletPercentage').value);
    const leverage = parseInt(document.getElementById('leverage').value);

    // Validate all inputs
    if (!entry || !sl || !tp1 || !tp2 || !tp3 || !walletPct || !leverage) {
        document.getElementById('riskRewardDisplay').style.display = 'none';
        return;
    }

    // Get balance (from header stat)
    const balanceText = document.getElementById('balance').textContent;
    const balance = parseFloat(balanceText.replace('$', '').replace(',', ''));
    
    if (!balance || balance === 0) return;

    // Calculate position size
    const margin = (balance * walletPct) / 100;
    const notionalValue = margin * leverage;
    const quantity = notionalValue / entry;

    const isLong = side === 'LONG';

    // Calculate risk (SL)
    const slDiff = isLong ? (entry - sl) : (sl - entry);
    const riskAmount = quantity * slDiff;

    // Calculate TP profits (33%, 33%, 34% distribution)
    const tp1Diff = isLong ? (tp1 - entry) : (entry - tp1);
    const tp2Diff = isLong ? (tp2 - entry) : (entry - tp2);
    const tp3Diff = isLong ? (tp3 - entry) : (entry - tp3);

    const tp1Profit = (quantity * 0.33) * tp1Diff;
    const tp2Profit = (quantity * 0.33) * tp2Diff;
    const tp3Profit = (quantity * 0.34) * tp3Diff;

    const totalProfit = tp1Profit + tp2Profit + tp3Profit;
    const rrRatio = totalProfit / riskAmount;

    // Display results
    document.getElementById('rrPositionSize').textContent = `${quantity.toFixed(2)} ${symbol.replace('USDT', '')}`;
    document.getElementById('rrRisk').textContent = `-$${riskAmount.toFixed(2)}`;
    document.getElementById('rrTP1').textContent = `+$${tp1Profit.toFixed(2)}`;
    document.getElementById('rrTP2').textContent = `+$${tp2Profit.toFixed(2)}`;
    document.getElementById('rrTP3').textContent = `+$${tp3Profit.toFixed(2)}`;
    document.getElementById('rrRatio').textContent = `1:${rrRatio.toFixed(2)}`;
    
    document.getElementById('riskRewardDisplay').style.display = 'block';
}

/**
 * Setup symbol change handler to update max leverage and current price
 */
function setupSymbolChangeHandler() {
    const symbolInput = document.getElementById('symbol');
    const leverageInput = document.getElementById('leverage');
    const leverageLabel = leverageInput.previousElementSibling;
    const symbolPriceSpan = document.getElementById('symbolPrice');

    // Use input event for real-time updates and change event for datalist selection
    const updateSymbolInfo = async () => {
        const symbol = symbolInput.value.trim().toUpperCase();
        
        if (!symbol) {
            symbolPriceSpan.textContent = '';
            leverageLabel.textContent = 'Leverage (1-125)';
            document.getElementById('leverageInfo').textContent = 'Select a symbol to see max leverage';
            return;
        }

        // Check if it's a valid symbol from the datalist
        const datalist = document.getElementById('symbolList');
        const options = Array.from(datalist.options).map(opt => opt.value);
        
        if (!options.includes(symbol)) {
            symbolPriceSpan.textContent = '';
            return;
        }

        try {
            // Fetch symbol info (for max leverage)
            const infoResponse = await fetch(`${API_BASE}/symbol-info/${symbol}`);
            const infoData = await infoResponse.json();

            if (infoData.success) {
                const maxLeverage = infoData.data.maxLeverage;
                leverageInput.max = maxLeverage;

                // Update label to show max leverage
                leverageLabel.textContent = `Leverage (1-${maxLeverage})`;

                // If current value exceeds max, set to max
                if (parseInt(leverageInput.value) > maxLeverage) {
                    leverageInput.value = maxLeverage;
                }

                // Show info message
                const leverageInfo = document.getElementById('leverageInfo');
                if (leverageInfo) {
                    leverageInfo.textContent = `Max: ${maxLeverage}x`;
                }
            }

            // Fetch current price
            const priceResponse = await fetch(`${API_BASE}/price/${symbol}`);
            const priceData = await priceResponse.json();

            if (priceData.success) {
                const price = priceData.data.price;
                symbolPriceSpan.textContent = `(${price.toFixed(8)})`;
            }
        } catch (error) {
            console.error('Error fetching symbol info:', error);
            symbolPriceSpan.textContent = '';
        }
    };

    // Trigger on blur (when user finishes typing/selecting)
    symbolInput.addEventListener('blur', updateSymbolInfo);
    
    // Also trigger on input with debounce for better UX
    let debounceTimer;
    symbolInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateSymbolInfo, 500);
    });

    // Setup risk/reward calculator on form input changes
    const formInputs = ['symbol', 'side', 'stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3', 'walletPercentage', 'leverage', 'limitPrice'];
    formInputs.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(calculateRiskReward, 300);
            });
            element.addEventListener('change', calculateRiskReward);
        }
    });
}

/**
 * Close position
 */
async function closePosition(symbol) {
    if (!confirm(`Are you sure you want to close ${symbol} position?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/close/${symbol}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showMessage('success', `✅ Position ${symbol} closed successfully`);
            loadPositions();
            loadTrades();
        } else {
            showMessage('error', `❌ Error: ${data.error}`);
        }
    } catch (error) {
        showMessage('error', `❌ Failed to close position: ${error.message}`);
    }
}

/**
 * Show message below the submit button
 */
function showMessage(type, message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message message-${type}`;
    messageDiv.textContent = message;

    const form = document.getElementById('tradeForm');
    const submitBtn = form.querySelector('button[type="submit"]');
    
    // Insert after the submit button
    submitBtn.parentNode.insertBefore(messageDiv, submitBtn.nextSibling);

    setTimeout(() => {
        messageDiv.remove();
    }, 8000);
}
