// Backfill script - run locally to populate historical data
// Usage: bun run scripts/backfill.ts [--days=N] [--fill-gaps]
//
// Modes:
//   --days=N     Backfill N days from current slot (default)
//   --fill-gaps  Find and fill gaps in hourly data
//
// This script fetches historical blocks from mainnet and populates
// the analytics tables. It saves progress and can resume if interrupted.

import { Connection, type VersionedBlockResponse } from "@solana/web3.js";
import { getDb } from "../src/lib/db/index.ts";
import postgres from "postgres";

const MAX_DAYS = 7;
const BLOCKS_PER_DAY = 43_200; // ~2.5 blocks/sec
const BLOCKS_PER_HOUR = 9_000; // ~2.5 blocks/sec * 3600
const MAX_RETRIES = 3;

const BLOCKS_PER_BATCH = 100; // Smaller batches to avoid DB timeout
const DELAY_BETWEEN_BATCHES_MS = 0;
const CONCURRENT_REQUESTS = 50; // Parallel requests within batch

const MAX_WRITABLE_ACCOUNT_UNITS = 12_000_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const DEFAULT_CU_LIMIT = 200_000;
const SET_COMPUTE_UNIT_LIMIT = 0x02;
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

const STATE_FILE = "backfill-state.json";

// Track database operations for usage monitoring
let dbStats = {
  queries: 0,
  rowsWritten: 0,
  startTime: Date.now(),
};

function resetDbStats() {
  dbStats = { queries: 0, rowsWritten: 0, startTime: Date.now() };
}

