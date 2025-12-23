// Block cost limits from Solana
export const MAX_BLOCK_UNITS = 48_000_000;
export const MAX_WRITABLE_ACCOUNT_UNITS = 12_000_000;
export const MAX_VOTE_UNITS = 36_000_000;

// Cost model constants
export const SIGNATURE_COST = 720;
export const WRITE_LOCK_COST = 300;
export const LAMPORTS_PER_SIGNATURE = 5000;

// Compute budget program
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';

export interface AccountWriteStats {
  address: string;
  totalCUs: number;
  txCount: number;
  percentOfLimit: number;
  transactions: string[];
}

export interface TransactionMetrics {
  index: number;
  signature: string;
  priority: number;
  cuPrice: number;
  cuLimit: number;
  cuUsed: number;
  cost: number;
  prioritizationFee: number;
  writableAccounts: string[];
  signers: string[];
  programs: string[];
  status: 'success' | 'failed';
  isVote: boolean;
}

export interface ProgramStats {
  programId: string;
  txCount: number;
}

export interface BlockAnalysis {
  slot: number;
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
  leader: string | null;
  totalCUs: number;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  voteTransactions: number;
  accountStats: AccountWriteStats[];
  programStats: ProgramStats[];
  transactions: TransactionMetrics[];
  blockCapacity: number;
}
