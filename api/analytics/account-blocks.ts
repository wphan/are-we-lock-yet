// Account top blocks API - get top blocks by CU for a specific account
// GET /api/analytics/account-blocks?address=xxx&range=1d|7d|14d&limit=10

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

// SQL-safe whitelist for time ranges
const RANGE_MS = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000,
} as const;

interface BlockStats {
  slot: number;
  blockTime: string | null;
  totalCU: number;
  percentOfLimit: number;
  txCount: number;
}

async function getTopBlocks(
  address: string,
  range: TimeRange,
  limit: number
): Promise<BlockStats[]> {
  const db = getDb();
  const rangeMs = RANGE_MS[range];

  if (!rangeMs) {
    return [];
  }

  // Find the latest available block_time
  const latestResult = await db.unsafe(
    `SELECT MAX(block_time) as latest FROM block_snapshots`
  );
  const latestTime = latestResult[0]?.latest;

  if (!latestTime) {
    return [];
  }

  const endTime = new Date(latestTime);
  const startTime = new Date(endTime.getTime() - rangeMs);

  // Query block_snapshots and extract account data from top_accounts JSONB
  const query = `
    SELECT
      slot,
      block_time,
      total_cu as block_total_cu,
      top_accounts
    FROM block_snapshots
    WHERE block_time >= $1 AND block_time <= $2
    ORDER BY block_time DESC
  `;

  const results = await db.unsafe(query, [startTime.toISOString(), endTime.toISOString()]);

  if (!Array.isArray(results)) {
    return [];
  }

  // Process results to find blocks where this account appears
  const accountBlocks: BlockStats[] = [];

  for (const row of results) {
    // Parse JSON string if needed
    let topAccounts: Array<{
      address: string;
      totalCUs: number;
      percentOfLimit: number;
      txCount: number;
    }>;

    if (typeof row.top_accounts === "string") {
      try {
        topAccounts = JSON.parse(row.top_accounts);
      } catch {
        continue;
      }
    } else {
      topAccounts = row.top_accounts;
    }

    const accountData = topAccounts?.find((a) => a.address === address);
    if (accountData) {
      accountBlocks.push({
        slot: parseInt(row.slot, 10),
        blockTime: row.block_time ? new Date(row.block_time).toISOString() : null,
        totalCU: accountData.totalCUs,
        percentOfLimit: accountData.percentOfLimit,
        txCount: accountData.txCount,
      });
    }
  }

  // Sort by totalCU descending and take top N
  accountBlocks.sort((a, b) => b.totalCU - a.totalCU);
  return accountBlocks.slice(0, limit);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const address = req.query.address as string;
    const range = (req.query.range as TimeRange) || "1d";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 500);

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

    const blocks = await getTopBlocks(address, range, limit);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      address,
      range,
      blocks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Account blocks error:", message);
    return res.status(500).json({ error: message });
  }
}
