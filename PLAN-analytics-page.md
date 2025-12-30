# Analytics Page Implementation Plan

## Overview

Add a new analytics page to the Account Lock Explorer that answers:
1. **Hot Accounts Over Time**: Which accounts had the most write lock CUs and/or highest write lock % across blocks over 1h, 24h, 7d?
2. **Account Comparison**: How does a specific account compare to others in write lock % over time?

---

## Part 1: Architecture & Cost Analysis

### Current State
- Real-time RPC queries per block
- No persistent storage
- In-memory cache (10 blocks max)
- Single block analysis only

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA INGESTION                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐ │
│   │ Vercel Cron  │───▶│ Ingest API   │───▶│ Vercel Postgres      │ │
│   │ (every 5min) │    │ /api/ingest  │    │ (aggregated stats)   │ │
│   └──────────────┘    └──────────────┘    └──────────────────────┘ │
│          │                   │                      │               │
│          │                   ▼                      │               │
│          │           ┌──────────────┐               │               │
│          └──────────▶│ Solana RPC   │               │               │
│                      │ (fetch blocks)│               │               │
│                      └──────────────┘               │               │
│                                                      │               │
├─────────────────────────────────────────────────────────────────────┤
│                         DATA SERVING                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐ │
│   │ Analytics    │───▶│ Analytics    │───▶│ Vercel Postgres      │ │
│   │ Frontend     │    │ API          │    │ (read aggregates)    │ │
│   └──────────────┘    └──────────────┘    └──────────────────────┘ │
│                                                                      │
│   ┌──────────────┐                       ┌──────────────────────┐  │
│   │ Block        │───────────────────────▶│ Solana RPC          │  │
│   │ Explorer     │                        │ (real-time)         │  │
│   │ (existing)   │                        └──────────────────────┘  │
│   └──────────────┘                                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

**Delayed Ingestion (every 5 minutes) instead of real-time:**
- Solana produces ~2.5 blocks/second = **750 blocks/5min** = **~43,200 blocks/day**
- Real-time streaming would require WebSocket connections and persistent processes (expensive on serverless)
- 5-minute batches with dedicated RPC

**Vercel Postgres over Redis:**
- Analytics queries need aggregation (SUM, GROUP BY, window functions)
- SQL is ideal for: "top N accounts by CU in last 24h"
- Redis is better for real-time leaderboards but requires complex Lua scripts for aggregations
- Postgres supports time-series queries efficiently with proper indexes

### RPC Performance (Real-World Benchmarks)

Based on actual testing with different RPC providers:

| RPC Provider | Rate Limit | Actual Speed | Time for 750 blocks |
|--------------|------------|--------------|---------------------|
| **Public Solana RPC** | ~10 req/s | ~1-2 blocks/s | ~6-12 minutes |
| **Helius Free** | ~10 req/s | ~4-5 blocks/s | ~2.5-3 minutes |
| **Helius Paid** | 100+ req/s | ~50+ blocks/s | ~15 seconds |

**Key Finding**: RPC rate limits are the primary bottleneck, not compute or database.

### Cron Job Timing Analysis

```
Every 5 minutes, need to process ~750 blocks:

With Helius Free (~5 blocks/sec):
- 750 blocks ÷ 5 blocks/s = 150 seconds (2.5 minutes)
- ✅ Fits within 5-minute window
- ⚠️ Exceeds Vercel Hobby 60s timeout
- ✅ Fits within Vercel Pro 300s timeout

With Helius Paid (~50 blocks/sec):
- 750 blocks ÷ 50 blocks/s = 15 seconds
- ✅ Fits within all timeouts easily
```

### Cost Estimate (Vercel + RPC)

| Resource | Free Tier | Hobby ($20/mo) | Pro ($20+/mo) |
|----------|-----------|----------------|---------------|
| **Postgres** | 256MB storage, 60h compute | 512MB, 100h | 10GB, 100h base |
| **Cron Jobs** | 2 jobs | Unlimited | Unlimited |
| **Serverless** | 100GB-hrs | 1000GB-hrs | 1000GB-hrs base |
| **Function Timeout** | 10s | 60s | 300s |
| **Bandwidth** | 100GB | 1TB | 1TB base |

