# Block Transaction Ordering

This document explains how transactions are ordered within a Solana block.

## Overview

Transactions are ordered by **priority**, which is calculated as the fee reward per unit of estimated cost. Higher priority transactions are scheduled first, subject to account locking constraints and block capacity limits.

## Key Metrics

### Per-Transaction Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| **CU Price** | Micro-lamports per compute unit (set via `SetComputeUnitPrice` instruction) | Transaction instruction |
| **CU Limit** | Maximum compute units allowed (set via `SetComputeUnitLimit` instruction) | Transaction instruction (default: 200,000 per instruction) |
| **CU Used** | Actual compute units consumed during execution | Post-execution |
| **Prioritization Fee** | `(CU Price × CU Limit) / 1,000,000` lamports | Calculated |
| **Cost** | Estimated total cost used for scheduling (see below) | Calculated |
| **Priority** | `(Reward × 1,000,000) / (Cost + 1)` | Calculated |

### Cost Components

The **cost** is estimated *before* execution and includes:

```
cost = signature_cost
     + write_lock_cost
     + data_bytes_cost
     + programs_execution_cost    // This is the CU Limit, NOT CU Used
     + loaded_accounts_data_size_cost
```

| Component | Calculation |
|-----------|-------------|
| Signature Cost | 720 CUs per signature |
| Write Lock Cost | 300 CUs per writable account |
| Data Bytes Cost | 1 CU per 32 bytes of instruction data |
| Programs Execution Cost | The requested `compute_unit_limit` |
| Loaded Accounts Data Size Cost | Based on account data size limits |

### Reward (Fee to Validator)

```
reward = base_fee + prioritization_fee
```

- **Base fee**: `lamports_per_signature` (currently 5,000 lamports)
- **Prioritization fee**: `ceil((CU Price × CU Limit) / 1,000,000)` lamports

## Priority Calculation

```
priority = (reward × 1,000,000) / (cost + 1)
```

This means:
- Higher fee → higher priority
- Lower cost → higher priority
- Setting a tight `CU Limit` (close to actual usage) improves priority

## Ordering Rules

### 1. Priority Queue

Transactions are placed in a priority queue ordered by:
1. **Priority** (descending) - higher priority first
2. **Transaction ID** (ascending) - FIFO for equal priority

### 2. Account Conflict Resolution

Transactions that access the same accounts cannot execute in parallel:

| Conflict Type | Can Execute Together? |
|---------------|----------------------|
| Write vs Write | No |
| Write vs Read | No |
| Read vs Read | Yes |

When conflicts exist:
- Transactions are serialized (executed one after another)
- Higher priority transaction executes first
- Lower priority transaction waits for locks to be released

### 3. Thread Affinity

- Conflicting transactions are routed to the same worker thread
- This ensures sequential execution order is maintained
- Non-conflicting transactions run in parallel on different threads

## Block Limits

| Limit | Value | Description |
|-------|-------|-------------|
| **MAX_BLOCK_UNITS** | 48,000,000 CUs | Total compute units per block |
| **MAX_WRITABLE_ACCOUNT_UNITS** | 12,000,000 CUs | Max CUs writing to a single account per block |
| **MAX_VOTE_UNITS** | 36,000,000 CUs | Reserved capacity for vote transactions |

A transaction is rejected if:
- Adding it would exceed `MAX_BLOCK_UNITS`
- Adding it would exceed `MAX_WRITABLE_ACCOUNT_UNITS` for any account it writes
- Its individual cost exceeds `MAX_WRITABLE_ACCOUNT_UNITS`

## Visualization Ideas

### Transaction List View

For each transaction, display:
- Priority (for sorting)
- CU Price (micro-lamports)
- CU Limit (requested)
- CU Used (actual)
- Cost (estimated)
- Prioritization Fee (lamports)
- Writable accounts

### Account Hotspot View

For accounts with high write activity:
- Total CUs allocated to writes
- Percentage of `MAX_WRITABLE_ACCOUNT_UNITS` (12M) used
- Number of transactions writing to this account
- Transactions are serialized for this account

### Block Capacity View

Show utilization of:
- Total block CUs: `sum(tx.cost)` / 48,000,000
- Vote CUs: `sum(vote_tx.cost)` / 36,000,000
- Per-account CUs: highest utilized accounts approaching 12M limit

### Execution Timeline

Since conflicting transactions serialize:
- Group transactions by account conflicts
- Show parallel lanes for non-conflicting transaction groups
- Show serialized sequences for conflicting transactions

## Key Insights for Users

1. **CU Limit affects priority**: Setting `CU Limit` higher than needed *lowers* your priority
2. **CU Price vs CU Limit**: Both affect fee, but CU Limit also affects cost (and thus priority)
3. **Account contention**: Popular accounts (e.g., AMM pools) serialize transactions, creating bottlenecks
4. **12M account limit**: No more than 12M CUs can write to a single account per block

## Source Code References

| Component | File |
|-----------|------|
| Priority calculation | `core/src/banking_stage/transaction_scheduler/receive_and_buffer.rs` |
| Cost model | `cost-model/src/cost_model.rs` |
| Block limits | `cost-model/src/block_cost_limits.rs` |
| Cost tracker | `cost-model/src/cost_tracker.rs` |
| Account locking | `accounts-db/src/account_locks.rs` |
| Priority scheduling | `core/src/banking_stage/transaction_scheduler/prio_graph_scheduler.rs` |
| Compute budget | `compute-budget/src/compute_budget_limits.rs` |
