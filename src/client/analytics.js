// src/client/analytics.ts
var currentRange = "1d";
var currentMetric = "cu";
var hotAccountsData = [];
var searchedAccounts = new Map;
var KNOWN_PROGRAMS = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: "Serum DEX",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin": "Serum v3",
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: "Openbook v2",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token 2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ATA",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  Vote111111111111111111111111111111111111111: "Vote"
};
function formatCU(cu) {
  if (cu >= 1e9) {
    return (cu / 1e9).toFixed(2) + "B";
  }
  if (cu >= 1e6) {
    return (cu / 1e6).toFixed(2) + "M";
  }
  if (cu >= 1000) {
    return (cu / 1000).toFixed(1) + "K";
  }
  return cu.toString();
}
function formatPercent(pct) {
  return pct.toFixed(1) + "%";
}
function truncateAddress(addr) {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}
function getProgramName(addr) {
  return KNOWN_PROGRAMS[addr] || null;
}
function getBarClass(percent) {
  if (percent >= 75)
    return "high";
  if (percent >= 50)
    return "medium";
  return "low";
}
function showLoading(visible) {
  const el = document.getElementById("loading");
  if (el) {
    el.classList.toggle("visible", visible);
  }
}
function showError(message) {
  const el = document.getElementById("error-toast");
  if (el) {
    el.textContent = message;
    el.classList.add("visible");
    setTimeout(() => el.classList.remove("visible"), 5000);
  }
}
async function fetchHotAccounts() {
  const res = await fetch(`/api/analytics/hot-accounts?range=${currentRange}&metric=${currentMetric}&limit=50`);
  if (!res.ok) {
    throw new Error(`Failed to fetch hot accounts: ${res.statusText}`);
  }
  return res.json();
}
async function lookupAccount(address) {
  const res = await fetch(`/api/analytics/account-lookup?address=${address}&range=${currentRange}&metric=${currentMetric}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Account not found in the selected time range");
    }
    throw new Error(`Failed to lookup account: ${res.statusText}`);
  }
  return res.json();
}
async function fetchAccountBlocks(address, limit = 10) {
  const res = await fetch(`/api/analytics/account-blocks?address=${address}&range=${currentRange}&limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch account blocks: ${res.statusText}`);
  }
  return res.json();
}
var currentModalAddress = null;
var modalChartMetric = "cu";
var modalChartBlocks = [];
var modalChartAddress = "";
function renderModalChart(blocks, address) {
  const chartEl = document.getElementById("modal-chart");
  if (!chartEl)
    return;
  modalChartBlocks = blocks;
  modalChartAddress = address;
  if (blocks.length === 0) {
    chartEl.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  const sortedBlocks = [...blocks].filter((b) => b.blockTime).sort((a, b) => new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime());
  if (sortedBlocks.length === 0) {
    chartEl.innerHTML = '<div class="empty-state">No time data available</div>';
    return;
  }
  const maxCU = Math.max(...sortedBlocks.map((b) => b.totalCU));
  const baseUrl = window.location.origin;
  const chartHtml = `
    <div class="timeline-chart">
      <div class="chart-metric-toggle">
        <button class="chart-toggle-btn ${modalChartMetric === "cu" ? "active" : ""}" data-metric="cu">CU</button>
        <button class="chart-toggle-btn ${modalChartMetric === "percent" ? "active" : ""}" data-metric="percent">% of 12M Limit</button>
      </div>
      <div class="chart-bars">
        ${sortedBlocks.map((block) => {
    const height = modalChartMetric === "cu" ? block.totalCU / maxCU * 100 : block.percentOfLimit;
    const time = new Date(block.blockTime);
    const timeStr = time.toLocaleString();
    const value = modalChartMetric === "cu" ? formatCU(block.totalCU) : formatPercent(block.percentOfLimit);
    return `
              <a href="${baseUrl}/explorer.html?slot=${block.slot}&accounts=${address}"
                 target="_blank"
                 rel="noopener"
                 class="chart-bar-group"
                 data-slot="${block.slot}"
                 data-time="${timeStr}"
                 data-cu="${formatCU(block.totalCU)}"
                 data-percent="${formatPercent(block.percentOfLimit)}">
                <div class="chart-bar-container">
                  <div class="chart-bar ${modalChartMetric === "cu" ? "cu-bar" : "percent-bar"}" style="height: ${height}%"></div>
                </div>
              </a>
            `;
  }).join("")}
      </div>
      <div class="chart-tooltip" id="chart-tooltip"></div>
    </div>
  `;
  chartEl.innerHTML = chartHtml;
  chartEl.querySelectorAll(".chart-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const metric = btn.getAttribute("data-metric");
      if (metric && metric !== modalChartMetric) {
        modalChartMetric = metric;
        renderModalChart(modalChartBlocks, modalChartAddress);
      }
    });
  });
  const tooltip = document.getElementById("chart-tooltip");
  chartEl.querySelectorAll(".chart-bar-group").forEach((bar) => {
    bar.addEventListener("mouseenter", (e) => {
      if (!tooltip)
        return;
      const slot = bar.getAttribute("data-slot");
      const time = bar.getAttribute("data-time");
      const cu = bar.getAttribute("data-cu");
      const percent = bar.getAttribute("data-percent");
      tooltip.innerHTML = `<strong>Slot ${slot}</strong><br>${time}<br>CU: ${cu}<br>% of 12M Limit: ${percent}`;
      tooltip.classList.add("visible");
    });
    bar.addEventListener("mousemove", (e) => {
      if (!tooltip)
        return;
      const mouseEvent = e;
      tooltip.style.left = `${mouseEvent.clientX + 10}px`;
      tooltip.style.top = `${mouseEvent.clientY + 10}px`;
    });
    bar.addEventListener("mouseleave", () => {
      if (tooltip)
        tooltip.classList.remove("visible");
    });
  });
}
function showModal(address) {
  const modal = document.getElementById("account-modal");
  const addressEl = document.getElementById("modal-address");
  const blocksEl = document.getElementById("modal-blocks");
  const chartEl = document.getElementById("modal-chart");
  if (!modal || !addressEl || !blocksEl || !chartEl)
    return;
  currentModalAddress = address;
  const programName = getProgramName(address);
  addressEl.innerHTML = `
    <a href="https://solscan.io/account/${address}" target="_blank" rel="noopener">${address}</a>
    ${programName ? `<span class="program-label">(${programName})</span>` : ""}
  `;
  blocksEl.innerHTML = '<div class="empty-state">Loading...</div>';
  chartEl.innerHTML = '<div class="empty-state">Loading...</div>';
  modal.classList.add("visible");
  Promise.all([
    fetchAccountBlocks(address, 500),
    fetchAccountBlocks(address, 10)
  ]).then(([allBlocksResponse, topBlocksResponse]) => {
    if (allBlocksResponse.blocks.length === 0) {
      chartEl.innerHTML = '<div class="empty-state">No data</div>';
    } else {
      renderModalChart(allBlocksResponse.blocks, address);
    }
    if (topBlocksResponse.blocks.length === 0) {
      blocksEl.innerHTML = '<div class="empty-state">No block data available for this time range</div>';
      return;
    }
    const baseUrl = window.location.origin;
    blocksEl.innerHTML = topBlocksResponse.blocks.map((block, idx) => {
      const time = block.blockTime ? new Date(block.blockTime).toLocaleString() : "Unknown";
      const percentClass = getBarClass(block.percentOfLimit);
      return `
            <a href="${baseUrl}/explorer.html?slot=${block.slot}&accounts=${address}" class="modal-block-row">
              <span class="modal-block-rank">${idx + 1}</span>
              <span class="modal-block-slot">${block.slot.toLocaleString()}</span>
              <span class="modal-block-time">${time}</span>
              <span class="modal-block-cu">${formatCU(block.totalCU)}</span>
              <span class="modal-block-percent ${percentClass}">${formatPercent(block.percentOfLimit)}</span>
            </a>
          `;
    }).join("");
  }).catch((error) => {
    blocksEl.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
    chartEl.innerHTML = `<div class="empty-state">Error</div>`;
  });
}
function hideModal() {
  const modal = document.getElementById("account-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  currentModalAddress = null;
}
function renderHotAccounts() {
  const container = document.getElementById("hot-accounts-chart");
  if (!container)
    return;
  if (hotAccountsData.length === 0) {
    container.innerHTML = '<div class="empty-state">No data available</div>';
    return;
  }
  let maxValue;
  switch (currentMetric) {
    case "cu":
      maxValue = Math.max(...hotAccountsData.map((a) => a.totalCU));
      break;
    case "max_percent":
      maxValue = Math.max(...hotAccountsData.map((a) => a.maxPercentOfLimit));
      break;
    case "avg_percent":
      maxValue = Math.max(...hotAccountsData.map((a) => a.avgPercentOfLimit));
      break;
  }
  const html = hotAccountsData.slice(0, 20).map((account, idx) => {
    let barValue;
    switch (currentMetric) {
      case "cu":
        barValue = account.totalCU;
        break;
      case "max_percent":
        barValue = account.maxPercentOfLimit;
        break;
      case "avg_percent":
        barValue = account.avgPercentOfLimit;
        break;
    }
    const barWidth = barValue / maxValue * 100;
    const programName = getProgramName(account.address);
    return `
      <div class="bar-row" data-address="${account.address}">
        <span class="bar-rank">${idx + 1}</span>
        <span class="bar-address" title="${account.address}">
          <a href="https://solscan.io/account/${account.address}" target="_blank" rel="noopener" class="address-link" onclick="event.stopPropagation()">${truncateAddress(account.address)}</a>
          ${programName ? `<span class="program-label">(${programName})</span>` : ""}
        </span>
        <div class="bar-track">
          <div class="bar-fill ${getBarClass(account.maxPercentOfLimit)}" style="width: ${barWidth}%"></div>
        </div>
        <span class="bar-value">${formatCU(account.totalCU)}</span>
        <span class="bar-value-secondary">${formatPercent(account.maxPercentOfLimit)}</span>
      </div>
    `;
  }).join("");
  container.innerHTML = html;
  container.querySelectorAll(".bar-row").forEach((row) => {
    row.addEventListener("click", () => {
      const address = row.getAttribute("data-address");
      if (address) {
        showModal(address);
      }
    });
  });
}
function renderAccountsTable() {
  const container = document.getElementById("accounts-table");
  if (!container)
    return;
  if (hotAccountsData.length === 0 && searchedAccounts.size === 0) {
    container.innerHTML = '<div class="empty-state">No data available</div>';
    return;
  }
  const searchedAddrs = new Set(searchedAccounts.keys());
  const displayAccounts = [];
  for (const [addr, account] of searchedAccounts) {
    displayAccounts.push({ account, rank: account.rank, isSearched: true });
  }
  hotAccountsData.forEach((account, idx) => {
    if (!searchedAddrs.has(account.address)) {
      displayAccounts.push({ account, rank: idx + 1, isSearched: false });
    }
  });
  const tableHtml = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Account</th>
            <th class="align-right">Total CU</th>
            <th class="align-right">Blocks</th>
            <th class="align-right">Txs</th>
            <th class="align-right">Max % of 12M</th>
            <th class="align-right">Avg % of 12M</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${displayAccounts.map(({ account, rank, isSearched }) => {
    const programName = getProgramName(account.address);
    return `
              <tr class="clickable ${isSearched ? "searched-row" : ""}" data-address="${account.address}">
                <td class="mono">${rank.toLocaleString()}</td>
                <td class="mono">
                  <a href="https://solscan.io/account/${account.address}" target="_blank" rel="noopener" class="address-link" title="${account.address}" onclick="event.stopPropagation()">${truncateAddress(account.address)}</a>
                  ${programName ? `<span class="program-label">(${programName})</span>` : ""}
                </td>
                <td class="mono align-right">${formatCU(account.totalCU)}</td>
                <td class="mono align-right">${account.blockCount.toLocaleString()}</td>
                <td class="mono align-right">${account.txCount.toLocaleString()}</td>
                <td class="mono align-right">${formatPercent(account.maxPercentOfLimit)}</td>
                <td class="mono align-right">${formatPercent(account.avgPercentOfLimit)}</td>
                <td class="mono">${isSearched ? `<button class="remove-search-btn" data-address="${account.address}" title="Remove">&times;</button>` : ""}</td>
              </tr>
            `;
  }).join("")}
        </tbody>
      </table>
    </div>
  `;
  container.innerHTML = tableHtml;
  container.querySelectorAll("tr.clickable").forEach((row) => {
    row.addEventListener("click", () => {
      const address = row.getAttribute("data-address");
      if (address) {
        showModal(address);
      }
    });
  });
  container.querySelectorAll(".remove-search-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const address = btn.getAttribute("data-address");
      if (address) {
        searchedAccounts.delete(address);
        renderAccountsTable();
      }
    });
  });
}
function updateLastUpdated(endTime) {
  const el = document.getElementById("last-updated");
  if (el) {
    const date = new Date(endTime);
    const now = new Date;
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) {
      el.textContent = "Just now";
    } else if (diffMins < 60) {
      el.textContent = `${diffMins}m ago`;
    } else {
      el.textContent = date.toLocaleTimeString();
    }
  }
}
function updateSubtitle() {
  const el = document.getElementById("hot-accounts-subtitle");
  if (el) {
    let metricText;
    switch (currentMetric) {
      case "cu":
        metricText = "write lock CU";
        break;
      case "max_percent":
        metricText = "max % of 12M limit";
        break;
      case "avg_percent":
        metricText = "avg % of 12M limit";
        break;
    }
    el.textContent = `Top accounts by ${metricText}`;
  }
}
function updateDataRange(startTime, endTime) {
  const el = document.getElementById("data-range");
  if (el) {
    if (!startTime || !endTime) {
      el.textContent = "";
      return;
    }
    const start = new Date(startTime);
    const end = new Date(endTime);
    const formatTime = (d) => {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    };
    el.textContent = `Data: ${formatTime(start)} — ${formatTime(end)}`;
  }
}
async function loadData() {
  showLoading(true);
  try {
    const response = await fetchHotAccounts();
    hotAccountsData = response.accounts;
    updateLastUpdated(response.endTime);
    updateSubtitle();
    updateDataRange(response.startTime, response.endTime);
    renderHotAccounts();
    if (searchedAccounts.size > 0) {
      const addresses = Array.from(searchedAccounts.keys());
      const refreshedAccounts = new Map;
      for (const address of addresses) {
        try {
          const result = await lookupAccount(address);
          refreshedAccounts.set(address, result.account);
        } catch {}
      }
      searchedAccounts = refreshedAccounts;
    }
    renderAccountsTable();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load data";
    showError(message);
  } finally {
    showLoading(false);
  }
}
function setupControls() {
  const modal = document.getElementById("account-modal");
  const modalClose = document.getElementById("modal-close");
  if (modalClose) {
    modalClose.addEventListener("click", hideModal);
  }
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        hideModal();
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideModal();
    }
  });
  const timeRangeToggle = document.getElementById("time-range-toggle");
  if (timeRangeToggle) {
    timeRangeToggle.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-value");
        if (value && value !== currentRange) {
          currentRange = value;
          timeRangeToggle.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          loadData();
        }
      });
    });
  }
  const metricToggle = document.getElementById("metric-toggle");
  if (metricToggle) {
    metricToggle.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-value");
        if (value && value !== currentMetric) {
          currentMetric = value;
          metricToggle.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          loadData();
        }
      });
    });
  }
  const coffeeAddress = document.getElementById("coffee-address");
  if (coffeeAddress) {
    coffeeAddress.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(coffeeAddress.textContent || "");
        coffeeAddress.classList.add("copied");
        setTimeout(() => coffeeAddress.classList.remove("copied"), 2000);
      } catch (e) {
        console.error("Failed to copy:", e);
      }
    });
  }
  const searchInput = document.getElementById("account-search-input");
  const searchBtn = document.getElementById("account-search-btn");
  async function handleSearch() {
    const address = searchInput?.value.trim();
    if (!address)
      return;
    if (address.length < 32 || address.length > 44) {
      showError("Invalid address format");
      return;
    }
    if (searchedAccounts.has(address)) {
      showError("Account already in the list");
      return;
    }
    searchBtn.disabled = true;
    searchBtn.textContent = "Searching...";
    try {
      const response = await lookupAccount(address);
      searchedAccounts.set(address, response.account);
      searchInput.value = "";
      renderAccountsTable();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to lookup account";
      showError(message);
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = "Search";
    }
  }
  if (searchBtn) {
    searchBtn.addEventListener("click", handleSearch);
  }
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        handleSearch();
      }
    });
  }
}
document.addEventListener("DOMContentLoaded", () => {
  setupControls();
  loadData();
  setInterval(loadData, 5 * 60 * 1000);
});
