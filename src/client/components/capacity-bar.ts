import type { AccountWriteStats } from '../../lib/types.ts';

const MAX_BLOCK_CUS = 48_000_000;

function getCapacityClass(percent: number): string {
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'low';
}

export function renderCapacityBar(
  blockCapacity: number,
  accountStats: AccountWriteStats[]
) {
  const container = document.getElementById('capacity-bar');
  if (!container) return;

  // Get top 5 accounts by usage
  const topAccounts = accountStats.slice(0, 5);

  container.innerHTML = `
    <div class="capacity-row">
      <span class="capacity-label">Block Total</span>
      <div class="capacity-track">
        <div class="capacity-fill ${getCapacityClass(blockCapacity)}"
             style="width: ${Math.min(100, blockCapacity)}%"></div>
      </div>
      <span class="capacity-value">${blockCapacity.toFixed(1)}%</span>
    </div>
    <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">Top Write Lock Accounts (of 12M limit)</div>
    ${topAccounts.map((acc) => `
      <div class="capacity-row">
        <span class="capacity-label">${acc.address}</span>
        <div class="capacity-track">
          <div class="capacity-fill ${getCapacityClass(acc.percentOfLimit)}"
               style="width: ${Math.min(100, acc.percentOfLimit)}%"></div>
        </div>
        <span class="capacity-value">${acc.percentOfLimit.toFixed(1)}%</span>
      </div>
    `).join('')}
  `;
}
