import {
  MAX_BLOCK_UNITS,
  MAX_WRITABLE_ACCOUNT_UNITS,
  type AccountWriteStats,
  type BlockAnalysis,
  type ProgramStats,
  type TransactionMetrics,
} from './types.ts';

export function aggregateAccountStats(
  transactions: TransactionMetrics[]
): AccountWriteStats[] {
  const accountMap = new Map<
    string,
    { totalCUs: number; txCount: number; transactions: string[] }
  >();

  for (const tx of transactions) {
    for (const account of tx.writableAccounts) {
      const existing = accountMap.get(account);
      if (existing) {
        existing.totalCUs += tx.cuLimit;
        existing.txCount += 1;
        existing.transactions.push(tx.signature);
      } else {
        accountMap.set(account, {
          totalCUs: tx.cuLimit,
          txCount: 1,
          transactions: [tx.signature],
        });
      }
    }
  }

  const stats: AccountWriteStats[] = [];
  for (const [address, data] of accountMap) {
    stats.push({
      address,
      totalCUs: data.totalCUs,
      txCount: data.txCount,
      percentOfLimit: (data.totalCUs / MAX_WRITABLE_ACCOUNT_UNITS) * 100,
      transactions: data.transactions,
    });
  }

  // Sort by totalCUs descending
  stats.sort((a, b) => b.totalCUs - a.totalCUs);

  return stats;
}

export function aggregateProgramStats(
  transactions: TransactionMetrics[]
): ProgramStats[] {
  const programMap = new Map<string, number>();

  for (const tx of transactions) {
    for (const programId of tx.programs) {
      programMap.set(programId, (programMap.get(programId) ?? 0) + 1);
    }
  }

  const stats: ProgramStats[] = [];
  for (const [programId, txCount] of programMap) {
    stats.push({ programId, txCount });
  }

  // Sort by txCount descending
  stats.sort((a, b) => b.txCount - a.txCount);

  return stats;
}

export function analyzeBlock(
  slot: number,
  blockhash: string,
  parentSlot: number,
  blockTime: number | null,
  leader: string | null,
  transactions: TransactionMetrics[]
): BlockAnalysis {
  const accountStats = aggregateAccountStats(transactions);
  const programStats = aggregateProgramStats(transactions);

  const totalCUs = transactions.reduce((sum, tx) => sum + tx.cuLimit, 0);
  const successfulTransactions = transactions.filter(
    (tx) => tx.status === 'success'
  ).length;
  const failedTransactions = transactions.filter(
    (tx) => tx.status === 'failed'
  ).length;
  const voteTransactions = transactions.filter((tx) => tx.isVote).length;

  const blockCapacity = (totalCUs / MAX_BLOCK_UNITS) * 100;

  return {
    slot,
    blockhash,
    parentSlot,
    blockTime,
    leader,
    totalCUs,
    totalTransactions: transactions.length,
    successfulTransactions,
    failedTransactions,
    voteTransactions,
    accountStats,
    programStats,
    transactions,
    blockCapacity,
  };
}
