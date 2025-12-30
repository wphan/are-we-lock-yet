// Hot accounts analytics API
// GET /api/analytics/hot-accounts?range=1h|24h|7d&metric=cu|percent&limit=50

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SQL } from "bun";

let sqlClient: SQL | null = null;

function getDb() {
  if (sqlClient) return sqlClient;
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("POSTGRES_URL environment variable is required");
  }
  sqlClient = new SQL(connectionString);
  return sqlClient;
}

type TimeRange = "1d" | "7d" | "14d";
type Metric = "cu" | "max_percent" | "avg_percent";

// SQL-safe whitelist mappings - these values are used directly in queries
// SECURITY: Only these exact strings are allowed, preventing SQL injection
const RANGE_CONFIG = {
  "1d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
  "7d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
  "14d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 14 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
} as const;

const METRIC_ORDER = {
  "cu": "total_cu DESC",
  "max_percent": "max_percent_of_limit DESC",
  "avg_percent": "avg_percent_of_limit DESC",
} as const;

interface HotAccount {
  address: string;
  totalCU: number;
  blockCount: number;
  txCount: number;
  maxPercentOfLimit: number;
  avgPercentOfLimit: number;
}

async function getHotAccounts(
  range: TimeRange,
  metric: Metric,
  limit: number
): Promise<{ accounts: HotAccount[]; startTime: string; endTime: string }> {
  const db = getDb();

  // SECURITY: These lookups return undefined for invalid input (validated in handler)
  const config = RANGE_CONFIG[range];
  const orderBy = METRIC_ORDER[metric];

  if (!config || !orderBy) {
    return { accounts: [], startTime: "", endTime: "" };
  }

  const { table, timeColumn, rangeMs, bucketMs } = config;

  // Find the latest available data timestamp
  // SECURITY: table and timeColumn are from whitelist, not user input
  const latestResult = await db.unsafe(
    `SELECT MAX(${timeColumn}) as latest FROM ${table}`
  );
  const latestTime = latestResult[0]?.latest;

  if (!latestTime) {
    return { accounts: [], startTime: "", endTime: "" };
  }

  const endTime = new Date(latestTime);
  endTime.setTime(endTime.getTime() + bucketMs);

  const startTime = new Date(endTime.getTime() - rangeMs);

  // Get stats for the time range ending at the latest available data
  // SECURITY: table, timeColumn, orderBy are from whitelists; user values use $1, $2, $3
  const currentQuery = `
    SELECT
      account_address as address,
      SUM(total_cu) as total_cu,
      SUM(block_count) as block_count,
      SUM(tx_count) as tx_count,
      MAX(max_percent_of_limit) as max_percent_of_limit,
      SUM(avg_percent_of_limit * block_count) / NULLIF(SUM(block_count), 0) as avg_percent_of_limit
    FROM ${table}
    WHERE ${timeColumn} >= $1 AND ${timeColumn} <= $2
    GROUP BY account_address
    ORDER BY ${orderBy}
    LIMIT $3
  `;

  const currentResults = await db.unsafe(currentQuery, [
    startTime.toISOString(),
    latestTime,
    limit,
  ]);

  const accounts: HotAccount[] = [];
  if (Array.isArray(currentResults)) {
    for (const row of currentResults) {
      accounts.push({
        address: row.address,
        totalCU: parseFloat(row.total_cu),
        blockCount: parseInt(row.block_count, 10),
        txCount: parseInt(row.tx_count, 10),
        maxPercentOfLimit: parseFloat(row.max_percent_of_limit),
        avgPercentOfLimit: parseFloat(row.avg_percent_of_limit || "0"),
      });
    }
  }

  return {
    accounts,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const range = (req.query.range as TimeRange) || "1d";
    const metric = (req.query.metric as Metric) || "cu";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

    if (!["1d", "7d", "14d"].includes(range)) {
      return res.status(400).json({ error: "Invalid range. Use 1d, 7d, or 14d" });
    }

    if (!["cu", "max_percent", "avg_percent"].includes(metric)) {
      return res.status(400).json({ error: "Invalid metric. Use cu, max_percent, or avg_percent" });
    }

    const result = await getHotAccounts(range, metric, limit);

    // Cache for 1 minute
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      range,
      metric,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Hot accounts error:", message);
    return res.status(500).json({ error: message });
  }
}