function logDbStats(label: string) {
  const elapsed = ((Date.now() - dbStats.startTime) / 1000).toFixed(1);
  console.log(`\n[DB STATS] ${label}`);
  console.log(`  Queries: ${dbStats.queries.toLocaleString()}`);
  console.log(`  Rows written: ${dbStats.rowsWritten.toLocaleString()}`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  Queries/sec: ${(dbStats.queries / parseFloat(elapsed)).toFixed(1)}`);
}

interface BackfillState {
  startSlot: number;
  currentSlot: number;
  endSlot: number;
  processedBlocks: number;
  successfulBlocks: number;
  startedAt: string;
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

function parseArgs(): { days: number; fillGaps: boolean; useProd: boolean } {
  const args = process.argv.slice(2);
  let days = MAX_DAYS;
  let fillGaps = false;
  let useProd = false;

  for (const arg of args) {
    if (arg.startsWith("--days=")) {
      days = Math.min(parseInt(arg.slice(7), 10), MAX_DAYS);
    }
    if (arg === "--fill-gaps") {
      fillGaps = true;
    }
    if (arg === "--prod") {
      useProd = true;
    }
  }

  return { days, fillGaps, useProd };
}

// Process with a true concurrent pool (always keeps N requests in flight)
async function processWithPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  // Start N workers
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

async function getLatestSlot(): Promise<number> {
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  return connection.getSlot();
}

async function loadState(): Promise<BackfillState | null> {
  const file = Bun.file(STATE_FILE);
  if (await file.exists()) {
    return file.json();
  }
  return null;
}

async function saveState(state: BackfillState) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
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
      // Use >>> 0 to convert to unsigned 32-bit
      cuLimit =
        (data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24)) >>> 0;
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

function parseBlockForStats(
  block: VersionedBlockResponse,
  slot: number
): BlockData {
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

  return { slot, blockTime: block.blockTime ?? null, totalCUs, accountStats };
}

async function processBlock(
  connection: Connection,
  slot: number,
  retries = MAX_RETRIES
): Promise<BlockData | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "full",
        rewards: false,
      });

      if (!block) return null;
      return parseBlockForStats(block, slot);
    } catch (error: any) {
      const isRateLimit = error?.message?.includes("429") ||
                          error?.message?.includes("Too Many Requests");

      if (isRateLimit && attempt < retries - 1) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        await Bun.sleep(delay);
        continue;
      }

      // Skip block on other errors or exhausted retries
      return null;
    }
  }
  return null;
}

// Batch pending writes for efficiency
let pendingWrites: Array<{
  address: string;
  bucketHour: string;
  totalCUs: number;
  txCount: number;
  percentOfLimit: number;
  blockCUs: number;
}> = [];

async function upsertHourlyStats(blockData: BlockData): Promise<void> {
  if (!blockData.blockTime) return;

  const bucketHour = new Date(blockData.blockTime * 1000);
  bucketHour.setMinutes(0, 0, 0);
  const bucketHourStr = bucketHour.toISOString();

  // Only track top 20 accounts per block (hot accounts)
  const topAccounts = blockData.accountStats.slice(0, 20);

  for (const account of topAccounts) {
    pendingWrites.push({
      address: account.address,
      bucketHour: bucketHourStr,
      totalCUs: account.totalCUs,
      txCount: account.txCount,
      percentOfLimit: account.percentOfLimit,
      blockCUs: blockData.totalCUs,
    });
  }
}

async function flushPendingWrites(): Promise<void> {
  if (pendingWrites.length === 0) return;

  const db = getDb();

  // Aggregate by (address, bucketHour) to avoid duplicate key conflicts
  const aggregated = new Map<string, {
    address: string;
    bucketHour: string;
    totalCUs: number;
    txCount: number;
    maxPercentOfLimit: number;
    sumPercentOfLimit: number;
    blockCount: number;
    blockCUs: number;
  }>();

  for (const w of pendingWrites) {
    const key = `${w.address}|${w.bucketHour}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.totalCUs += w.totalCUs;
      existing.txCount += w.txCount;
      existing.maxPercentOfLimit = Math.max(existing.maxPercentOfLimit, w.percentOfLimit);
      existing.sumPercentOfLimit += w.percentOfLimit;
      existing.blockCount += 1;
      existing.blockCUs += w.blockCUs;
    } else {
      aggregated.set(key, {
        address: w.address,
        bucketHour: w.bucketHour,
        totalCUs: w.totalCUs,
        txCount: w.txCount,
        maxPercentOfLimit: w.percentOfLimit,
        sumPercentOfLimit: w.percentOfLimit,
        blockCount: 1,
        blockCUs: w.blockCUs,
      });
    }
  }

  const rows = Array.from(aggregated.values());

  // Process in chunks to avoid query size limits
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    // Build batch insert with VALUES
    const values: any[] = [];
    const placeholders: string[] = [];

    chunk.forEach((w, idx) => {
      const offset = idx * 8;
      const avgPercent = w.sumPercentOfLimit / w.blockCount;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
      values.push(w.address, w.bucketHour, w.totalCUs, w.blockCount, w.txCount, w.maxPercentOfLimit, avgPercent, w.blockCUs);
    });

    await db.execute(
      `INSERT INTO account_stats_hourly
        (account_address, bucket_hour, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (account_address, bucket_hour) DO UPDATE SET
        total_cu = account_stats_hourly.total_cu + EXCLUDED.total_cu,
        block_count = account_stats_hourly.block_count + EXCLUDED.block_count,
        tx_count = account_stats_hourly.tx_count + EXCLUDED.tx_count,
        max_percent_of_limit = GREATEST(account_stats_hourly.max_percent_of_limit, EXCLUDED.max_percent_of_limit),
        avg_percent_of_limit = (account_stats_hourly.avg_percent_of_limit * account_stats_hourly.block_count + EXCLUDED.avg_percent_of_limit * EXCLUDED.block_count)
                               / (account_stats_hourly.block_count + EXCLUDED.block_count),
        total_block_cu = account_stats_hourly.total_block_cu + EXCLUDED.total_block_cu`,
      values
    );
    dbStats.queries++;
    dbStats.rowsWritten += chunk.length;
  }

  pendingWrites = [];
}

