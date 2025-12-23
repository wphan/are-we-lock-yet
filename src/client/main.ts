import type { BlockAnalysis } from '../lib/types.ts';
import { initBlockInput, setSlotInput } from './components/block-input.ts';
import { renderAccountTable } from './components/account-table.ts';
import { renderTransactionList, setAccountFilters, setProgramFilters } from './components/tx-list.ts';
import { renderFeeChart, setProgramFiltersForChart } from './components/fee-chart.ts';
import { renderProgramFilter, getSelectedPrograms, clearProgramFilters } from './components/program-filter.ts';
import { initAccountFilter, getSelectedAccounts, clearAccountFilters, toggleAccount, updateAccountFilterDisplay, setSelectedAccounts } from './components/account-filter.ts';

let currentBlock: BlockAnalysis | null = null;

function showLoading(visible: boolean) {
  const el = document.getElementById('loading');
  if (el) {
    el.classList.toggle('visible', visible);
  }
}

function showError(message: string) {
  const el = document.getElementById('error-toast');
  if (el) {
    el.textContent = message;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 4000);
  }
}

function updateStats(block: BlockAnalysis) {
  const setVal = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const slotEl = document.getElementById('stat-slot');
  if (slotEl) {
    slotEl.innerHTML = `<a href="https://solscan.io/block/${block.slot}" target="_blank">${block.slot.toLocaleString()}</a>`;
  }
  setVal('stat-leader', block.leader ? `${block.leader.slice(0, 4)}...${block.leader.slice(-4)}` : '—');
  setVal('stat-txs', block.totalTransactions.toLocaleString());
  setVal('stat-success', block.successfulTransactions.toLocaleString());
  setVal('stat-failed', block.failedTransactions.toLocaleString());
  setVal('stat-votes', block.voteTransactions.toLocaleString());

  // Add click handler for leader to copy full address
  const leaderEl = document.getElementById('stat-leader');
  if (leaderEl && block.leader) {
    leaderEl.style.cursor = 'pointer';
    leaderEl.title = `${block.leader} (click to copy)`;
    leaderEl.onclick = async () => {
      await navigator.clipboard.writeText(block.leader!);
      leaderEl.textContent = 'Copied!';
      setTimeout(() => {
        setVal('stat-leader', `${block.leader!.slice(0, 4)}...${block.leader!.slice(-4)}`);
      }, 1000);
    };
  }

  // Add leader links
  const leaderLinksEl = document.getElementById('leader-links');
  if (leaderLinksEl) {
    if (block.leader) {
      leaderLinksEl.innerHTML = `
        <a href="https://solscan.io/account/${block.leader}" target="_blank" title="View on Solscan">Solscan</a>
        <a href="https://www.validators.app/validators/${block.leader}?locale=en&network=mainnet" target="_blank" title="View on validators.app">validators.app</a>
      `;
    } else {
      leaderLinksEl.innerHTML = '';
    }
  }
}

function updateURL(slot?: number, accounts?: Set<string>) {
  const url = new URL(window.location.href);
  if (slot !== undefined) {
    url.searchParams.set('slot', String(slot));
  }
  if (accounts !== undefined) {
    if (accounts.size > 0) {
      url.searchParams.set('accounts', [...accounts].join(','));
    } else {
      url.searchParams.delete('accounts');
    }
  }
  window.history.replaceState({}, '', url.toString());
}

function getAccountsFromURL(): string[] {
  const url = new URL(window.location.href);
  const accounts = url.searchParams.get('accounts');
  return accounts ? accounts.split(',').filter(a => a.length > 0) : [];
}

async function fetchBlock(slot: number, preserveFilters = false) {
  showLoading(true);

  // Get accounts from URL before clearing (for initial load)
  const urlAccounts = getAccountsFromURL();

  if (!preserveFilters) {
    clearAccountFilters();
    setAccountFilters([]);
    clearProgramFilters();
    setProgramFilters([]);
    setProgramFiltersForChart(new Set());
  }

  try {
    const res = await fetch(`/api/block/${slot}`);
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    currentBlock = data as BlockAnalysis;
    updateURL(slot);
    setSlotInput(slot);

    // Apply accounts from URL on initial load
    if (urlAccounts.length > 0) {
      setSelectedAccounts(new Set(urlAccounts));
      setAccountFilters(urlAccounts);
    }

    render();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to fetch block');
  } finally {
    showLoading(false);
  }
}

function render() {
  if (!currentBlock) return;

  updateStats(currentBlock);

  // Render program filter
  const programFilterContainer = document.getElementById('program-filter-container');
  if (programFilterContainer) {
    renderProgramFilter(programFilterContainer, currentBlock.programStats, handleProgramFilterChange);
  }

  // Render account filter
  const accountFilterContainer = document.getElementById('account-filter-container');
  if (accountFilterContainer) {
    initAccountFilter(accountFilterContainer, currentBlock.accountStats, handleAccountFilterChange);
  }

  const selectedAccounts = getSelectedAccounts();
  renderFeeChart(currentBlock.transactions, selectedAccounts);
  renderAccountTable(currentBlock.accountStats, handleAccountClick);
  renderTransactionList(currentBlock.transactions);
}

function handleProgramFilterChange() {
  const selectedPrograms = getSelectedPrograms();
  const selectedAccounts = getSelectedAccounts();
  setProgramFilters([...selectedPrograms]);
  setProgramFiltersForChart(selectedPrograms);
  if (currentBlock) {
    renderFeeChart(currentBlock.transactions, selectedAccounts);
    renderTransactionList(currentBlock.transactions);
  }
}

function handleAccountFilterChange() {
  const selectedAccounts = getSelectedAccounts();
  setAccountFilters([...selectedAccounts]);
  updateURL(undefined, selectedAccounts);
  if (currentBlock) {
    renderFeeChart(currentBlock.transactions, selectedAccounts);
    renderTransactionList(currentBlock.transactions);
  }
}

function handleAccountClick(address: string | null) {
  if (address) {
    toggleAccount(address);
  }
  const selectedAccounts = getSelectedAccounts();
  setAccountFilters([...selectedAccounts]);
  updateURL(undefined, selectedAccounts);
  updateAccountFilterDisplay();
  if (currentBlock) {
    renderFeeChart(currentBlock.transactions, selectedAccounts);
    renderTransactionList(currentBlock.transactions);
  }
}

// Re-render on filter changes
document.addEventListener('filter-changed', () => {
  clearAccountFilters();
  const selectedAccounts = getSelectedAccounts();
  if (currentBlock) {
    renderFeeChart(currentBlock.transactions, selectedAccounts);
    renderTransactionList(currentBlock.transactions);
    updateAccountFilterDisplay();
  }
});

// Initialize
initBlockInput(fetchBlock);

// Coffee address copy handler
const coffeeAddress = document.getElementById('coffee-address');
if (coffeeAddress) {
  coffeeAddress.addEventListener('click', async () => {
    const address = coffeeAddress.textContent;
    if (address) {
      await navigator.clipboard.writeText(address);
      const original = coffeeAddress.textContent;
      coffeeAddress.textContent = 'Copied!';
      coffeeAddress.classList.add('copied');
      setTimeout(() => {
        coffeeAddress.textContent = original;
        coffeeAddress.classList.remove('copied');
      }, 1500);
    }
  });
}
