import type { AccountWriteStats } from '../../lib/types.ts';

let selectedAccounts: Set<string> = new Set();
let searchQuery = '';
let isOpen = false;

export function getSelectedAccounts(): Set<string> {
  return selectedAccounts;
}

export function setSelectedAccounts(accounts: Set<string>) {
  selectedAccounts = accounts;
}

export function clearAccountFilters() {
  selectedAccounts.clear();
  searchQuery = '';
}

export function toggleAccount(address: string) {
  if (selectedAccounts.has(address)) {
    selectedAccounts.delete(address);
  } else {
    selectedAccounts.add(address);
  }
}

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatCUs(cus: number): string {
  if (cus >= 1_000_000) {
    return `${(cus / 1_000_000).toFixed(1)}M`;
  }
  if (cus >= 1_000) {
    return `${(cus / 1_000).toFixed(1)}K`;
  }
  return String(cus);
}

export function renderAccountFilter(
  container: HTMLElement,
  accountStats: AccountWriteStats[],
  onFilterChange: () => void
) {
  // Filter accounts based on search
  const filteredAccounts = searchQuery
    ? accountStats.filter(a => a.address.toLowerCase().includes(searchQuery.toLowerCase()))
    : accountStats;

  const selectedCount = selectedAccounts.size;

  container.innerHTML = `
    <div class="program-filter">
      <button class="program-filter-btn" id="account-filter-toggle">
        Accounts${selectedCount > 0 ? ` (${selectedCount})` : ''}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="program-filter-dropdown ${isOpen ? 'open' : ''}" id="account-dropdown">
        <div class="program-filter-search">
          <input type="text" placeholder="Search accounts..." value="${searchQuery}" id="account-filter-search">
        </div>
        <div class="program-filter-list">
          ${filteredAccounts.length === 0 ? `
            <div class="program-filter-empty">No accounts found</div>
          ` : filteredAccounts.slice(0, 50).map(a => `
            <label class="program-filter-item">
              <input type="checkbox" value="${a.address}" ${selectedAccounts.has(a.address) ? 'checked' : ''}>
              <span class="program-name mono" title="${a.address}">${truncateAddr(a.address)}</span>
              <button class="filter-copy-btn" data-copy="${a.address}" title="Copy address">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
              <span class="program-count">${formatCUs(a.totalCUs)} (${a.txCount})</span>
            </label>
          `).join('')}
          ${filteredAccounts.length > 50 ? `
            <div class="program-filter-empty">Showing 50 of ${filteredAccounts.length} accounts</div>
          ` : ''}
        </div>
        ${selectedAccounts.size > 0 ? `
          <div class="program-filter-actions">
            <button class="program-filter-clear" id="clear-accounts">Clear all</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  // Toggle dropdown
  const toggleBtn = document.getElementById('account-filter-toggle');
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen = !isOpen;
    renderAccountFilter(container, accountStats, onFilterChange);
  });

  // Close dropdown when clicking outside
  const closeDropdown = (e: MouseEvent) => {
    const dropdown = document.getElementById('account-dropdown');
    const toggle = document.getElementById('account-filter-toggle');
    if (dropdown && toggle && !dropdown.contains(e.target as Node) && !toggle.contains(e.target as Node)) {
      if (isOpen) {
        isOpen = false;
        renderAccountFilter(container, accountStats, onFilterChange);
      }
    }
  };
  document.addEventListener('click', closeDropdown, { once: true });

  // Search input
  const searchInput = document.getElementById('account-filter-search') as HTMLInputElement;
  if (searchInput && isOpen) {
    searchInput.focus();
    searchInput.setSelectionRange(searchQuery.length, searchQuery.length);

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderAccountFilter(container, accountStats, onFilterChange);
    });
  }

  // Checkbox handlers
  container.querySelectorAll('.program-filter-item input').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const address = (checkbox as HTMLInputElement).value;
      if ((checkbox as HTMLInputElement).checked) {
        selectedAccounts.add(address);
      } else {
        selectedAccounts.delete(address);
      }
      renderAccountFilter(container, accountStats, onFilterChange);
      onFilterChange();
    });
  });

  // Clear all button
  const clearBtn = document.getElementById('clear-accounts');
  clearBtn?.addEventListener('click', () => {
    selectedAccounts.clear();
    renderAccountFilter(container, accountStats, onFilterChange);
    onFilterChange();
  });

  // Copy button handlers
  container.querySelectorAll('.filter-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const address = (btn as HTMLElement).dataset.copy;
      if (address) {
        await navigator.clipboard.writeText(address);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      }
    });
  });
}

// Re-render the filter (call after external changes like table row clicks)
let lastContainer: HTMLElement | null = null;
let lastAccountStats: AccountWriteStats[] = [];
let lastOnFilterChange: (() => void) | null = null;

export function updateAccountFilterDisplay() {
  if (lastContainer && lastOnFilterChange) {
    renderAccountFilter(lastContainer, lastAccountStats, lastOnFilterChange);
  }
}

export function initAccountFilter(
  container: HTMLElement,
  accountStats: AccountWriteStats[],
  onFilterChange: () => void
) {
  lastContainer = container;
  lastAccountStats = accountStats;
  lastOnFilterChange = onFilterChange;
  renderAccountFilter(container, accountStats, onFilterChange);
}
