// Account lookup API - get stats and global ranking for a specific account
// GET /api/analytics/account-lookup?address=xxx&range=1h|24h|7d&metric=cu|percent

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

const METRIC_COLUMN = {
  "cu": "total_cu",
  "max_percent": "max_percent_of_limit",
  "avg_percent": "avg_percent_of_limit",
} as const;

interface AccountStats {
  address: string;
  rank: number;
  totalCU: number;
  blockCount: number;
  txCount: number;
  maxPercentOfLimit: number;
  avgPercentOfLimit: number;
}

async function lookupAccount(
  address: string,
  range: TimeRange,
  metric: Metric
): Promise<AccountStats | null> {
  const db = getDb();

  // SECURITY: These lookups return undefined for invalid input (validated in handler)
  const config = RANGE_CONFIG[range];
  const orderByColumn = METRIC_COLUMN[metric];

  if (!config || !orderByColumn) {
    return null;
  }

  const { table, timeColumn, rangeMs, bucketMs } = config;

  // Find the latest available data timestamp
  // SECURITY: table and timeColumn are from whitelist, not user input
  const latestResult = await db.unsafe(
    `SELECT MAX(${timeColumn}) as latest FROM ${table}`
  );
  const latestTime = latestResult[0]?.latest;

  if (!latestTime) {
    return null;
  }

  const endTime = new Date(latestTime);
  endTime.setTime(endTime.getTime() + bucketMs);
  const startTime = new Date(endTime.getTime() - rangeMs);

  // Get account stats with rank using a window function
  // SECURITY: table, timeColumn, orderByColumn are from whitelists; user values use $1, $2, $3
  const query = `
    WITH ranked AS (
      SELECT
        account_address as address,
        SUM(total_cu) as total_cu,
        SUM(block_count) as block_count,
        SUM(tx_count) as tx_count,
        MAX(max_percent_of_limit) as max_percent_of_limit,
        SUM(avg_percent_of_limit * block_count) / NULLIF(SUM(block_count), 0) as avg_percent_of_limit,
        ROW_NUMBER() OVER (ORDER BY SUM(${orderByColumn}) DESC) as rank
      FROM ${table}
      WHERE ${timeColumn} >= $1 AND ${timeColumn} <= $2
      GROUP BY account_address
    )
    SELECT * FROM ranked WHERE address = $3
  `;

  const results = await db.unsafe(query, [startTime.toISOString(), latestTime, address]);

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const row = results[0];

  return {
    address: row.address,
    rank: parseInt(row.rank, 10),
    totalCU: parseFloat(row.total_cu),
    blockCount: parseInt(row.block_count, 10),
    txCount: parseInt(row.tx_count, 10),
    maxPercentOfLimit: parseFloat(row.max_percent_of_limit),
    avgPercentOfLimit: parseFloat(row.avg_percent_of_limit || "0"),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const address = req.query.address as string;
    const range = (req.query.range as TimeRange) || "1d";
    const metric = (req.query.metric as Metric) || "cu";

    if (!address) {
      return res.status(400).json({ error: "address parameter is required" });
    }

    // Validate Solana address format (32-44 chars, Base58 alphabet)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!base58Regex.test(address)) {
      return res.status(400).json({ error: "Invalid address format" });
    }

    if (!["1d", "7d", "14d"].includes(range)) {
      return res.status(400).json({ error: "Invalid range. Use 1d, 7d, or 14d" });
    }

    if (!["cu", "max_percent", "avg_percent"].includes(metric)) {
      return res.status(400).json({ error: "Invalid metric. Use cu, max_percent, or avg_percent" });
    }

    const account = await lookupAccount(address, range, metric);

    if (!account) {
      return res.status(404).json({ error: "Account not found in the selected time range" });
    }

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      range,
      metric,
      account,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Account lookup error:", message);
    return res.status(500).json({ error: message });
  }
}