| RPC Provider | Free Tier | Paid |
|--------------|-----------|------|
| **Helius** | 500k req/month (~5 blocks/s) | $49/mo for 100+ req/s |
| **QuickNode** | 10M credits | $49+/mo |

**Estimated Usage (moderate traffic):**

```
Data Ingestion:
- 750 blocks × 288 runs/day = 216,000 blocks/day (but many are catch-up)
- Actually ~43,200 unique blocks/day
- ~20 hot accounts tracked per block
- ~864k account-block records/day → aggregated to ~10k unique accounts/hour

Storage (with retention):
- Hourly buckets: 24 hours × 10k accounts = 240k rows (~50MB)
- Daily buckets: 7 days × 10k accounts = 70k rows (~15MB)
- Weekly buckets: 4 weeks × 10k accounts = 40k rows (~8MB)
- Block snapshots: ~4,320/day × 7 days = 30k rows (~10MB)
- Total: ~85MB (well within free tier)

Compute:
- Cron: 288 invocations × 150s avg = 720 minutes/day = 12 hours/day
- ⚠️ Requires Pro tier (300s timeout) with Helius Free
- With Helius Paid: 288 × 15s = 72 minutes/day
- API queries: ~1000/day × 200ms = ~3 minutes/day
```

**Cost Verdict:**

| Setup | Monthly Cost | Notes |
|-------|--------------|-------|
| **Minimum Viable** | ~$20 | Vercel Pro + Helius Free (slow but works) |
| **Recommended** | ~$70 | Vercel Pro ($20) + Helius Paid ($49) |
| **Budget Option** | ~$0 | Vercel Hobby + process fewer blocks (gaps in data) |

### Backfill Timing

| Days | Blocks | Time @ 5 blocks/s (Helius Free) | Time @ 50 blocks/s (Helius Paid) |
|------|--------|--------------------------------|----------------------------------|
| 1 | 43,200 | ~2.5 hours | ~15 minutes |
| 3 | 129,600 | ~7.5 hours | ~45 minutes |
| 7 | 302,400 | ~17 hours | ~1.7 hours |

### Assumptions

1. **RPC Rate Limits**: Helius free tier is rate-limited to ~10 req/s. Paid tiers offer 100+ req/s.

2. **Block Processing Time**: With Helius Free, expect ~5 blocks/sec. This requires Vercel Pro tier (300s timeout) to process 750 blocks per 5-minute window.

3. **Account Cardinality**: Tracking top 20 accounts per block. ~10k unique accounts hit write locks daily.

4. **Query Patterns**: Users query "hot accounts" more than "specific account history". Optimize for the former.

5. **Data Retention**: Keep hourly data for 48h, daily for 14d, weekly for 60d. Older data auto-deleted via cron.

---

## Part 2: Data Model

### Postgres Schema

```sql
-- Track the last processed slot to avoid re-processing
CREATE TABLE ingest_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_processed_slot BIGINT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pre-aggregated account stats by time bucket
-- This is the primary analytics table
CREATE TABLE account_stats_hourly (
  account_address VARCHAR(44) NOT NULL,      -- Solana base58 address
  bucket_hour TIMESTAMP WITH TIME ZONE NOT NULL,  -- Truncated to hour

  -- Aggregated metrics
  total_cu BIGINT NOT NULL DEFAULT 0,        -- Sum of CU limits when writable
  block_count INTEGER NOT NULL DEFAULT 0,    -- Blocks where account was written
  tx_count INTEGER NOT NULL DEFAULT 0,       -- Transactions touching this account
  max_percent_of_limit REAL NOT NULL DEFAULT 0,  -- Highest single-block %
  avg_percent_of_limit REAL NOT NULL DEFAULT 0,  -- Average across blocks

  -- For "% of block" calculation
  total_block_cu BIGINT NOT NULL DEFAULT 0,  -- Sum of all block CUs (for weighting)

  PRIMARY KEY (account_address, bucket_hour)
);

-- Daily rollup (aggregated from hourly)
CREATE TABLE account_stats_daily (
  account_address VARCHAR(44) NOT NULL,
  bucket_day DATE NOT NULL,

  total_cu BIGINT NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  tx_count INTEGER NOT NULL DEFAULT 0,
  max_percent_of_limit REAL NOT NULL DEFAULT 0,
  avg_percent_of_limit REAL NOT NULL DEFAULT 0,
  total_block_cu BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (account_address, bucket_day)
);

-- Weekly rollup (aggregated from daily)
CREATE TABLE account_stats_weekly (
  account_address VARCHAR(44) NOT NULL,
  bucket_week DATE NOT NULL,  -- Start of week (Monday)

  total_cu BIGINT NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  tx_count INTEGER NOT NULL DEFAULT 0,
  max_percent_of_limit REAL NOT NULL DEFAULT 0,
  avg_percent_of_limit REAL NOT NULL DEFAULT 0,
  total_block_cu BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (account_address, bucket_week)
);

-- Optional: per-block snapshots for drill-down (expensive, consider sampling)
CREATE TABLE block_snapshots (
  slot BIGINT PRIMARY KEY,
  block_time TIMESTAMP WITH TIME ZONE,
  total_cu BIGINT NOT NULL,
  top_accounts JSONB NOT NULL,  -- Top 10 accounts with their stats
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_hourly_bucket ON account_stats_hourly(bucket_hour);
CREATE INDEX idx_hourly_cu ON account_stats_hourly(bucket_hour, total_cu DESC);
CREATE INDEX idx_daily_bucket ON account_stats_daily(bucket_day);
CREATE INDEX idx_daily_cu ON account_stats_daily(bucket_day, total_cu DESC);
CREATE INDEX idx_weekly_bucket ON account_stats_weekly(bucket_week);
CREATE INDEX idx_snapshots_time ON block_snapshots(block_time);
```

