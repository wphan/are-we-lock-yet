// Analytics stats API - returns summary statistics
// GET /api/analytics/stats

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const db = getDb();

    // Get last ingest time
    const ingestState = await db.unsafe(
      "SELECT last_processed_slot, updated_at FROM ingest_state WHERE id = 1"
    );

    // Get table counts
    const hourlyCount = await db.unsafe(
      "SELECT COUNT(*) as count FROM account_stats_hourly"
    );
    const dailyCount = await db.unsafe(
      "SELECT COUNT(*) as count FROM account_stats_daily"
    );
    const weeklyCount = await db.unsafe(
      "SELECT COUNT(*) as count FROM account_stats_weekly"
    );
    const snapshotCount = await db.unsafe(
      "SELECT COUNT(*) as count FROM block_snapshots"
    );

    // Get time range of data
    const timeRange = await db.unsafe(`
      SELECT
        MIN(bucket_hour) as earliest,
        MAX(bucket_hour) as latest
      FROM account_stats_hourly
    `);

    const lastProcessedSlot = Array.isArray(ingestState) && ingestState.length > 0
      ? parseInt(ingestState[0].last_processed_slot, 10)
      : null;

    const lastUpdated = Array.isArray(ingestState) && ingestState.length > 0
      ? ingestState[0].updated_at
      : null;

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      lastProcessedSlot,
      lastUpdated,
      tables: {
        hourly: parseInt((hourlyCount as any)[0]?.count || "0", 10),
        daily: parseInt((dailyCount as any)[0]?.count || "0", 10),
        weekly: parseInt((weeklyCount as any)[0]?.count || "0", 10),
        snapshots: parseInt((snapshotCount as any)[0]?.count || "0", 10),
      },
      dataRange: {
        earliest: (timeRange as any)[0]?.earliest || null,
        latest: (timeRange as any)[0]?.latest || null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Stats error:", message);
    return res.status(500).json({ error: message });
  }
}
