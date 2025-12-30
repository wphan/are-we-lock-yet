// Ingest API endpoint - called by Vercel Cron every 5 minutes
// Processes recent blocks and updates analytics tables

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection } from "@solana/web3.js";
import postgres from "postgres";

const MAX_WRITABLE_ACCOUNT_UNITS = 12_000_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const DEFAULT_CU_LIMIT = 200_000;
const SET_COMPUTE_UNIT_LIMIT = 0x02;

// Solana produces ~750 blocks per 5 minutes (2.5 blocks/sec × 300s)
//
// Vercel Pro Plan (current):
//   - 300s function timeout
//   - Cron every 5 minutes (*/5 * * * *)
//   - With ~50 blocks/sec RPC: ~12,500 blocks per run
//   - Only need ~750 blocks per 5-min window to keep up
//   - ✅ Plenty of capacity with margin for catch-up

const FUNCTION_TIMEOUT_MS = 290_000; // Exit 10s before 300s timeout for safety
const BLOCKS_PER_RUN = 15_000; // ~750 needed per 5 min, extra capacity for catch-up
const BATCH_SIZE = 50;

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

function parseComputeBudgetInstructions(tx: any): number {
  let cuLimit = DEFAULT_CU_LIMIT;
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());

  if ("addressTableLookups" in message && tx.meta?.loadedAddresses) {
    accountKeys.push(
      ...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58()),
      ...tx.meta.loadedAddresses.readonly.map((k: any) => k.toBase58())
    );
  }

  for (const ix of message.compiledInstructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = ix.data;
    if (data.length === 0) continue;
    if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length >= 5) {
      cuLimit =
        data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24);
    }
  }
  return cuLimit;
}

function getWritableAccounts(tx: any): string[] {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((k: any) => k.toBase58());
  const writableAccounts: string[] = [];
  const header = message.header;
  const numStaticWritable =
    header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const numUnsignedWritable =
    accountKeys.length -
    header.numRequiredSignatures -
    header.numReadonlyUnsignedAccounts;

  for (let i = 0; i < numStaticWritable; i++) {
    writableAccounts.push(accountKeys[i]!);
  }
  const unsignedStart = header.numRequiredSignatures;
  for (let i = 0; i < numUnsignedWritable; i++) {
    writableAccounts.push(accountKeys[unsignedStart + i]!);
  }
  if (tx.meta?.loadedAddresses) {
    writableAccounts.push(
      ...tx.meta.loadedAddresses.writable.map((k: any) => k.toBase58())
    );
  }
  return writableAccounts;
}

interface AccountBlockStats {
  address: string;
  totalCUs: number;
  txCount: number;
  percentOfLimit: number;
}

interface BlockData {
  slot: number;
  blockTime: number | null;
  totalCUs: number;
  accountStats: AccountBlockStats[];
}

async function fetchAndParseBlock(
  connection: Connection,
  slot: number
): Promise<BlockData | null> {
  try {
    const block = await connection.getBlock(slot, {
      maxSupportedTransactionVersion: 0,
      transactionDetails: "full",
      rewards: false,
    });

    if (!block) return null;

    const accountMap = new Map<string, { totalCUs: number; txCount: number }>();
    let totalCUs = 0;

    for (const tx of block.transactions) {
      if (!tx.meta) continue;
      const cuLimit = parseComputeBudgetInstructions(tx);
      const writableAccounts = getWritableAccounts(tx);
      totalCUs += tx.meta.computeUnitsConsumed ?? 0;

      for (const account of writableAccounts) {
        const existing = accountMap.get(account);
        if (existing) {
          existing.totalCUs += cuLimit;
          existing.txCount += 1;
        } else {
          accountMap.set(account, { totalCUs: cuLimit, txCount: 1 });
        }
      }
    }

    const accountStats: AccountBlockStats[] = [];
    for (const [address, stats] of accountMap) {
      accountStats.push({
        address,
        totalCUs: stats.totalCUs,
        txCount: stats.txCount,
        percentOfLimit: (stats.totalCUs / MAX_WRITABLE_ACCOUNT_UNITS) * 100,
      });
    }
    accountStats.sort((a, b) => b.totalCUs - a.totalCUs);

    return {
      slot,
      blockTime: block.blockTime ?? null,
      totalCUs,
      accountStats,
    };
  } catch {
    return null;
  }
}

async function upsertHourlyStats(
  db: ReturnType<typeof postgres>,
  blockData: BlockData
): Promise<void> {
  if (!blockData.blockTime) return;

  const bucketHour = new Date(blockData.blockTime * 1000);
  bucketHour.setMinutes(0, 0, 0);
  const bucketHourStr = bucketHour.toISOString();

  // Only process top 100 accounts
  const topAccounts = blockData.accountStats.slice(0, 100);

  for (const account of topAccounts) {
    await db.unsafe(
      `INSERT INTO account_stats_hourly
        (account_address, bucket_hour, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
      VALUES ($1, $2, $3, 1, $4, $5, $5, $6)
      ON CONFLICT (account_address, bucket_hour) DO UPDATE SET
        total_cu = account_stats_hourly.total_cu + EXCLUDED.total_cu,
        block_count = account_stats_hourly.block_count + 1,
        tx_count = account_stats_hourly.tx_count + EXCLUDED.tx_count,
        max_percent_of_limit = GREATEST(account_stats_hourly.max_percent_of_limit, EXCLUDED.max_percent_of_limit),
        avg_percent_of_limit = (account_stats_hourly.avg_percent_of_limit * account_stats_hourly.block_count + EXCLUDED.avg_percent_of_limit)
                               / (account_stats_hourly.block_count + 1),
        total_block_cu = account_stats_hourly.total_block_cu + EXCLUDED.total_block_cu`,
      [
        account.address,
        bucketHourStr,
        account.totalCUs,
        account.txCount,
        account.percentOfLimit,
        blockData.totalCUs,
      ]
    );
  }
}

