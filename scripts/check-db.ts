import postgres from "postgres";

const sql = postgres(process.env.POSTGRES_URL!, { ssl: "require" });

async function main() {
  try {
    // Ingest state
    const ingest = await sql`SELECT last_processed_slot, updated_at FROM ingest_state WHERE id = 1`;
    console.log("=== INGEST STATE ===");
    console.log("Last processed slot:", ingest[0]?.last_processed_slot);
    console.log("Last updated:", ingest[0]?.updated_at);

    // Hourly stats
    const hourly = await sql`
      SELECT
        COUNT(*) as total_rows,
        COUNT(DISTINCT account_address) as unique_accounts,
        COUNT(DISTINCT bucket_hour) as unique_hours,
        MIN(bucket_hour) as earliest,
        MAX(bucket_hour) as latest
      FROM account_stats_hourly
    `;
    console.log("\n=== HOURLY STATS ===");
    console.log(hourly[0]);

    // Block snapshots
    const snapshots = await sql`
      SELECT
        COUNT(*) as total,
        MIN(slot) as min_slot,
        MAX(slot) as max_slot,
        MIN(block_time) as earliest,
        MAX(block_time) as latest
      FROM block_snapshots
    `;
    console.log("\n=== BLOCK SNAPSHOTS ===");
    console.log(snapshots[0]);

    // Check for hourly gaps
    const gaps = await sql`
      WITH hours AS (
        SELECT generate_series(
          (SELECT MIN(bucket_hour) FROM account_stats_hourly),
          (SELECT MAX(bucket_hour) FROM account_stats_hourly),
          interval '1 hour'
        ) AS hour
      ),
      existing AS (
        SELECT DISTINCT bucket_hour FROM account_stats_hourly
      )
      SELECT COUNT(*) as missing_hours
      FROM hours
      LEFT JOIN existing ON hours.hour = existing.bucket_hour
      WHERE existing.bucket_hour IS NULL
    `;
    console.log("\n=== GAPS ===");
    console.log("Missing hours:", gaps[0]?.missing_hours);

    // List missing hours if any
    if (parseInt(gaps[0]?.missing_hours) > 0) {
      const missingList = await sql`
        WITH hours AS (
          SELECT generate_series(
            (SELECT MIN(bucket_hour) FROM account_stats_hourly),
            (SELECT MAX(bucket_hour) FROM account_stats_hourly),
            interval '1 hour'
          ) AS hour
        ),
        existing AS (
          SELECT DISTINCT bucket_hour FROM account_stats_hourly
        )
        SELECT hours.hour as missing_hour
        FROM hours
        LEFT JOIN existing ON hours.hour = existing.bucket_hour
        WHERE existing.bucket_hour IS NULL
        ORDER BY hours.hour
        LIMIT 20
      `;
      console.log("Missing hours (first 20):", missingList.map(r => r.missing_hour));
    }

    // Daily/weekly rollups
    const daily = await sql`SELECT COUNT(*) as count, MIN(bucket_day) as earliest, MAX(bucket_day) as latest FROM account_stats_daily`;
    const weekly = await sql`SELECT COUNT(*) as count, MIN(bucket_week) as earliest, MAX(bucket_week) as latest FROM account_stats_weekly`;
    console.log("\n=== ROLLUPS ===");
    console.log("Daily:", daily[0]);
    console.log("Weekly:", weekly[0]);

    await sql.end();
  } catch (e: any) {
    console.error("Error:", e.message);
    await sql.end();
    process.exit(1);
  }
}

main();
