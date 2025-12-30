import type { TransactionMetrics } from '../../lib/types.ts';

type MetricKey = 'cuLimit' | 'cuUsed' | 'cuPrice' | 'priority' | 'prioritizationFee' | 'cost';
type ScaleType = 'linear' | 'log';

interface ChartState {
  metric: MetricKey;
  scale: ScaleType;
  showVotes: boolean;
  selectedTx: TransactionMetrics | null;
}

let state: ChartState = {
  metric: 'priority',
  scale: 'log',
  showVotes: false,
  selectedTx: null,
};

// Store transactions for click handlers
let currentTransactions: TransactionMetrics[] = [];
let currentAccountFilters: Set<string> = new Set();
let currentProgramFilters: Set<string> = new Set();

export function setProgramFiltersForChart(programs: Set<string>) {
  currentProgramFilters = programs;
}

const METRIC_LABELS: Record<MetricKey, string> = {
  cuLimit: 'CU Limit',
  cuUsed: 'CU Used',
  cuPrice: 'CU Price (μ-lamports)',
  priority: 'Priority',
  prioritizationFee: 'Priority Fee (lamports)',
  cost: 'Cost',
};

function getBarColor(tx: TransactionMetrics): string {
  if (tx.isVote) return 'var(--color-vote)';
  if (tx.status === 'failed') return 'var(--color-failed)';
  return 'var(--color-success)';
}

function formatValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function showTxDetail(tx: TransactionMetrics) {
  state.selectedTx = tx;

  let detailPanel = document.getElementById('tx-detail-panel');
  if (!detailPanel) {
    detailPanel = document.createElement('div');
    detailPanel.id = 'tx-detail-panel';
    detailPanel.className = 'tx-detail-panel';
    document.body.appendChild(detailPanel);
  }

  const statusClass = tx.isVote ? 'vote' : tx.status;
  const statusText = tx.isVote ? 'Vote' : tx.status === 'success' ? 'Success' : 'Failed';

  detailPanel.innerHTML = `
    <div class="tx-detail-modal">
      <div class="tx-detail-header">
        <h3>Transaction Details</h3>
        <button class="tx-detail-close" id="close-tx-detail">&times;</button>
      </div>
      <div class="tx-detail-content">
        <div class="tx-detail-row">
          <span class="tx-detail-label">Index</span>
          <span class="tx-detail-value mono">${tx.index}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Signature</span>
          <span class="tx-detail-value mono signature-value">${tx.signature}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Status</span>
          <span class="tx-detail-value"><span class="status ${statusClass}">${statusText}</span></span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Priority</span>
          <span class="tx-detail-value mono">${formatNumber(tx.priority)}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">CU Price</span>
          <span class="tx-detail-value mono">${formatNumber(tx.cuPrice)} μ-lamports</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">CU Limit</span>
          <span class="tx-detail-value mono">${formatNumber(tx.cuLimit)}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">CU Used</span>
          <span class="tx-detail-value mono">${formatNumber(tx.cuUsed)}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">CU Efficiency</span>
          <span class="tx-detail-value mono">${tx.cuLimit > 0 ? ((tx.cuUsed / tx.cuLimit) * 100).toFixed(1) : 0}%</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Cost (estimated)</span>
          <span class="tx-detail-value mono">${formatNumber(tx.cost)}</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Priority Fee</span>
          <span class="tx-detail-value mono">${formatNumber(tx.prioritizationFee)} lamports</span>
        </div>
        <div class="tx-detail-row">
          <span class="tx-detail-label">Total Fee</span>
          <span class="tx-detail-value mono">${formatNumber(tx.prioritizationFee + 5000)} lamports</span>
        </div>
        <div class="tx-detail-row writable-accounts">
          <span class="tx-detail-label">Accounts (${tx.accounts?.length ?? tx.writableAccounts.length})</span>
          <div class="tx-detail-accounts">
            ${(tx.accounts ?? tx.writableAccounts.map(addr => ({ address: addr, isSigner: false, isWritable: true }))).map(acc => {
              const addr = typeof acc === 'string' ? acc : acc.address;
              const isSigner = typeof acc === 'string' ? false : acc.isSigner;
              const isWritable = typeof acc === 'string' ? true : acc.isWritable;
              const isProgram = tx.programs.includes(addr);
              const badges = [];
              if (isProgram) badges.push('<span class="role-badge program" title="Program">P</span>');
              if (isSigner) badges.push('<span class="role-badge signer" title="Signer">S</span>');
              if (isWritable) badges.push('<span class="role-badge write" title="Writable">W</span>');
              if (!isWritable) badges.push('<span class="role-badge read" title="Read-only">R</span>');
              return `<span class="mono account-row"><span class="account-badges">${badges.join('')}</span>${addr}</span>`;
            }).join('')}
          </div>
        </div>
      </div>
      <div class="tx-detail-footer">
        <a href="https://solscan.io/tx/${tx.signature}" target="_blank" class="tx-detail-link">View on Solscan</a>
        <a href="https://explorer.solana.com/tx/${tx.signature}" target="_blank" class="tx-detail-link">View on Explorer</a>
      </div>
    </div>
  `;

  detailPanel.classList.add('visible');

  // Close handlers
  document.getElementById('close-tx-detail')?.addEventListener('click', closeTxDetail);
  detailPanel.addEventListener('click', (e) => {
    if (e.target === detailPanel) closeTxDetail();
  });
}

