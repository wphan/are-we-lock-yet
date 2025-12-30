// Database migration script
// Run with: bun run scripts/migrate.ts

import { getDb } from "../src/lib/db/index.ts";

// Separate statements to ensure proper ordering
const TABLES = [
  `CREATE TABLE IF NOT EXISTS ingest_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_processed_slot BIGINT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS account_stats_hourly (
    account_address VARCHAR(44) NOT NULL,
    bucket_hour TIMESTAMP WITH TIME ZONE NOT NULL,
    total_cu BIGINT NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0,
    tx_count INTEGER NOT NULL DEFAULT 0,
    max_percent_of_limit REAL NOT NULL DEFAULT 0,
    avg_percent_of_limit REAL NOT NULL DEFAULT 0,
    total_block_cu BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_address, bucket_hour)
  )`,

  `CREATE TABLE IF NOT EXISTS account_stats_daily (
    account_address VARCHAR(44) NOT NULL,
    bucket_day DATE NOT NULL,
    total_cu BIGINT NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0,
    tx_count INTEGER NOT NULL DEFAULT 0,
    max_percent_of_limit REAL NOT NULL DEFAULT 0,
    avg_percent_of_limit REAL NOT NULL DEFAULT 0,
    total_block_cu BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_address, bucket_day)
  )`,

  `CREATE TABLE IF NOT EXISTS account_stats_weekly (
    account_address VARCHAR(44) NOT NULL,
    bucket_week DATE NOT NULL,
    total_cu BIGINT NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0,
    tx_count INTEGER NOT NULL DEFAULT 0,
    max_percent_of_limit REAL NOT NULL DEFAULT 0,
    avg_percent_of_limit REAL NOT NULL DEFAULT 0,
    total_block_cu BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_address, bucket_week)
  )`,

  `CREATE TABLE IF NOT EXISTS block_snapshots (
    slot BIGINT PRIMARY KEY,
    block_time TIMESTAMP WITH TIME ZONE,
    total_cu BIGINT NOT NULL,
    top_accounts JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_hourly_bucket ON account_stats_hourly(bucket_hour)`,
  `CREATE INDEX IF NOT EXISTS idx_hourly_cu ON account_stats_hourly(bucket_hour, total_cu DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_hourly_address ON account_stats_hourly(account_address)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_bucket ON account_stats_daily(bucket_day)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_cu ON account_stats_daily(bucket_day, total_cu DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_address ON account_stats_daily(account_address)`,
  `CREATE INDEX IF NOT EXISTS idx_weekly_bucket ON account_stats_weekly(bucket_week)`,
  `CREATE INDEX IF NOT EXISTS idx_weekly_address ON account_stats_weekly(account_address)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_time ON block_snapshots(block_time)`,
];

async function migrate() {
  console.log("Running migrations...\n");

  const db = getDb();

  // Create tables first
  console.log("Creating tables...");
  for (const statement of TABLES) {
    try {
      await db.execute(statement);
      const tableName = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
      console.log(`  ✓ ${tableName}`);
    } catch (error) {
      const tableName = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
      console.error(`  ✗ ${tableName}`);
      throw error;
    }
  }

  // Then create indexes
  console.log("\nCreating indexes...");
  for (const statement of INDEXES) {
    try {
      await db.execute(statement);
      const indexName = statement.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1];
      console.log(`  ✓ ${indexName}`);
    } catch (error) {
      const indexName = statement.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1];
      console.error(`  ✗ ${indexName}`);
      throw error;
    }
  }

  console.log("\nMigration complete!");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