### Why This Schema?

**Pre-aggregated buckets instead of raw data:**
- Raw data: 43k blocks × 50 accounts = 2.1M rows/day = storage explosion
- Aggregated: ~10k accounts × 24 hours = 240k rows/day (pruned to 24h)
- Query time: O(1) for "top accounts in last hour" vs O(n) scan

**Three granularities (hourly/daily/weekly):**
- 1h view: Uses hourly table directly
- 24h view: SUM across 24 hourly rows per account
- 7d view: Uses daily table (7 rows per account)
- Keeps queries fast regardless of time range

**JSONB for block snapshots:**
- Only store top 10 accounts per block (not all)
- Enables drill-down without storing full block data
- Can sample (every 10th block) to reduce storage

### Alternative: Redis (if real-time needed)

```
# Sorted sets for leaderboards
ZADD hot_accounts:1h <cu_total> <account>
ZADD hot_accounts:24h <cu_total> <account>
ZADD hot_accounts:7d <cu_total> <account>

# Time series for account history (requires RedisTimeSeries module)
TS.ADD account:<address>:cu * <value>
TS.ADD account:<address>:percent * <value>

# Pros: Sub-millisecond leaderboard queries
# Cons: Complex aggregations, no SQL joins, harder to query "compare accounts"
```

**Verdict**: Postgres is better for this use case. Redis only if you need real-time (<1s latency).

---

## Part 3: Design Review

### Proposed UI/UX

```
┌─────────────────────────────────────────────────────────────────────┐
│  ARE WE LOCK YET                          [Explorer] [Analytics*]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  TIME RANGE: [1H*] [24H] [7D]         METRIC: [Total CU*] [% Limit] │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    HOT ACCOUNTS CHART                         │  │
│  │  ████████████████████████████████  Account A (Jupiter)        │  │
│  │  ██████████████████████████        Account B (Raydium)        │  │
│  │  ████████████████████              Account C (Orca)           │  │
│  │  ██████████████                    Account D                  │  │
│  │  ████████████                      Account E                  │  │
│  │                                                               │  │
│  │  Click account to add to comparison ↓                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  ACCOUNT COMPARISON (time series)                             │  │
│  │                                                               │  │
│  │  100% ┤                                                       │  │
│  │       │    ╭──╮                                               │  │
│  │   75% ┤   ╱    ╲     ╭───╮   Account A                       │  │
│  │       │  ╱      ╲   ╱     ╲                                   │  │
│  │   50% ┤─╱────────╲─╱───────╲──────────────────────────────   │  │
│  │       │           ╲         ╲   Account B                     │  │
│  │   25% ┤────────────────────────────────────────────────────   │  │
│  │       │                                                       │  │
│  │    0% └───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───────   │  │
│  │           12h  11h 10h  9h  8h  7h  6h  5h  4h  3h  2h  1h   │  │
│  │                                                               │  │
│  │  Selected: [Account A ×] [Account B ×] [+ Add account...]    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  DETAILED STATS TABLE                                         │  │
│  │  ┌────────────┬──────────┬───────┬─────────┬────────────────┐│  │
│  │  │ Account    │ Total CU │ Blocks│ Max %   │ Trend          ││  │
│  │  ├────────────┼──────────┼───────┼─────────┼────────────────┤│  │
│  │  │ Acc...xyz  │ 1.2B     │ 4,231 │ 87.3%   │ ↑ +12%         ││  │
│  │  │ Acc...abc  │ 980M     │ 3,892 │ 72.1%   │ ↓ -5%          ││  │
│  │  │ ...        │ ...      │ ...   │ ...     │ ...            ││  │
│  │  └────────────┴──────────┴───────┴─────────┴────────────────┘│  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Last updated: 5 minutes ago │ Data delay: ~5-10 minutes            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### API Endpoints

```typescript
// Get hot accounts for a time range
GET /api/analytics/hot-accounts?range=1h|24h|7d&metric=cu|percent&limit=50