async function saveBlockSnapshot(db: ReturnType<typeof postgres>, blockData: BlockData): Promise<void> {
  if (!blockData.blockTime) return;

  const blockTime = new Date(blockData.blockTime * 1000).toISOString();
  const topAccounts = blockData.accountStats.slice(0, 20).map((a) => ({
    address: a.address,
    totalCUs: a.totalCUs,
    txCount: a.txCount,
    percentOfLimit: a.percentOfLimit,
  }));

  await db.unsafe(
    `INSERT INTO block_snapshots (slot, block_time, total_cu, top_accounts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slot) DO NOTHING`,
    [blockData.slot, blockTime, blockData.totalCUs, JSON.stringify(topAccounts)]
  );
}

async function getLastProcessedSlot(db: ReturnType<typeof postgres>): Promise<number | null> {
  const result = await db.unsafe(
    "SELECT last_processed_slot FROM ingest_state WHERE id = 1"
  );
  if (!Array.isArray(result) || result.length === 0) return null;
  return parseInt(result[0].last_processed_slot, 10);
}

async function updateLastProcessedSlot(db: ReturnType<typeof postgres>, slot: number): Promise<void> {
  await db.unsafe(
    `INSERT INTO ingest_state (id, last_processed_slot, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_processed_slot = EXCLUDED.last_processed_slot,
       updated_at = EXCLUDED.updated_at`,
    [slot]
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Disable cron in non-production environments (preview branches read from prod DB)
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return res.status(200).json({
      message: "Cron disabled in non-production environments",
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

  try {
    const db = getDb();

    // Require paid RPC for cron jobs - public RPC will be rate-limited
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
      return res.status(500).json({
        error: "SOLANA_RPC_URL environment variable is required for cron jobs",
      });
    }

    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    // Get current slot
    const currentSlot = await connection.getSlot();

    // Get last processed slot
    let lastProcessed = await getLastProcessedSlot(db);

    // If first run, start from current slot minus BLOCKS_PER_RUN
    if (lastProcessed === null) {
      lastProcessed = currentSlot - BLOCKS_PER_RUN;
    }

    // Calculate range to process
    const startSlot = lastProcessed + 1;
    const endSlot = Math.min(startSlot + BLOCKS_PER_RUN - 1, currentSlot - 10); // Leave 10 slot buffer

    if (startSlot > endSlot) {
      return res.status(200).json({
        message: "No new blocks to process",
        lastProcessed,
        currentSlot,
      });
    }

    let processed = 0;
    let errors = 0;
    let lastProcessedSlot = startSlot - 1;
    let exitedEarly = false;

    // Process in batches, checking timeout before each batch
    for (let slot = startSlot; slot <= endSlot; slot += BATCH_SIZE) {
      // Check if we're approaching timeout - exit early to save progress
      const elapsed = Date.now() - startTime;
      if (elapsed >= FUNCTION_TIMEOUT_MS) {
        exitedEarly = true;
        console.log(`Approaching timeout (${elapsed}ms), exiting early after ${processed} blocks`);
        break;
      }

      const batchEnd = Math.min(slot + BATCH_SIZE - 1, endSlot);
      const slots = Array.from(
        { length: batchEnd - slot + 1 },
        (_, i) => slot + i
      );

      const promises = slots.map(async (s) => {
        const blockData = await fetchAndParseBlock(connection, s);
        if (blockData) {
          await upsertHourlyStats(db, blockData);
          // Save snapshot for every 10th block to reduce storage
          if (s % 10 === 0) {
            await saveBlockSnapshot(db, blockData);
          }
          return true;
        }
        return false;
      });

      const results = await Promise.all(promises);
      processed += results.filter(Boolean).length;
      errors += results.filter((r) => !r).length;
      lastProcessedSlot = batchEnd;

      // Update checkpoint after each batch
      await updateLastProcessedSlot(db, batchEnd);
    }

    const duration = Date.now() - startTime;
    const blocksBehind = currentSlot - lastProcessedSlot;
    const blocksPerSecond = processed > 0 ? (processed / (duration / 1000)).toFixed(1) : "0";

    return res.status(200).json({
      success: true,
      processed,
      errors,
      startSlot,
      endSlot: lastProcessedSlot,
      currentSlot,
      blocksBehind,
      durationMs: duration,
      blocksPerSecond,
      exitedEarly,
      timeoutMs: FUNCTION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Ingest error:", message);
    return res.status(500).json({ error: message });
  }
}
