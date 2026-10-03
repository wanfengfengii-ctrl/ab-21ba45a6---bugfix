/**
 * Domain types for the multiplex PCR pool allocator.
 */

/** One amplicon as submitted by the caller, in entry order. */
export interface AmpliconInput {
  id: string;
  /** Positive integer workload/load. */
  load: number;
  /** Whether this amplicon carries a positive control. */
  control: boolean;
}

/** Risk entry for an unordered amplicon pair. */
export interface RiskPairInput {
  a: string;
  b: string;
  /** Non-negative finite risk score. */
  risk: number;
}

/** Request body of POST /api/pools/allocate. */
export interface AllocateRequest {
  amplicons: AmpliconInput[];
  /** Number of parallel reaction pools, 2..4. */
  poolCount: number;
  /** Uniform inclusive load interval [min, max] every pool must satisfy. */
  loadRange: { min: number; max: number };
  risks: RiskPairInput[];
  /** Pairs whose risk is >= this value are hard-forbidden from sharing a pool. */
  forbiddenThreshold: number;
}

/** A risky pair that landed in the same pool, with the pool index. */
export interface RiskDetail {
  a: string;
  b: string;
  risk: number;
  pool: number;
}

export interface PoolResult {
  /** 1-based pool number. */
  pool: number;
  members: string[];
  load: number;
  controls: string[];
  risks: RiskDetail[];
  /** Sum of the risk scores of all co-listed risky pairs in this pool. */
  riskSum: number;
}

export interface AllocateData {
  poolCount: number;
  pools: PoolResult[];
  /** Highest per-pool risk sum across all pools. */
  maxPoolRisk: number;
  /** Sum of all pool risk sums. */
  totalRisk: number;
  /** Max pool load minus min pool load. */
  loadRangeSpread: number;
  /** Pool number per amplicon, in amplicon entry order. */
  assignment: { id: string; pool: number }[];
}

export interface ConflictSummary {
  reason: string;
  controlDeficit?: { pools: number; controlCount: number; controlIds: string[] };
  overloadedAmplicons?: string[];
  totalLoadBelowMinimum?: { totalLoad: number; required: number };
  totalLoadAboveMaximum?: { totalLoad: number; capacity: number };
  zeroThresholdForbidsAll?: { amplicons: number; pools: number };
  unsatisfiableForbiddenPairs?: { a: string; b: string; risk: number }[];
  searchLimitReached?: boolean;
}

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
