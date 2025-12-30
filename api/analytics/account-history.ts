// Account history analytics API
// GET /api/analytics/account-history?accounts=addr1,addr2&range=7d

import type { VercelRequest, VercelResponse } from "@vercel/node";
import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

function getDb() {
  if (sql) return sql;
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("POSTGRES_URL environment variable is required");
  }
  sql = postgres(connectionString, { ssl: "require" });
  return sql;
}

type TimeRange = "1d" | "7d" | "14d";

// SQL-safe whitelist mappings - these values are used directly in queries
// SECURITY: Only these exact strings are allowed, preventing SQL injection
const RANGE_CONFIG = {
  "1d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 24 * 60 * 60 * 1000, granularity: "day" },
  "7d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 7 * 24 * 60 * 60 * 1000, granularity: "day" },
  "14d": { table: "account_stats_daily", timeColumn: "bucket_day", rangeMs: 14 * 24 * 60 * 60 * 1000, granularity: "day" },
} as const;

interface DataPoint {
  time: string;
  totalCU: number;
  blockCount: number;
  txCount: number;
  maxPercentOfLimit: number;
  avgPercentOfLimit: number;
}

interface AccountSeries {
  address: string;
  dataPoints: DataPoint[];
}

async function getAccountHistory(
  accounts: string[],
  range: TimeRange
): Promise<{ series: AccountSeries[]; granularity: string }> {
  const db = getDb();
  const now = new Date();

  // SECURITY: Lookup returns undefined for invalid input (validated in handler)
  const config = RANGE_CONFIG[range];

  if (!config) {
    return { series: [], granularity: "hour" };
  }

  const { table, timeColumn, rangeMs, granularity } = config;
  const startTime = new Date(now.getTime() - rangeMs);

  // Build placeholders for account addresses
  // SECURITY: placeholders are just "$2", "$3", etc. - actual addresses are passed as parameters
  const placeholders = accounts.map((_, i) => `$${i + 2}`).join(", ");

  // SECURITY: table, timeColumn are from whitelist; account addresses use parameterized $N values
  const query = `
    SELECT
      account_address as address,
      ${timeColumn} as time,
      total_cu,
      block_count,
      tx_count,
      max_percent_of_limit,
      avg_percent_of_limit
    FROM ${table}
    WHERE ${timeColumn} >= $1
      AND account_address IN (${placeholders})
    ORDER BY account_address, ${timeColumn}
  `;

  const results = await db.unsafe(query, [startTime.toISOString(), ...accounts]);

  // Group by account
  const seriesMap = new Map<string, DataPoint[]>();

  // Initialize empty arrays for all requested accounts
  for (const addr of accounts) {
    seriesMap.set(addr, []);
  }

  if (Array.isArray(results)) {
    for (const row of results) {
      const dataPoints = seriesMap.get(row.address);
      if (dataPoints) {
        dataPoints.push({
          time: new Date(row.time).toISOString(),
          totalCU: parseFloat(row.total_cu),
          blockCount: parseInt(row.block_count, 10),
          txCount: parseInt(row.tx_count, 10),
          maxPercentOfLimit: parseFloat(row.max_percent_of_limit),
          avgPercentOfLimit: parseFloat(row.avg_percent_of_limit || "0"),
        });
      }
    }
  }

  const series: AccountSeries[] = [];
  for (const [address, dataPoints] of seriesMap) {
    series.push({ address, dataPoints });
  }

  return { series, granularity };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const accountsParam = req.query.accounts as string;
    const range = (req.query.range as TimeRange) || "7d";

    if (!accountsParam) {
      return res.status(400).json({ error: "accounts parameter is required" });
    }

    // Validate Solana address format (32-44 chars, Base58 alphabet)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const accounts = accountsParam
      .split(",")
      .slice(0, 10) // Max 10 accounts
      .filter((addr) => base58Regex.test(addr));

    if (accounts.length === 0) {
      return res.status(400).json({ error: "At least one valid account is required" });
    }

    if (!["1d", "7d", "14d"].includes(range)) {
      return res.status(400).json({ error: "Invalid range. Use 1d, 7d, or 14d" });
    }

    const result = await getAccountHistory(accounts, range);

    // Cache for 1 minute
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      range,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Account history error:", message);
    return res.status(500).json({ error: message });
  }
}
