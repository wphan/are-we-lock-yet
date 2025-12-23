import type { TransactionMetrics } from '../../lib/types.ts';

interface FilterState {
  showVotes: boolean;
  accountFilters: string[];
  programFilters: string[];
  searchQuery: string;
}

let filterState: FilterState = {
  showVotes: false,
  accountFilters: [],
  programFilters: [],
  searchQuery: '',
};

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCUs(cus: number): string {
  if (cus >= 1_000_000) {
    return `${(cus / 1_000_000).toFixed(2)}M`;
  }
  if (cus >= 1_000) {
    return `${(cus / 1_000).toFixed(1)}K`;
  }
  return String(cus);
}

function formatFee(lamports: number): string {
  if (lamports >= 1_000_000) {
    return `${(lamports / 1_000_000).toFixed(2)}M`;
  }
  if (lamports >= 1_000) {
    return `${(lamports / 1_000).toFixed(1)}K`;
  }
  return String(lamports);
}

function truncateSig(sig: string): string {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
}

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export function setAccountFilters(addresses: string[]) {
  filterState.accountFilters = addresses;
}

export function setProgramFilters(programs: string[]) {
  filterState.programFilters = programs;
}


export function renderTransactionList(transactions: TransactionMetrics[]) {
  const container = document.getElementById('tx-table');
  if (!container) return;

  // Apply filters
  let filtered = transactions;

  if (!filterState.showVotes) {
    filtered = filtered.filter((tx) => !tx.isVote);
  }

  if (filterState.accountFilters.length > 0) {
    filtered = filtered.filter((tx) =>
      filterState.accountFilters.some(addr => tx.writableAccounts.includes(addr))
    );
  }

  // Apply program filter
  if (filterState.programFilters.length > 0) {
    filtered = filtered.filter((tx) =>
      filterState.programFilters.some(p => tx.programs.includes(p))
    );
  }

  // Apply search filter
  if (filterState.searchQuery) {
    const query = filterState.searchQuery.toLowerCase();
    filtered = filtered.filter((tx) =>
      tx.signature.toLowerCase().includes(query) ||
      tx.writableAccounts.some(addr => addr.toLowerCase().includes(query))
    );
  }

  // Sort by index ascending (block order)
  filtered = [...filtered].sort((a, b) => a.index - b.index);

  container.innerHTML = `
    <div class="table-controls">
      <input type="text" id="tx-search" class="search-input" placeholder="Search by signature or account..." value="${filterState.searchQuery}">
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="align-right">Index</th>
            <th>Signature</th>
            <th>Signers</th>
            <th class="align-right">Priority</th>
            <th class="align-right">CU Price</th>
            <th class="align-right">CU Limit</th>
            <th class="align-right">CU Used</th>
            <th class="align-right">Fee (lamports)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.length === 0 ? `
            <tr><td colspan="9" class="empty-state">No transactions match filters</td></tr>
          ` : filtered.map((tx) => `
            <tr>
              <td class="mono align-right">${tx.index}</td>
              <td class="mono">
                <span class="sig-cell">
                  <a href="https://solscan.io/tx/${tx.signature}" target="_blank" class="sig-link" title="${tx.signature}">${truncateSig(tx.signature)}</a>
                  <button class="copy-btn" data-copy="${tx.signature}" title="Copy signature">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                </span>
              </td>
              <td class="mono signers-cell">
                ${tx.signers.map(s => `<span class="signer-tag" title="${s}">${truncateAddr(s)}</span>`).join('')}
              </td>
              <td class="mono align-right">${formatNumber(tx.priority)}</td>
              <td class="mono align-right">${formatNumber(tx.cuPrice)}</td>
              <td class="mono align-right">${formatCUs(tx.cuLimit)}</td>
              <td class="mono align-right">${formatCUs(tx.cuUsed)}</td>
              <td class="mono align-right">${formatFee(tx.prioritizationFee + 5000)}</td>
              <td>
                <span class="status ${tx.status}${tx.isVote ? ' vote' : ''}">
                  ${tx.isVote ? 'Vote' : tx.status === 'success' ? 'Success' : 'Failed'}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Vote filter checkbox
  const voteCheckbox = document.getElementById('filter-votes') as HTMLInputElement;
  if (voteCheckbox) {
    voteCheckbox.checked = filterState.showVotes;
    voteCheckbox.onchange = () => {
      filterState.showVotes = voteCheckbox.checked;
      renderTransactionList(transactions);
    };
  }

  // Search handler
  const searchInput = document.getElementById('tx-search') as HTMLInputElement;
  if (searchInput) {
    // Restore focus and cursor position if actively searching
    if (filterState.searchQuery) {
      searchInput.focus();
      searchInput.setSelectionRange(filterState.searchQuery.length, filterState.searchQuery.length);
    }

    searchInput.addEventListener('input', () => {
      filterState.searchQuery = searchInput.value;
      renderTransactionList(transactions);
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

  // Copy button handlers
  container.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = (btn as HTMLElement).dataset.copy;
      if (text) {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      }
    });
  });
}
