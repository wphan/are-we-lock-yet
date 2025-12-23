import type { AccountWriteStats } from '../../lib/types.ts';

let currentSort: { column: string; asc: boolean } = { column: 'totalCUs', asc: false };
let searchQuery = '';
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

function formatCUs(cus: number): string {
  if (cus >= 1_000_000) {
    return `${(cus / 1_000_000).toFixed(2)}M`;
  }
  if (cus >= 1_000) {
    return `${(cus / 1_000).toFixed(1)}K`;
  }
  return String(cus);
}

function getCapacityClass(percent: number): string {
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'low';
}

export function renderAccountTable(
  stats: AccountWriteStats[],
  onAccountClick: (address: string | null) => void
) {
  const container = document.getElementById('account-table');
  if (!container) return;

  // Filter by search query
  const filtered = searchQuery
    ? stats.filter(acc => acc.address.toLowerCase().includes(searchQuery.toLowerCase()))
    : stats;

  // Sort data
  const sorted = [...filtered].sort((a, b) => {
    let aVal: number | string = a[currentSort.column as keyof AccountWriteStats] as number | string;
    let bVal: number | string = b[currentSort.column as keyof AccountWriteStats] as number | string;

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return currentSort.asc ? aVal - bVal : bVal - aVal;
    }
    return 0;
  });

  const topAccounts = sorted.slice(0, 100);

  container.innerHTML = `
    <div class="table-controls">
      <input type="text" id="account-search" class="search-input" placeholder="Search accounts..." value="${searchQuery}">
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="sortable ${currentSort.column === 'address' ? 'sorted' : ''}" data-column="address">Account</th>
            <th class="sortable align-right ${currentSort.column === 'totalCUs' ? 'sorted' : ''}" data-column="totalCUs">Total CUs</th>
            <th class="sortable align-right ${currentSort.column === 'percentOfLimit' ? 'sorted' : ''}" data-column="percentOfLimit">% of 12M Limit</th>
            <th class="sortable align-right ${currentSort.column === 'txCount' ? 'sorted' : ''}" data-column="txCount">Tx Count</th>
          </tr>
        </thead>
        <tbody>
          ${topAccounts.map((acc) => `
            <tr class="clickable" data-address="${acc.address}">
              <td class="mono">${acc.address}</td>
              <td class="mono align-right">${formatCUs(acc.totalCUs)}</td>
              <td class="align-right">
                <div class="capacity-inline">
                  <div class="capacity-inline-track">
                    <div class="capacity-inline-fill ${getCapacityClass(acc.percentOfLimit)}"
                         style="width: ${Math.min(100, acc.percentOfLimit)}%"></div>
                  </div>
                  <span class="mono">${acc.percentOfLimit.toFixed(1)}%</span>
                </div>
              </td>
              <td class="mono align-right">${acc.txCount}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Search handler
  const searchInput = document.getElementById('account-search') as HTMLInputElement;
  if (searchInput) {
    // Restore focus and cursor position if actively searching
    if (searchQuery) {
      searchInput.focus();
      searchInput.setSelectionRange(searchQuery.length, searchQuery.length);
    }

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderAccountTable(stats, onAccountClick);
    });
  }

  // Ctrl/Cmd+F to focus search when table is hovered
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
  }
  keydownHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      const isHovered = container.matches(':hover');
      if (isHovered && searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    }
  };
  document.addEventListener('keydown', keydownHandler);

  // Sort handlers
  container.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const column = (th as HTMLElement).dataset.column;
      if (!column) return;

      if (currentSort.column === column) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort = { column, asc: false };
      }
      renderAccountTable(stats, onAccountClick);
    });
  });

  // Row click handlers
  container.querySelectorAll('tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const address = (tr as HTMLElement).dataset.address;
      onAccountClick(address ?? null);
    });
  });
}