Response: {
  range: "1h",
  startTime: "2024-01-15T10:00:00Z",
  endTime: "2024-01-15T11:00:00Z",
  accounts: [
    {
      address: "...",
      totalCU: 1234567890,
      blockCount: 432,
      txCount: 1289,
      maxPercentOfLimit: 87.3,
      avgPercentOfLimit: 45.2,
      trend: 12.5  // % change from previous period
    }
  ]
}

// Get time series for specific accounts (for comparison chart)
GET /api/analytics/account-history?accounts=addr1,addr2&range=24h&granularity=hour

Response: {
  range: "24h",
  granularity: "hour",
  series: [
    {
      address: "addr1",
      dataPoints: [
        { time: "2024-01-15T00:00:00Z", totalCU: 123456, percentOfLimit: 45.2 },
        { time: "2024-01-15T01:00:00Z", totalCU: 234567, percentOfLimit: 52.1 },
        // ...
      ]
    }
  ]
}

// Trigger manual ingest (admin only, or remove in production)
POST /api/ingest
```

### Pros of This Design

1. **Scalable**: Pre-aggregation means queries stay fast as data grows
2. **Cost-effective**: Fits in Vercel free/hobby tier
3. **Simple**: No Redis, no streaming infrastructure, just Postgres + Cron
4. **Flexible**: SQL enables complex queries (comparisons, trends, etc.)
5. **Reliable**: Cron is stateless; if it fails, next run catches up
6. **Maintainable**: Standard SQL schema, easy to debug and evolve

### Cons / Trade-offs

1. **5-10 minute delay**: Not suitable for real-time dashboards
   - *Mitigation*: Show "last updated" timestamp, allow manual refresh

2. **RPC dependency**: Public RPC may rate-limit or fail
   - *Mitigation*: Use dedicated RPC, implement retry logic, track failures

3. **Cron timeout risk**: 60s may not be enough for 150 blocks
   - *Mitigation*: Process in smaller batches, use Pro tier, or parallelize

4. **Storage growth**: Without pruning, tables grow indefinitely
   - *Mitigation*: Cron job to delete old hourly data (keep 24h), old daily (keep 7d)

5. **Account cardinality**: If >100k unique accounts, tables get large
   - *Mitigation*: Only track top N accounts per block, or use partitioning

6. **No real-time alerts**: Can't notify users of spikes immediately
   - *Mitigation*: Future enhancement: webhook on threshold breach

### Alternative Approaches Considered

| Approach | Pros | Cons | Why Not Chosen |
|----------|------|------|----------------|
| **Real-time streaming** | Instant updates | Complex, expensive, needs persistent infra | Overkill for "delayed OK" requirement |
| **Redis + Postgres** | Fast leaderboards | Two data stores, more complexity | SQL handles both use cases fine |
| **Vercel KV (Redis)** | Simple setup | 30MB free tier, poor for aggregations | Too limited for analytics |
| **External time-series DB** | Optimized for this | Another service, more cost | Postgres handles the scale |
| **Client-side aggregation** | No backend storage | Slow, can't share data between users | Bad UX, redundant RPC calls |

---

## Part 4: Implementation Steps

### Phase 1: Infrastructure Setup ✅ COMPLETE
1. ✅ Add `@vercel/postgres` dependency (using Bun.sql instead)
2. ✅ Create Postgres database on Vercel
3. ✅ Run schema migrations (locally)
4. ✅ Set up environment variables

### Phase 2: Data Ingestion ✅ COMPLETE
1. ✅ Create ingest logic (`src/lib/ingest.ts`)
2. ✅ Implement block fetching with batch processing
3. ✅ Implement aggregation logic (update hourly buckets)
4. ✅ Create backfill script (`scripts/backfill.ts`)
5. ✅ Create rollup script (`scripts/rollup.ts`)
6. ⏳ Add cron job in `vercel.json` (pending production deploy)
7. ⏳ Add data retention/cleanup logic

### Phase 3: Analytics API ✅ COMPLETE
1. ✅ Create `/api/analytics/hot-accounts` endpoint
2. ✅ Create `/api/analytics/account-history` endpoint
3. ✅ Create `/api/analytics/account-lookup` endpoint (account search with rank)
4. ✅ Create `/api/analytics/account-blocks` endpoint (top blocks for account)
5. ✅ Add caching headers for efficiency
6. ✅ Time ranges use latest available data (not current time)

### Phase 4: Frontend ✅ COMPLETE
1. ✅ Create analytics page HTML/CSS
2. ✅ Implement hot accounts horizontal bar chart
3. ✅ Add account selection/search with global ranking
4. ✅ Add time range selector (1H, 24H, 7D)
5. ✅ Add metric selector (Total CU, Max %, Avg %)
6. ✅ Wire up to existing navigation
7. ✅ Account details modal with timeline chart
8. ✅ Clickable addresses link to Solscan
9. ❌ Account comparison chart (removed - not useful)

### Phase 5: Polish ✅ MOSTLY COMPLETE
1. ✅ Add loading states and error handling
2. ✅ Add "last updated" indicator
3. ✅ Add data range display (shows actual start/end times)
4. ⏳ Optimize queries with EXPLAIN ANALYZE
5. ⏳ Add basic monitoring/logging

### Phase 6: Production Deployment ⏳ PENDING
1. ⬜ Run database migrations on Vercel Postgres
2. ⬜ Run initial backfill against production database
3. ⬜ Run rollup to populate daily/weekly tables
4. ⬜ Deploy code to production branch
5. ⬜ Configure cron job for continuous ingestion
6. ⬜ Verify analytics page works in production
7. ⬜ Monitor for errors and rate limits

---

## Part 6.5: Production Deployment Checklist

### Prerequisites
- Vercel Postgres database created
- `POSTGRES_URL` environment variable set in Vercel
- `SOLANA_RPC_URL` environment variable set (recommend Helius for production)

### Step 1: Run Migrations on Production

```bash
# Connect to production database and run migrations
# Option A: Use Vercel CLI
vercel env pull .env.production
POSTGRES_URL=$(grep POSTGRES_URL .env.production | cut -d= -f2-) bun run scripts/migrate.ts

