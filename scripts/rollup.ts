// Rollup script - aggregates hourly data into daily and weekly buckets
// Run after backfill or periodically via cron
// Usage: bun run scripts/rollup.ts

import { getDb } from "../src/lib/db/index.ts";

async function rollupDaily() {
  console.log("Rolling up hourly data to daily...");
  const db = getDb();

  await db.execute(`
    INSERT INTO account_stats_daily
      (account_address, bucket_day, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
    SELECT
      account_address,
      DATE(bucket_hour) as bucket_day,
      SUM(total_cu) as total_cu,
      SUM(block_count) as block_count,
      SUM(tx_count) as tx_count,
      MAX(max_percent_of_limit) as max_percent_of_limit,
      SUM(avg_percent_of_limit * block_count) / NULLIF(SUM(block_count), 0) as avg_percent_of_limit,
      SUM(total_block_cu) as total_block_cu
    FROM account_stats_hourly
    GROUP BY account_address, DATE(bucket_hour)
    ON CONFLICT (account_address, bucket_day) DO UPDATE SET
      total_cu = EXCLUDED.total_cu,
      block_count = EXCLUDED.block_count,
      tx_count = EXCLUDED.tx_count,
      max_percent_of_limit = EXCLUDED.max_percent_of_limit,
      avg_percent_of_limit = EXCLUDED.avg_percent_of_limit,
      total_block_cu = EXCLUDED.total_block_cu
  `);

  const dailyCount = await db.query<{ count: string }>(
    "SELECT COUNT(DISTINCT bucket_day) as count FROM account_stats_daily"
  );
  console.log(`  Daily buckets: ${dailyCount[0]?.count || 0}`);
}

async function rollupWeekly() {
  console.log("Rolling up daily data to weekly...");
  const db = getDb();

  await db.execute(`
    INSERT INTO account_stats_weekly
      (account_address, bucket_week, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
    SELECT
      account_address,
      DATE_TRUNC('week', bucket_day)::date as bucket_week,
      SUM(total_cu) as total_cu,
      SUM(block_count) as block_count,
      SUM(tx_count) as tx_count,
      MAX(max_percent_of_limit) as max_percent_of_limit,
      SUM(avg_percent_of_limit * block_count) / NULLIF(SUM(block_count), 0) as avg_percent_of_limit,
      SUM(total_block_cu) as total_block_cu
    FROM account_stats_daily
    GROUP BY account_address, DATE_TRUNC('week', bucket_day)
    ON CONFLICT (account_address, bucket_week) DO UPDATE SET
      total_cu = EXCLUDED.total_cu,
      block_count = EXCLUDED.block_count,
      tx_count = EXCLUDED.tx_count,
      max_percent_of_limit = EXCLUDED.max_percent_of_limit,
      avg_percent_of_limit = EXCLUDED.avg_percent_of_limit,
      total_block_cu = EXCLUDED.total_block_cu
  `);

  const weeklyCount = await db.query<{ count: string }>(
    "SELECT COUNT(DISTINCT bucket_week) as count FROM account_stats_weekly"
  );
  console.log(`  Weekly buckets: ${weeklyCount[0]?.count || 0}`);
}

async function pruneOldData() {
  console.log("Pruning old data...");
  const db = getDb();

  // Keep hourly data for 48 hours (extra buffer)
  const hourlyResult = await db.execute(`
    DELETE FROM account_stats_hourly
    WHERE bucket_hour < NOW() - INTERVAL '48 hours'
  `);
  console.log(`  Pruned hourly data older than 48 hours`);

  // Keep daily data for 14 days (extra buffer for 7d view)
  const dailyResult = await db.execute(`
    DELETE FROM account_stats_daily
    WHERE bucket_day < CURRENT_DATE - INTERVAL '14 days'
  `);
  console.log(`  Pruned daily data older than 14 days`);

  // Keep weekly data for 60 days
  const weeklyResult = await db.execute(`
    DELETE FROM account_stats_weekly
    WHERE bucket_week < CURRENT_DATE - INTERVAL '60 days'
  `);
  console.log(`  Pruned weekly data older than 60 days`);

  // Keep block snapshots for 7 days
  const snapshotResult = await db.execute(`
    DELETE FROM block_snapshots
    WHERE block_time < NOW() - INTERVAL '7 days'
  `);
  console.log(`  Pruned block snapshots older than 7 days`);
}

async function showStats() {
  console.log("\nCurrent table sizes:");
  const db = getDb();

  const tables = [
    "account_stats_hourly",
    "account_stats_daily",
    "account_stats_weekly",
    "block_snapshots",
  ];

  for (const table of tables) {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${table}`
    );
    console.log(`  ${table}: ${parseInt(result[0]?.count || "0").toLocaleString()} rows`);
  }
}

async function rollup() {
  console.log("Starting rollup process...\n");

  await rollupDaily();
  await rollupWeekly();
  await pruneOldData();
  await showStats();

  console.log("\nRollup complete!");
}

rollup().catch((err) => {
  console.error("Rollup failed:", err);
  process.exit(1);
});
