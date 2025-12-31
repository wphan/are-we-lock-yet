import type { TransactionMetrics } from '../../lib/types.ts';

function formatMicroLamports(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toLocaleString();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
}

export function renderCuPriceHistogram(transactions: TransactionMetrics[]) {
  const statsContainer = document.getElementById('histogram-stats');
  const histogramContainer = document.getElementById('histogram-container');
  if (!statsContainer || !histogramContainer) return;

  // Filter out vote transactions and get CU prices
  const cuPrices = transactions
    .filter(tx => !tx.isVote)
    .map(tx => tx.cuPrice)
    .sort((a, b) => a - b);

  if (cuPrices.length === 0) {
    statsContainer.innerHTML = '<span class="empty-state">No non-vote transactions</span>';
    histogramContainer.innerHTML = '';
    return;
  }

  // Calculate percentiles
  const p25 = percentile(cuPrices, 25);
  const p50 = percentile(cuPrices, 50);
  const p75 = percentile(cuPrices, 75);
  const p99 = percentile(cuPrices, 99);
  const min = cuPrices[0];
  const max = cuPrices[cuPrices.length - 1];

  // Render stats
  statsContainer.innerHTML = `
    <div class="histogram-stat">
      <span class="histogram-stat-label">Min</span>
      <span class="histogram-stat-value">${formatMicroLamports(min)}</span>
    </div>
    <div class="histogram-stat">
      <span class="histogram-stat-label">P25</span>
      <span class="histogram-stat-value">${formatMicroLamports(p25)}</span>
    </div>
    <div class="histogram-stat">
      <span class="histogram-stat-label">P50 (Median)</span>
      <span class="histogram-stat-value highlight">${formatMicroLamports(p50)}</span>
    </div>
    <div class="histogram-stat">
      <span class="histogram-stat-label">P75</span>
      <span class="histogram-stat-value">${formatMicroLamports(p75)}</span>
    </div>
    <div class="histogram-stat">
      <span class="histogram-stat-label">P99</span>
      <span class="histogram-stat-value">${formatMicroLamports(p99)}</span>
    </div>
    <div class="histogram-stat">
      <span class="histogram-stat-label">Max</span>
      <span class="histogram-stat-value">${formatMicroLamports(max)}</span>
    </div>
  `;

  // Create histogram buckets using logarithmic scale for better distribution
  const numBuckets = 20;

  // Use log scale if there's a wide range
  const useLogScale = max > 0 && (max / Math.max(min, 1)) > 100;

  let buckets: { min: number; max: number; count: number }[] = [];

  if (useLogScale && min >= 0 && max > 0) {
    // Log scale buckets
    const logMin = min > 0 ? Math.log10(min) : 0;
    const logMax = Math.log10(max);
    const logStep = (logMax - logMin) / numBuckets;

    for (let i = 0; i < numBuckets; i++) {
      const bucketMin = i === 0 ? min : Math.pow(10, logMin + i * logStep);
      const bucketMax = i === numBuckets - 1 ? max : Math.pow(10, logMin + (i + 1) * logStep);
      buckets.push({ min: bucketMin, max: bucketMax, count: 0 });
    }
  } else {
    // Linear scale buckets
    const step = (max - min) / numBuckets || 1;
    for (let i = 0; i < numBuckets; i++) {
      buckets.push({
        min: min + i * step,
        max: min + (i + 1) * step,
        count: 0
      });
    }
  }

  // Count transactions in each bucket
  for (const price of cuPrices) {
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (price >= bucket.min && (price < bucket.max || i === buckets.length - 1)) {
        bucket.count++;
        break;
      }
    }
  }

  // Find max count for scaling
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  // Render histogram
  const bars = buckets.map((bucket, i) => {
    const height = (bucket.count / maxCount) * 100;
    const label = formatMicroLamports(bucket.min);
    const rangeLabel = `${formatMicroLamports(bucket.min)} - ${formatMicroLamports(bucket.max)}`;
    return `
      <div class="histogram-bar-wrapper" data-tooltip="${rangeLabel}: ${bucket.count} txs">
        <div class="histogram-bar" style="height: ${height}%"></div>
        ${i % 4 === 0 ? `<span class="histogram-label">${label}</span>` : ''}
      </div>
    `;
  }).join('');

  histogramContainer.innerHTML = `
    <div class="histogram-y-axis">
      <span class="histogram-y-label">${maxCount}</span>
      <span class="histogram-y-label">${Math.round(maxCount / 2)}</span>
      <span class="histogram-y-label">0</span>
    </div>
    <div class="histogram-bars">
      ${bars}
    </div>
  `;
}