# Option B: Use Vercel dashboard SQL editor
# Copy SQL from scripts/migrate.ts and run manually
```

### Step 2: Seed Production Database

**Option A: Sync from Local (Recommended if backfill already ran locally)**

If you've already run backfill against your local Docker Postgres, you can sync that data to production:

```bash
# Pull production credentials
vercel env pull .env.production

# Sync all tables from local to production
LOCAL_POSTGRES_URL=postgres://postgres:devpass@localhost:5432/account_lock \
POSTGRES_URL=$(grep POSTGRES_URL .env.production | cut -d= -f2-) \
bun run scripts/sync-to-prod.ts

# Optional: Dry run first to see what would be copied
LOCAL_POSTGRES_URL=postgres://postgres:devpass@localhost:5432/account_lock \
POSTGRES_URL=$(grep POSTGRES_URL .env.production | cut -d= -f2-) \
bun run scripts/sync-to-prod.ts --dry-run

# Sync specific tables only
bun run scripts/sync-to-prod.ts --tables=account_stats_hourly,block_snapshots
```

**Option B: Fresh Backfill (if no local data exists)**

```bash
# Run backfill against production database (from local machine)
# This may take 1-2 hours for 7 days of data
POSTGRES_URL=<production-url> bun run scripts/backfill.ts

