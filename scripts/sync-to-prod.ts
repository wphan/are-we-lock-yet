// Sync local database to production
// Copies all analytics data from local Docker Postgres to production Vercel Postgres
//
// Usage:
//   LOCAL_POSTGRES_URL=postgres://postgres:devpass@localhost:5432/account_lock \
//   POSTGRES_URL=<production-url> \
//   bun run scripts/sync-to-prod.ts
//
// Options:
//   --dry-run    Show what would be copied without actually copying
//   --tables     Comma-separated list of tables to sync (default: all)

import { SQL } from "bun";

const TABLES = [
  "ingest_state",
  "account_stats_hourly",
  "account_stats_daily",
  "account_stats_weekly",
  "block_snapshots",
] as const;

const BATCH_SIZE = 1000;

interface SyncStats {
  table: string;
  rows: number;
  duration: number;
}

async function getRowCount(db: SQL, table: string): Promise<number> {
  const result = await db.unsafe(`SELECT COUNT(*) as count FROM ${table}`);
  return parseInt(result[0]?.count || "0", 10);
}

async function syncTable(
  sourceDb: SQL,
  targetDb: SQL,
  table: string,
  dryRun: boolean
): Promise<SyncStats> {
  const startTime = Date.now();

  const rowCount = await getRowCount(sourceDb, table);
  console.log(`  ${table}: ${rowCount.toLocaleString()} rows`);

  if (dryRun) {
    return { table, rows: rowCount, duration: Date.now() - startTime };
  }

  if (rowCount === 0) {
    return { table, rows: 0, duration: Date.now() - startTime };
  }

  // Clear target table first
  await targetDb.unsafe(`DELETE FROM ${table}`);

  // Get column names from source
  const columnsResult = await sourceDb.unsafe(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${table}'
    ORDER BY ordinal_position
  `);
  const columns = columnsResult.map((r: any) => r.column_name);
  const columnList = columns.join(", ");
  const placeholders = columns.map((_: string, i: number) => `$${i + 1}`).join(", ");

  // Copy in batches
  let copied = 0;
  let offset = 0;

  while (offset < rowCount) {
    const rows = await sourceDb.unsafe(
      `SELECT ${columnList} FROM ${table} ORDER BY 1 LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    );

    for (const row of rows) {
      const values = columns.map((col: string) => {
        const val = row[col];
        // Handle Date objects - convert to ISO string
        if (val instanceof Date) {
          return val.toISOString();
        }
        // Handle JSONB columns
        if (typeof val === "object" && val !== null) {
          return JSON.stringify(val);
        }
        // Handle date strings with problematic timezones
        if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val)) {
          // Parse and re-format to ensure clean ISO format
          const date = new Date(val);
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        }
        return val;
      });

      await targetDb.unsafe(
        `INSERT INTO ${table} (${columnList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      copied++;
    }

    offset += BATCH_SIZE;
    const progress = Math.min(100, Math.round((offset / rowCount) * 100));
    process.stdout.write(`\r  ${table}: ${copied.toLocaleString()} / ${rowCount.toLocaleString()} (${progress}%)`);
  }

  console.log(`\r  ${table}: ${copied.toLocaleString()} rows copied ✓`);

  return { table, rows: copied, duration: Date.now() - startTime };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tablesArg = args.find((a) => a.startsWith("--tables="));
  const tablesToSync = tablesArg
    ? tablesArg.split("=")[1]!.split(",")
    : [...TABLES];

  // Validate table names
  for (const table of tablesToSync) {
    if (!TABLES.includes(table as any)) {
      console.error(`Unknown table: ${table}`);
      console.error(`Valid tables: ${TABLES.join(", ")}`);
      process.exit(1);
    }
  }

  const localUrl = process.env.LOCAL_POSTGRES_URL;
  const prodUrl = process.env.POSTGRES_URL;

  if (!localUrl) {
    console.error("LOCAL_POSTGRES_URL environment variable is required");
    console.error("Example: postgres://postgres:devpass@localhost:5432/account_lock");
    process.exit(1);
  }

  if (!prodUrl) {
    console.error("POSTGRES_URL environment variable is required (production database)");
    process.exit(1);
  }

  // Safety check - don't sync to localhost
  if (prodUrl.includes("localhost") || prodUrl.includes("127.0.0.1")) {
    console.error("POSTGRES_URL appears to be a local database. Use POSTGRES_URL for production only.");
    process.exit(1);
  }

  console.log("=== Database Sync: Local → Production ===\n");
  console.log(`Source: ${localUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Target: ${prodUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Tables: ${tablesToSync.join(", ")}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log("");

  if (!dryRun) {
    console.log("⚠️  WARNING: This will REPLACE all data in the production tables!");
    console.log("Press Ctrl+C within 5 seconds to cancel...\n");
    await Bun.sleep(5000);
  }

  const sourceDb = new SQL(localUrl);
  const targetDb = new SQL(prodUrl);

  // Test connections
  try {
    await sourceDb.unsafe("SELECT 1");
    console.log("✓ Connected to source database");
  } catch (error) {
    console.error("✗ Failed to connect to source database:", error);
    process.exit(1);
  }

  try {
    await targetDb.unsafe("SELECT 1");
    console.log("✓ Connected to target database");
  } catch (error) {
    console.error("✗ Failed to connect to target database:", error);
    process.exit(1);
  }

  console.log("\nSyncing tables...\n");

  const stats: SyncStats[] = [];

  for (const table of tablesToSync) {
    try {
      const result = await syncTable(sourceDb, targetDb, table, dryRun);
      stats.push(result);
    } catch (error) {
      console.error(`\n✗ Failed to sync ${table}:`, error);
      process.exit(1);
    }
  }

  console.log("\n=== Summary ===\n");

  let totalRows = 0;
  let totalDuration = 0;

  for (const stat of stats) {
    console.log(`  ${stat.table}: ${stat.rows.toLocaleString()} rows (${stat.duration}ms)`);
    totalRows += stat.rows;
    totalDuration += stat.duration;
  }

  console.log(`\n  Total: ${totalRows.toLocaleString()} rows in ${(totalDuration / 1000).toFixed(1)}s`);

  if (dryRun) {
    console.log("\n  (Dry run - no changes made)");
  } else {
    console.log("\n✓ Sync complete!");
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