function closeTxDetail() {
  state.selectedTx = null;
  const panel = document.getElementById('tx-detail-panel');
  panel?.classList.remove('visible');
}

export function renderFeeChart(transactions: TransactionMetrics[], accountFilters: Set<string> = new Set()) {
  const container = document.getElementById('fee-chart');
  if (!container) return;

  // Store for click handlers
  currentTransactions = transactions;
  currentAccountFilters = accountFilters;

  // Filter based on showVotes
  const filtered = state.showVotes
    ? transactions
    : transactions.filter(tx => !tx.isVote);

  // Sort by index to maintain block order
  const sorted = [...filtered].sort((a, b) => a.index - b.index);

  // Get values for the selected metric
  const values = sorted.map(tx => tx[state.metric] as number);
  const maxValue = Math.max(...values, 1);

  // Scale helpers
  const isLog = state.scale === 'log';
  const logMax = Math.log10(maxValue + 1);

  function getHeight(value: number): number {
    if (value <= 0) return 0;
    if (isLog) {
      return (Math.log10(value + 1) / logMax) * 100;
    }
    return (value / maxValue) * 100;
  }

  // Generate Y-axis ticks
  const ticks: number[] = [];
  if (isLog) {
    let tick = 1;
    while (tick <= maxValue) {
      ticks.push(tick);
      tick *= 10;
    }
    if (ticks[ticks.length - 1]! < maxValue) {
      ticks.push(Math.pow(10, Math.ceil(Math.log10(maxValue))));
    }
  } else {
    // Linear scale: 5 ticks
    const step = maxValue / 4;
    for (let i = 1; i <= 4; i++) {
      ticks.push(Math.round(step * i));
    }
  }

  const chartHeight = 300;

  container.innerHTML = `
    <div class="chart-header">
      <div class="chart-controls">
        <label class="filter-label">
          <input type="checkbox" id="chart-show-votes" ${state.showVotes ? 'checked' : ''}>
          Show Votes
        </label>
        <select id="chart-metric" class="chart-select">
          ${Object.entries(METRIC_LABELS).map(([key, label]) =>
            `<option value="${key}" ${state.metric === key ? 'selected' : ''}>${label}</option>`
          ).join('')}
        </select>
        <span class="info-tooltip">
          <span class="info-icon">?</span>
          <span class="info-content">
            <strong>Priority</strong> = (reward × 1M) / (cost + 1)<br><br>
            <strong>Reward</strong> = base_fee + priority_fee<br>
            • base_fee = 5,000 × signatures<br>
            • priority_fee = (CU_price × CU_limit) / 1M<br><br>
            <strong>Cost</strong> = signature + write_lock + data + CU_limit<br>
            • signature = 720 × num_signatures<br>
            • write_lock = 300 × writable_accounts<br>
            • data = instruction_bytes / 32<br><br>
            <em>Tip: Lower CU_limit → higher priority</em>
          </span>
        </span>
        <select id="chart-scale" class="chart-select">
          <option value="linear" ${state.scale === 'linear' ? 'selected' : ''}>Linear</option>
          <option value="log" ${state.scale === 'log' ? 'selected' : ''}>Log</option>
        </select>
      </div>
    </div>
    <div class="chart-container">
      <div class="chart-y-axis">
        ${[...ticks].reverse().map(t => `
          <div class="y-tick" style="bottom: ${getHeight(t)}%">
            <span class="y-label">${formatValue(t)}</span>
            <div class="y-line"></div>
          </div>
        `).join('')}
        <div class="y-tick" style="bottom: 0%">
          <span class="y-label">0</span>
          <div class="y-line"></div>
        </div>
      </div>
      <div class="chart-bars" id="chart-bars">
        ${sorted.map((tx, i) => {
          const value = tx[state.metric] as number;
          const height = getHeight(value);
          const matchesAccountFilter = accountFilters.size > 0 && tx.writableAccounts.some(addr => accountFilters.has(addr));
          const matchesProgramFilter = currentProgramFilters.size > 0 && tx.programs.some(p => currentProgramFilters.has(p));
          const hasFilters = accountFilters.size > 0 || currentProgramFilters.size > 0;
          const matchesFilter = (accountFilters.size === 0 || matchesAccountFilter) && (currentProgramFilters.size === 0 || matchesProgramFilter);
          return `
            <div class="bar-wrapper${hasFilters && !matchesFilter ? ' dimmed' : ''}${hasFilters && matchesFilter ? ' highlighted' : ''}"
                 data-index="${tx.index}"
                 data-tooltip="Index: ${tx.index} | ${METRIC_LABELS[state.metric]}: ${formatValue(value)} | ${tx.isVote ? 'Vote' : tx.status}">
              <div class="bar" style="height: ${height}%; background: ${getBarColor(tx)};"></div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    ${(accountFilters.size > 0 || currentProgramFilters.size > 0) ? `
      <div class="chart-markers">
        <div class="chart-y-axis-spacer"></div>
        <div class="markers-row">
          ${sorted.map((tx) => {
            const matchesAccountFilter = accountFilters.size === 0 || tx.writableAccounts.some(addr => accountFilters.has(addr));
            const matchesProgramFilter = currentProgramFilters.size === 0 || tx.programs.some(p => currentProgramFilters.has(p));
            const matches = matchesAccountFilter && matchesProgramFilter;
            return `<div class="marker-slot">${matches ? '<div class="marker"></div>' : ''}</div>`;
          }).join('')}
        </div>
      </div>
    ` : ''}
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-color" style="background: var(--color-success)"></span> Success</span>
      <span class="legend-item"><span class="legend-color" style="background: var(--color-failed)"></span> Failed</span>
      <span class="legend-item"><span class="legend-color" style="background: var(--color-vote)"></span> Vote</span>
    </div>
  `;

  // Event handlers
  const metricSelect = document.getElementById('chart-metric') as HTMLSelectElement;
  metricSelect?.addEventListener('change', () => {
    state.metric = metricSelect.value as MetricKey;
    renderFeeChart(transactions, currentAccountFilters);
  });

  const votesCheckbox = document.getElementById('chart-show-votes') as HTMLInputElement;
  votesCheckbox?.addEventListener('change', () => {
    state.showVotes = votesCheckbox.checked;
    renderFeeChart(transactions, currentAccountFilters);
  });

  const scaleSelect = document.getElementById('chart-scale') as HTMLSelectElement;
  scaleSelect?.addEventListener('change', () => {
    state.scale = scaleSelect.value as ScaleType;
    renderFeeChart(transactions, currentAccountFilters);
  });

  // Bar click handlers
  container.querySelectorAll('.bar-wrapper').forEach((bar) => {
    bar.addEventListener('click', () => {
      const index = parseInt((bar as HTMLElement).dataset.index ?? '', 10);
      const tx = currentTransactions.find(t => t.index === index);
      if (tx) showTxDetail(tx);
    });
  });
}