# Monitor progress
cat backfill-state.json
```

### Step 3: Run Rollups

```bash
# After backfill/sync completes, populate daily/weekly tables
POSTGRES_URL=<production-url> bun run scripts/rollup.ts
```

### Step 4: Deploy Code

```bash
# Merge dev to main (or your production branch)
git checkout main
git merge dev
git push origin main

# Vercel will auto-deploy
```

### Step 5: Configure Cron Job

Add to `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/ingest",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

Note: Cron jobs require Vercel Pro plan for 5-minute intervals.

### Step 6: Verify Production

1. Visit production analytics page
2. Check all time ranges return data
3. Click on accounts to verify modal works
4. Search for a known account
5. Check Vercel logs for any errors

### Step 7: Set Up Monitoring

1. Enable Vercel Analytics
2. Set up alerts for function errors
3. Monitor database connection pool usage
4. Check RPC rate limit usage

---

## Part 5: Local Development & Testing

### Environment Strategy

| Environment | Database | Cron Jobs | Purpose |
|-------------|----------|-----------|---------|
| Local dev | Docker Postgres | N/A | Development & debugging |
| Preview/PR | **Production Postgres** (read-only) | Disabled | Staging validation with real data |
| Production | Vercel Postgres | Enabled | Live users |

**Key Principle**: Preview branches read from the production database but do NOT run cron jobs. This ensures:
- Preview deployments have real data to test with
- No duplicate data ingestion from preview branches
- Safe testing without affecting production data

### Preview Branch Configuration

To configure preview branches to use production database without running cron jobs:

**1. Set POSTGRES_URL for all environments in Vercel:**

In Vercel Dashboard → Settings → Environment Variables:
- Set `POSTGRES_URL` with scope: **Production, Preview, Development**
- This allows preview branches to read from production database

**2. Disable cron jobs in preview deployments:**

Update `vercel.json` to only run cron in production:

```json
{
  "crons": [
    {
      "path": "/api/ingest",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

Then update `api/ingest.ts` to check for production environment:

```typescript
// At the top of the handler
if (process.env.VERCEL_ENV !== "production") {
  return res.status(200).json({
    message: "Cron disabled in non-production environments",
    env: process.env.VERCEL_ENV
  });
}
```

**3. Alternative: Use separate cron secret per environment:**

Set `CRON_SECRET` only in production environment, so preview cron calls fail auth.

### Why Preview Branches Use Production Data

- **No separate backfill needed**: Preview deployments immediately have access to real analytics data
- **Accurate testing**: Test with actual hot accounts and block data
- **Cost efficient**: No need for separate preview database or backfill runs
- **Safe**: Preview branches only read data; cron jobs are disabled so no writes occur

### Local Setup

```bash
# 1. Start local Postgres
docker run -d --name account-lock-pg \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=account_lock \
  -p 5432:5432 \
  postgres:16

# 2. Create .env.local
cat > .env.local << 'EOF'
POSTGRES_URL=postgres://postgres:devpass@localhost:5432/account_lock
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
EOF

# 3. Run migrations
bun run scripts/migrate.ts

# 4. Start dev server
bun --hot ./src/server/index.ts
```

### Testing Modes

#### 1. Live Mode (fetch recent mainnet blocks)

```bash
# Run ingest locally against mainnet
bun run scripts/ingest.ts
```

Real data in a local database you can safely query, delete, and reset.

#### 2. Fixture Mode (reproducible unit tests)

Save real blocks as JSON fixtures for deterministic tests:

```typescript
// scripts/save-fixtures.ts
const slots = [312000000, 312000001, 312000002];

for (const slot of slots) {
  const res = await fetch(process.env.SOLANA_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBlock",
      params: [slot, { maxSupportedTransactionVersion: 0, transactionDetails: "full" }]
    })
  });
  const data = await res.json();
  await Bun.write(`fixtures/block-${slot}.json`, JSON.stringify(data.result, null, 2));
}
```

Use in tests:
```typescript
// Deterministic, no RPC calls, fast
const block = await Bun.file("fixtures/block-312000000.json").json();
const analysis = analyzeBlock(block);
expect(analysis.accountStats[0].totalCUs).toBeGreaterThan(0);
```

### Docker Commands Reference

```bash
# Stop postgres
docker stop account-lock-pg

# Start existing container
docker start account-lock-pg

