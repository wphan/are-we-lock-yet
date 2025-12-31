// Rollup API endpoint - aggregates hourly data into daily/weekly
// Called by Vercel Cron once per hour

import type { VercelRequest, VercelResponse } from "@vercel/node";
import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

// Track database operations for usage monitoring
let dbStats = { queries: 0, rowsAffected: 0 };

function getDb() {
  if (sql) return sql;
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("POSTGRES_URL environment variable is required");
  }
  sql = postgres(connectionString, { ssl: "require" });
  return sql;
}

async function rollupDaily(db: ReturnType<typeof postgres>): Promise<number> {
  const result = await db.unsafe(`
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
  dbStats.queries++;
  dbStats.rowsAffected += result.count || 0;

  const count = await db.unsafe("SELECT COUNT(DISTINCT bucket_day) as count FROM account_stats_daily");
  dbStats.queries++;
  return parseInt(count[0]?.count || "0", 10);
}

async function rollupWeekly(db: ReturnType<typeof postgres>): Promise<number> {
  const result = await db.unsafe(`
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
  dbStats.queries++;
  dbStats.rowsAffected += result.count || 0;

  const count = await db.unsafe("SELECT COUNT(DISTINCT bucket_week) as count FROM account_stats_weekly");
  dbStats.queries++;
  return parseInt(count[0]?.count || "0", 10);
}

async function pruneOldData(db: ReturnType<typeof postgres>): Promise<{ hourly: number; daily: number; weekly: number; snapshots: number }> {
  // Keep hourly data for 48 hours
  const hourlyResult = await db.unsafe(`
    DELETE FROM account_stats_hourly
    WHERE bucket_hour < NOW() - INTERVAL '48 hours'
  `);
  dbStats.queries++;
  dbStats.rowsAffected += hourlyResult.count || 0;

  // Keep daily data for 21 days (buffer for 14d view)
  const dailyResult = await db.unsafe(`
    DELETE FROM account_stats_daily
    WHERE bucket_day < CURRENT_DATE - INTERVAL '21 days'
  `);
  dbStats.queries++;
  dbStats.rowsAffected += dailyResult.count || 0;

  // Keep weekly data for 60 days
  const weeklyResult = await db.unsafe(`
    DELETE FROM account_stats_weekly
    WHERE bucket_week < CURRENT_DATE - INTERVAL '60 days'
  `);
  dbStats.queries++;
  dbStats.rowsAffected += weeklyResult.count || 0;

  // Keep block snapshots for 14 days
  const snapshotResult = await db.unsafe(`
    DELETE FROM block_snapshots
    WHERE block_time < NOW() - INTERVAL '14 days'
  `);
  dbStats.queries++;
  dbStats.rowsAffected += snapshotResult.count || 0;

  return {
    hourly: hourlyResult.count || 0,
    daily: dailyResult.count || 0,
    weekly: weeklyResult.count || 0,
    snapshots: snapshotResult.count || 0,
  };
}

async function getTableCounts(db: ReturnType<typeof postgres>) {
  const hourly = await db.unsafe("SELECT COUNT(*) as count FROM account_stats_hourly");
  dbStats.queries++;
  const daily = await db.unsafe("SELECT COUNT(*) as count FROM account_stats_daily");
  dbStats.queries++;
  const weekly = await db.unsafe("SELECT COUNT(*) as count FROM account_stats_weekly");
  dbStats.queries++;
  const snapshots = await db.unsafe("SELECT COUNT(*) as count FROM block_snapshots");
  dbStats.queries++;

  return {
    hourly: parseInt(hourly[0]?.count || "0", 10),
    daily: parseInt(daily[0]?.count || "0", 10),
    weekly: parseInt(weekly[0]?.count || "0", 10),
    snapshots: parseInt(snapshots[0]?.count || "0", 10),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Disable in non-production environments
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return res.status(200).json({
      message: "Rollup disabled in non-production environments",
      env: process.env.VERCEL_ENV,
    });
  }

  // Verify cron secret if configured
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const startTime = Date.now();
  dbStats = { queries: 0, rowsAffected: 0 }; // Reset stats for this run

  try {
    const db = getDb();

    console.log("[ROLLUP] Starting rollup process...");

    // Rollup hourly → daily
    const dailyStart = Date.now();
    const dailyBuckets = await rollupDaily(db);
    const dailyMs = Date.now() - dailyStart;
    console.log(`[ROLLUP] Daily rollup complete: ${dailyBuckets} buckets in ${dailyMs}ms`);

    // Rollup daily → weekly
    const weeklyStart = Date.now();
    const weeklyBuckets = await rollupWeekly(db);
    const weeklyMs = Date.now() - weeklyStart;
    console.log(`[ROLLUP] Weekly rollup complete: ${weeklyBuckets} buckets in ${weeklyMs}ms`);

    // Prune old data
    const pruneStart = Date.now();
    const pruned = await pruneOldData(db);
    const pruneMs = Date.now() - pruneStart;
    console.log(`[ROLLUP] Pruning complete in ${pruneMs}ms:`, pruned);

    // Get final counts
    const counts = await getTableCounts(db);

    const duration = Date.now() - startTime;
    console.log(`[ROLLUP] Complete in ${duration}ms | DB: ${dbStats.queries} queries, ${dbStats.rowsAffected} rows affected`);

    return res.status(200).json({
      success: true,
      durationMs: duration,
      rollup: {
        dailyBuckets,
        dailyMs,
        weeklyBuckets,
        weeklyMs,
      },
      pruned,
      pruneMs,
      tableCounts: counts,
      dbStats: {
        queries: dbStats.queries,
        rowsAffected: dbStats.rowsAffected,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[ROLLUP] Error:", message);
    return res.status(500).json({ error: message });
  }
}