async function saveBlockSnapshot(blockData: BlockData): Promise<void> {
  if (!blockData.blockTime) return;

  const db = getDb();
  const blockTime = new Date(blockData.blockTime * 1000).toISOString();
  const topAccounts = blockData.accountStats.slice(0, 20).map((a) => ({
    address: a.address,
    totalCUs: a.totalCUs,
    txCount: a.txCount,
    percentOfLimit: a.percentOfLimit,
  }));

  await db.execute(
    `INSERT INTO block_snapshots (slot, block_time, total_cu, top_accounts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slot) DO NOTHING`,
    [blockData.slot, blockTime, blockData.totalCUs, JSON.stringify(topAccounts)]
  );
  dbStats.queries++;
  dbStats.rowsWritten++;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function estimateEta(state: BackfillState, blocksPerSecond: number): string {
  const remaining = state.currentSlot - state.endSlot;
  if (blocksPerSecond <= 0) return "calculating...";
  const secondsRemaining = remaining / blocksPerSecond;
  return formatDuration(secondsRemaining * 1000);
}

async function backfill() {
  const { days } = parseArgs();
  const maxBlocks = days * BLOCKS_PER_DAY;
  resetDbStats();

  console.log(`\nBackfill Configuration:`);
  console.log(`  Days: ${days}`);
  console.log(`  Max blocks: ${maxBlocks.toLocaleString()}`);
  console.log(`  Batch size: ${BLOCKS_PER_BATCH}`);
  console.log(`  Concurrent requests: ${CONCURRENT_REQUESTS}`);
  console.log(`  Delay between batches: ${DELAY_BETWEEN_BATCHES_MS}ms\n`);

  let state = await loadState();

  if (state) {
    console.log(
      `Resuming from slot ${state.currentSlot} (${state.successfulBlocks.toLocaleString()} blocks already processed)\n`
    );
  } else {
    const latestSlot = await getLatestSlot();
    state = {
      startSlot: latestSlot,
      currentSlot: latestSlot,
      endSlot: latestSlot - maxBlocks,
      processedBlocks: 0,
      successfulBlocks: 0,
      startedAt: new Date().toISOString(),
    };
    console.log(
      `Starting backfill: ${state.startSlot.toLocaleString()} → ${state.endSlot.toLocaleString()}\n`
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  const startTime = Date.now();
  let batchStartTime = Date.now();

  while (state.currentSlot > state.endSlot) {
    const batchEnd = Math.max(
      state.currentSlot - BLOCKS_PER_BATCH,
      state.endSlot
    );
    const slots: number[] = [];
    for (let slot = state.currentSlot; slot > batchEnd; slot--) {
      slots.push(slot);
    }

    const rpcStart = Date.now();

    // Process with concurrent pool (always keeps N requests in flight)
    const results = await processWithPool(
      slots,
      async (slot) => {
        const blockData = await processBlock(connection, slot);
        if (blockData) {
          await upsertHourlyStats(blockData);
          if (slot % 100 === 0) {
            await saveBlockSnapshot(blockData);
          }
          return true;
        }
        return false;
      },
      CONCURRENT_REQUESTS
    );
    const rpcEnd = Date.now();
    const pendingCount = pendingWrites.length;

    // Flush batched DB writes
    const dbStart = Date.now();
    await flushPendingWrites();
    const dbEnd = Date.now();

    console.log(`  [Timing] RPC: ${rpcEnd - rpcStart}ms | DB: ${dbEnd - dbStart}ms | Rows: ${pendingCount}`);

    const successCount = results.filter(Boolean).length;

    state.currentSlot = batchEnd;
    state.processedBlocks += slots.length;
    state.successfulBlocks += successCount;
    await saveState(state);

    const totalBlocks = state.startSlot - state.endSlot;
    const processedBlocks = state.startSlot - state.currentSlot;
    const progress = ((processedBlocks / totalBlocks) * 100).toFixed(1);

    const elapsed = Date.now() - startTime;
    const blocksPerSecond = state.successfulBlocks / (elapsed / 1000);
    const eta = estimateEta(state, blocksPerSecond);

    const batchDuration = Date.now() - batchStartTime;
    console.log(
      `Progress: ${progress}% | ` +
        `Slot: ${state.currentSlot.toLocaleString()} | ` +
        `Blocks: ${state.successfulBlocks.toLocaleString()} | ` +
        `Speed: ${blocksPerSecond.toFixed(1)}/s | ` +
        `DB: ${dbStats.queries}q/${dbStats.rowsWritten}r | ` +
        `ETA: ${eta}`
    );

    batchStartTime = Date.now();

    // Throttle to avoid rate limits
    if (state.currentSlot > state.endSlot) {
      await Bun.sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  const totalDuration = Date.now() - new Date(state.startedAt).getTime();
  console.log(`\nBackfill complete!`);
  console.log(`  Total blocks processed: ${state.successfulBlocks.toLocaleString()}`);
  console.log(`  Total duration: ${formatDuration(totalDuration)}`);
  logDbStats("Final");

  // Clean up state file
  await Bun.file(STATE_FILE).unlink().catch(() => {});
  console.log(`\nState file cleaned up. Run rollup.ts next to aggregate daily/weekly data.`);
}

// Get postgres.js connection for prod database
function getProdDb() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("POSTGRES_URL environment variable is required for --prod mode");
  }
  return postgres(connectionString, { ssl: "require" });
}

interface GapInfo {
  missingHour: Date;
  estimatedStartSlot: number;
  estimatedEndSlot: number;
}

async function findGaps(useProd: boolean): Promise<GapInfo[]> {
  console.log("Finding gaps in hourly data...");

  if (useProd) {
    const sql = getProdDb();

    // Get missing hours
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
      SELECT hours.hour as missing_hour
      FROM hours
      LEFT JOIN existing ON hours.hour = existing.bucket_hour
      WHERE existing.bucket_hour IS NULL
      ORDER BY hours.hour
    `;

    // Get a reference point: latest slot and its block_time
    const reference = await sql`
      SELECT slot, block_time FROM block_snapshots
      ORDER BY slot DESC LIMIT 1
    `;

    await sql.end();

    if (!reference[0]) {
      console.log("No reference block found in snapshots");
      return [];
    }

    const refSlot = parseInt(reference[0].slot, 10);
    const refTime = new Date(reference[0].block_time).getTime();

    // Estimate slots for each missing hour
    const gapInfos: GapInfo[] = [];
    for (const gap of gaps) {
      const missingHour = new Date(gap.missing_hour);
      const hourStart = missingHour.getTime();
      const hourEnd = hourStart + 3600 * 1000;

      // ~2.5 blocks per second, so ~400ms per slot
      const msPerSlot = 400;
      const startSlotOffset = Math.floor((refTime - hourEnd) / msPerSlot);
      const endSlotOffset = Math.floor((refTime - hourStart) / msPerSlot);

      gapInfos.push({
        missingHour,
        estimatedStartSlot: refSlot - endSlotOffset,
        estimatedEndSlot: refSlot - startSlotOffset,
      });
    }

    return gapInfos;
  } else {
    // Use local Bun db
    const db = getDb();
    const gaps = await db.query<{ missing_hour: string }>(`
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
    `);

    const reference = await db.query<{ slot: string; block_time: string }>(
      "SELECT slot, block_time FROM block_snapshots ORDER BY slot DESC LIMIT 1"
    );

    if (!reference[0]) {
      console.log("No reference block found in snapshots");
      return [];
    }

    const refSlot = parseInt(reference[0].slot, 10);
    const refTime = new Date(reference[0].block_time).getTime();

    const gapInfos: GapInfo[] = [];
    for (const gap of gaps) {
      const missingHour = new Date(gap.missing_hour);
      const hourStart = missingHour.getTime();
      const hourEnd = hourStart + 3600 * 1000;

      const msPerSlot = 400;
      const startSlotOffset = Math.floor((refTime - hourEnd) / msPerSlot);
      const endSlotOffset = Math.floor((refTime - hourStart) / msPerSlot);

      gapInfos.push({
        missingHour,
        estimatedStartSlot: refSlot - endSlotOffset,
        estimatedEndSlot: refSlot - startSlotOffset,
      });
    }

    return gapInfos;
  }
}

async function backfillSlotRange(
  startSlot: number,
  endSlot: number,
  connection: Connection,
  useProd: boolean
): Promise<{ processed: number; successful: number }> {
  let processed = 0;
  let successful = 0;

  const prodDb = useProd ? getProdDb() : null;

  for (let slot = startSlot; slot <= endSlot; slot += BLOCKS_PER_BATCH) {
    const batchEnd = Math.min(slot + BLOCKS_PER_BATCH - 1, endSlot);
    const slots: number[] = [];
    for (let s = slot; s <= batchEnd; s++) {
      slots.push(s);
    }

    const results = await processWithPool(
      slots,
      async (s) => {
        const blockData = await processBlock(connection, s);
        if (blockData) {
          await upsertHourlyStats(blockData);
          if (s % 100 === 0) {
            await saveBlockSnapshot(blockData);
          }
          return true;
        }
        return false;
      },
      CONCURRENT_REQUESTS
    );

    // Flush to appropriate database
    if (useProd && prodDb && pendingWrites.length > 0) {
      await flushPendingWritesToProd(prodDb);
    } else {
      await flushPendingWrites();
    }

    processed += slots.length;
    successful += results.filter(Boolean).length;

    const progress = (((slot - startSlot) / (endSlot - startSlot)) * 100).toFixed(1);
    console.log(`  Progress: ${progress}% | Slot: ${slot} | Blocks: ${successful} | DB: ${dbStats.queries} queries, ${dbStats.rowsWritten} rows`);
  }

  if (prodDb) {
    await prodDb.end();
  }

  return { processed, successful };
}

async function flushPendingWritesToProd(sql: ReturnType<typeof postgres>): Promise<void> {
  if (pendingWrites.length === 0) return;

  // Aggregate by (address, bucketHour)
  const aggregated = new Map<string, {
    address: string;
    bucketHour: string;
    totalCUs: number;
    txCount: number;
    maxPercentOfLimit: number;
    sumPercentOfLimit: number;
    blockCount: number;
    blockCUs: number;
  }>();

  for (const w of pendingWrites) {
    const key = `${w.address}|${w.bucketHour}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.totalCUs += w.totalCUs;
      existing.txCount += w.txCount;
      existing.maxPercentOfLimit = Math.max(existing.maxPercentOfLimit, w.percentOfLimit);
      existing.sumPercentOfLimit += w.percentOfLimit;
      existing.blockCount += 1;
      existing.blockCUs += w.blockCUs;
    } else {
      aggregated.set(key, {
        address: w.address,
        bucketHour: w.bucketHour,
        totalCUs: w.totalCUs,
        txCount: w.txCount,
        maxPercentOfLimit: w.percentOfLimit,
        sumPercentOfLimit: w.percentOfLimit,
        blockCount: 1,
        blockCUs: w.blockCUs,
      });
    }
  }

  const rows = Array.from(aggregated.values());

  // Process in chunks
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: any[] = [];
    const placeholders: string[] = [];

    chunk.forEach((w, idx) => {
      const offset = idx * 8;
      const avgPercent = w.sumPercentOfLimit / w.blockCount;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
      values.push(w.address, w.bucketHour, w.totalCUs, w.blockCount, w.txCount, w.maxPercentOfLimit, avgPercent, w.blockCUs);
    });

    await sql.unsafe(
      `INSERT INTO account_stats_hourly
        (account_address, bucket_hour, total_cu, block_count, tx_count, max_percent_of_limit, avg_percent_of_limit, total_block_cu)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (account_address, bucket_hour) DO UPDATE SET
        total_cu = account_stats_hourly.total_cu + EXCLUDED.total_cu,
        block_count = account_stats_hourly.block_count + EXCLUDED.block_count,
        tx_count = account_stats_hourly.tx_count + EXCLUDED.tx_count,
        max_percent_of_limit = GREATEST(account_stats_hourly.max_percent_of_limit, EXCLUDED.max_percent_of_limit),
        avg_percent_of_limit = (account_stats_hourly.avg_percent_of_limit * account_stats_hourly.block_count + EXCLUDED.avg_percent_of_limit * EXCLUDED.block_count)
                               / (account_stats_hourly.block_count + EXCLUDED.block_count),
        total_block_cu = account_stats_hourly.total_block_cu + EXCLUDED.total_block_cu`,
      values
    );
    dbStats.queries++;
    dbStats.rowsWritten += chunk.length;
  }

  pendingWrites = [];
}

async function fillGaps() {
  const { useProd } = parseArgs();
  resetDbStats();

  console.log(`\nFill Gaps Mode`);
  console.log(`  Database: ${useProd ? "PRODUCTION (POSTGRES_URL)" : "Local"}`);
  console.log(`  Concurrent requests: ${CONCURRENT_REQUESTS}\n`);

  const gaps = await findGaps(useProd);

  if (gaps.length === 0) {
    console.log("No gaps found! Database is complete.");
    return;
  }

  console.log(`Found ${gaps.length} missing hours:\n`);
  for (const gap of gaps) {
    console.log(`  ${gap.missingHour.toISOString()} → slots ${gap.estimatedStartSlot} to ${gap.estimatedEndSlot} (~${gap.estimatedEndSlot - gap.estimatedStartSlot} blocks)`);
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  console.log(`\nStarting backfill...\n`);

  let totalProcessed = 0;
  let totalSuccessful = 0;

  for (const gap of gaps) {
    console.log(`\nFilling gap: ${gap.missingHour.toISOString()}`);
    const { processed, successful } = await backfillSlotRange(
      gap.estimatedStartSlot,
      gap.estimatedEndSlot,
      connection,
      useProd
    );
    totalProcessed += processed;
    totalSuccessful += successful;
    console.log(`  Completed: ${successful}/${processed} blocks`);
  }

  console.log(`\n✅ Gap filling complete!`);
  console.log(`  Total blocks processed: ${totalProcessed}`);
  console.log(`  Total successful: ${totalSuccessful}`);
  logDbStats("Final");
  console.log(`\nRun rollup.ts to aggregate the data.`);
}

// Main entry point
const { fillGaps: shouldFillGaps } = parseArgs();

if (shouldFillGaps) {
  fillGaps().catch((err) => {
    console.error("\nGap filling failed:", err);
    process.exit(1);
  });
} else {
  backfill().catch((err) => {
    console.error("\nBackfill failed:", err);
    process.exit(1);
  });
}