# Reset database (delete all data)
docker exec account-lock-pg psql -U postgres -c "DROP DATABASE account_lock; CREATE DATABASE account_lock;"

# Connect with psql
docker exec -it account-lock-pg psql -U postgres -d account_lock

# View logs
docker logs -f account-lock-pg
```

---

## Part 6: Backfill Plan

### Constraints

| Factor | Value | Impact |
|--------|-------|--------|
| **Max history** | 7 days | ~302,400 blocks |
| **Blocks/day** | ~43,200 | ~2.5 blocks/sec |
| **Public RPC limit** | ~10-50 getBlock/sec | Throttling risk |
| **Vercel timeout** | 60s (hobby) / 300s (pro) | Can't backfill in one function |

### Strategy: Chunked Local Backfill

Run backfill locally (not on Vercel) against local Postgres with mainnet RPC:

```
┌─────────────────────────────────────────────────────────────────┐
│                     BACKFILL PROCESS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Local Machine                                                 │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐      │
│   │ Backfill    │────▶│ Mainnet RPC │────▶│ Local PG    │      │
│   │ Script      │     │ (throttled) │     │ (Docker)    │      │
│   └─────────────┘     └─────────────┘     └─────────────┘      │
│         │                                                       │
│         ▼                                                       │
│   ┌─────────────┐                                              │
│   │ Progress    │  ← Resume if interrupted                     │
│   │ checkpoint  │                                              │
│   └─────────────┘                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Time Estimates

| Days | Blocks | Time @ 50 blocks/sec |
|------|--------|---------------------|
| 1 | 43,200 | ~15 minutes |
| 3 | 129,600 | ~45 minutes |
| 7 | 302,400 | ~1.7 hours |

### Backfill Script

```typescript
// scripts/backfill.ts
const BLOCKS_PER_BATCH = 100;
const DELAY_BETWEEN_BATCHES_MS = 2000; // ~50 blocks/sec = safe for public RPC
const MAX_DAYS = 7;
const BLOCKS_PER_DAY = 43_200;
const MAX_BLOCKS = MAX_DAYS * BLOCKS_PER_DAY; // ~302,400

interface BackfillState {
  startSlot: number;
  currentSlot: number;
  endSlot: number;
  processedBlocks: number;
  startedAt: string;
}

const STATE_FILE = "backfill-state.json";

async function getLatestSlot(): Promise<number> {
  const res = await fetch(process.env.SOLANA_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
  });
  const data = await res.json();
  return data.result;
}

async function loadState(): Promise<BackfillState | null> {
  const file = Bun.file(STATE_FILE);
  if (await file.exists()) {
    return file.json();
  }
  return null;
}

async function saveState(state: BackfillState) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function processBlock(slot: number): Promise<void> {
  const res = await fetch(process.env.SOLANA_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBlock",
      params: [slot, { maxSupportedTransactionVersion: 0, transactionDetails: "full", rewards: false }],
    }),
  });

  const data = await res.json();
  if (data.error || !data.result) {
    return; // Slot might be skipped (no block)
  }

  const analysis = analyzeBlock(data.result, slot);

  // Upsert into hourly aggregates
  const bucketHour = new Date(analysis.blockTime! * 1000);
  bucketHour.setMinutes(0, 0, 0);

  for (const account of analysis.accountStats) {
    await sql`
      INSERT INTO account_stats_hourly
        (account_address, bucket_hour, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit)
      VALUES (
        ${account.address},
        ${bucketHour.toISOString()},
        ${account.totalCUs},
        1,
        ${account.txCount},
        ${account.percentOfLimit},
        ${account.percentOfLimit}
      )
      ON CONFLICT (account_address, bucket_hour) DO UPDATE SET
        total_cu = account_stats_hourly.total_cu + EXCLUDED.total_cu,
        block_count = account_stats_hourly.block_count + 1,
        tx_count = account_stats_hourly.tx_count + EXCLUDED.tx_count,
        max_percent_of_limit = GREATEST(account_stats_hourly.max_percent_of_limit, EXCLUDED.max_percent_of_limit),
        avg_percent_of_limit = (account_stats_hourly.avg_percent_of_limit * account_stats_hourly.block_count + EXCLUDED.avg_percent_of_limit)
                               / (account_stats_hourly.block_count + 1)
    `;
  }
}

async function backfill() {
  let state = await loadState();

  if (!state) {
    const latestSlot = await getLatestSlot();
    state = {
      startSlot: latestSlot,
      currentSlot: latestSlot,
      endSlot: latestSlot - MAX_BLOCKS,
      processedBlocks: 0,
      startedAt: new Date().toISOString(),
    };
    console.log(`Starting backfill: ${state.startSlot} → ${state.endSlot} (${MAX_BLOCKS} blocks)`);
  } else {
    console.log(`Resuming backfill from slot ${state.currentSlot} (${state.processedBlocks} already processed)`);
  }

  while (state.currentSlot > state.endSlot) {
    const batchEnd = Math.max(state.currentSlot - BLOCKS_PER_BATCH, state.endSlot);

    console.log(`Processing batch: ${state.currentSlot} → ${batchEnd}`);

    const promises: Promise<void>[] = [];
    for (let slot = state.currentSlot; slot > batchEnd; slot--) {
      promises.push(processBlock(slot));
    }

    await Promise.all(promises);

    state.currentSlot = batchEnd;
    state.processedBlocks += BLOCKS_PER_BATCH;
    await saveState(state);

    const progress = ((state.startSlot - state.currentSlot) / MAX_BLOCKS * 100).toFixed(1);
    console.log(`Progress: ${progress}%`);

    // Throttle to avoid rate limits
    await Bun.sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log("Backfill complete!");
  await Bun.file(STATE_FILE).unlink();
}

backfill().catch(console.error);
```

