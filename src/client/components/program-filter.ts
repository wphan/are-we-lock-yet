import type { ProgramStats } from '../../lib/types.ts';

// Well-known Solana program names
const PROGRAM_NAMES: Record<string, string> = {
	'11111111111111111111111111111111': 'System Program',
	'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
	'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022',
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token',
	'ComputeBudget111111111111111111111111111111': 'Compute Budget',
	'Vote111111111111111111111111111111111111111': 'Vote Program',
	'Stake11111111111111111111111111111111111111': 'Stake Program',
	'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
	'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
	'675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
	'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
	'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'Serum v3',
	'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',
	'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
	'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': 'Memo v2',
	'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo': 'Memo v1',
	'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Metadata',
	'p1exdMJcjVao65QdewkaZRUnU6VPSXhus9n2GzWfh98': 'Metaplex Auction',
	'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY': 'Bubblegum',
	'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH': 'Drift',
	'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD': 'Marinade',
	'jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR': 'Jito Tip',
	'9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp': 'HumidiFi',
};

let selectedPrograms: Set<string> = new Set();
let searchQuery = '';
let isOpen = false;

export function getSelectedPrograms(): Set<string> {
	return selectedPrograms;
}

export function clearProgramFilters() {
	selectedPrograms.clear();
	searchQuery = '';
}

function getProgramName(programId: string): string {
	return PROGRAM_NAMES[programId] ?? `${programId.slice(0, 4)}...${programId.slice(-4)}`;
}

function truncateProgramId(programId: string): string {
	return `${programId.slice(0, 4)}...${programId.slice(-4)}`;
}

export function renderProgramFilter(
	container: HTMLElement,
	programStats: ProgramStats[],
	onFilterChange: () => void
) {
	// Filter programs based on search
	const filteredPrograms = searchQuery
		? programStats.filter(p => {
			const name = PROGRAM_NAMES[p.programId]?.toLowerCase() ?? '';
			return p.programId.toLowerCase().includes(searchQuery.toLowerCase()) ||
				name.includes(searchQuery.toLowerCase());
		})
		: programStats;

	const selectedCount = selectedPrograms.size;

	container.innerHTML = `
    <div class="program-filter">
      <button class="program-filter-btn" id="program-filter-toggle">
        Programs${selectedCount > 0 ? ` (${selectedCount})` : ''}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="program-filter-dropdown ${isOpen ? 'open' : ''}" id="program-dropdown">
        <div class="program-filter-search">
          <input type="text" placeholder="Search programs..." value="${searchQuery}" id="program-search">
        </div>
        <div class="program-filter-list">
          ${filteredPrograms.length === 0 ? `
            <div class="program-filter-empty">No programs found</div>
          ` : filteredPrograms.map(p => `
            <label class="program-filter-item">
              <input type="checkbox" value="${p.programId}" ${selectedPrograms.has(p.programId) ? 'checked' : ''}>
              <span class="program-name">${getProgramName(p.programId)}</span>
              <span class="program-count">${p.txCount}</span>
            </label>
          `).join('')}
        </div>
        ${selectedPrograms.size > 0 ? `
          <div class="program-filter-actions">
            <button class="program-filter-clear" id="clear-programs">Clear all</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;

	// Toggle dropdown
	const toggleBtn = document.getElementById('program-filter-toggle');
	toggleBtn?.addEventListener('click', (e) => {
		e.stopPropagation();
		isOpen = !isOpen;
		renderProgramFilter(container, programStats, onFilterChange);
	});

	// Close dropdown when clicking outside
	const closeDropdown = (e: MouseEvent) => {
		const dropdown = document.getElementById('program-dropdown');
		const toggle = document.getElementById('program-filter-toggle');
		if (dropdown && toggle && !dropdown.contains(e.target as Node) && !toggle.contains(e.target as Node)) {
			if (isOpen) {
				isOpen = false;
				renderProgramFilter(container, programStats, onFilterChange);
			}
		}
	};
	document.addEventListener('click', closeDropdown, { once: true });

	// Search input
	const searchInput = document.getElementById('program-search') as HTMLInputElement;
	if (searchInput && isOpen) {
		searchInput.focus();
		searchInput.setSelectionRange(searchQuery.length, searchQuery.length);

		searchInput.addEventListener('input', () => {
			searchQuery = searchInput.value;
			renderProgramFilter(container, programStats, onFilterChange);
		});
	}

	// Checkbox handlers
	container.querySelectorAll('.program-filter-item input').forEach((checkbox) => {
		checkbox.addEventListener('change', () => {
			const programId = (checkbox as HTMLInputElement).value;
			if ((checkbox as HTMLInputElement).checked) {
				selectedPrograms.add(programId);
			} else {
				selectedPrograms.delete(programId);
			}
			renderProgramFilter(container, programStats, onFilterChange);
			onFilterChange();
		});
	});

	// Clear all button
	const clearBtn = document.getElementById('clear-programs');
	clearBtn?.addEventListener('click', () => {
		selectedPrograms.clear();
		renderProgramFilter(container, programStats, onFilterChange);
		onFilterChange();
	});
}