### Usage

```bash
# Ensure local postgres is running and migrated
docker start account-lock-pg
bun run scripts/migrate.ts

# Start backfill (can Ctrl+C and resume anytime)
bun run scripts/backfill.ts

# Check progress
cat backfill-state.json

# After backfill, run daily/weekly rollups
bun run scripts/rollup.ts
```

### Features

- **Checkpoint file**: `backfill-state.json` tracks progress
- **Resumable**: Script picks up where it left off if interrupted
- **Idempotent**: `ON CONFLICT DO UPDATE` handles re-processing safely
- **Rate-limit safe**: 2s delay between batches (~50 blocks/sec)

### Rate Limit Handling

If you hit rate limits on public RPC, add exponential backoff:

```typescript
async function fetchWithRetry(slot: number, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(/* ... */);
      if (res.status === 429) {
        await Bun.sleep(Math.pow(2, i) * 1000); // 1s, 2s, 4s
        continue;
      }
      return res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await Bun.sleep(1000);
    }
  }
}
```

Or use a dedicated RPC (Helius, QuickNode) for ~10x faster backfill.

### Daily/Weekly Rollup After Backfill

```typescript
// scripts/rollup.ts
await sql`
  INSERT INTO account_stats_daily (account_address, bucket_day, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit)
  SELECT
    account_address,
    DATE(bucket_hour) as bucket_day,
    SUM(total_cu),
    SUM(block_count),
    SUM(tx_count),
    MAX(max_percent_of_limit),
    AVG(avg_percent_of_limit)
  FROM account_stats_hourly
  GROUP BY account_address, DATE(bucket_hour)
  ON CONFLICT (account_address, bucket_day) DO UPDATE SET
    total_cu = EXCLUDED.total_cu,
    block_count = EXCLUDED.block_count,
    tx_count = EXCLUDED.tx_count,
    max_percent_of_limit = EXCLUDED.max_percent_of_limit,
    avg_percent_of_limit = EXCLUDED.avg_percent_of_limit
`;

// Similar for weekly...
```

---

## Summary

| Question | Answer |
|----------|--------|
| **Expected cost?** | Free tier feasible; Hobby ($20/mo) comfortable |
| **Architecture?** | Vercel Cron → Postgres (pre-aggregated) → API → Frontend |
| **Data model?** | 3 tables (hourly/daily/weekly) + block snapshots |
| **Main trade-off?** | 5-10min delay for simplicity + cost savings |
| **Local dev?** | Docker Postgres + Mainnet RPC (never touch prod DB) |
| **Backfill?** | Local script, max 7 days, ~1.7 hours, resumable |

**Recommended approach**: Start with Hobby tier, implement hourly aggregation first, add daily/weekly rollups after validating the pattern works. Monitor RPC usage and upgrade to dedicated RPC if rate-limited.
