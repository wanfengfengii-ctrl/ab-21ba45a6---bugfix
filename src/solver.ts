/**
 * Exact pool allocator.
 *
 * Every amplicon is assigned to exactly one of k pools. Hard constraints:
 *   - each pool total load in [minLoad, maxLoad]
 *   - each pool contains at least one control amplicon
 *   - pairs with risk >= forbiddenThreshold never share a pool
 *     (unlisted pairs have risk 0, so a threshold of 0 forbids every pair)
 *
 * Objectives, lexicographically minimized:
 *   1. maximum per-pool risk sum
 *   2. sum of all pool risk sums
 *   3. spread between the busiest and the emptiest pool
 *   4. the pool-number sequence, flattened in amplicon entry order
 *
 * The search is branch & bound with MRV variable ordering, pool-symmetry
 * breaking and incremental bounds. It is exact: the returned assignment is a
 * proven optimum, not a greedy approximation.
 */
import type {
  AllocateRequest,
  AllocateData,
  ConflictSummary,
  PoolResult,
} from './types.js';

export type AllocateResult =
  | { feasible: true; data: AllocateData }
  | { feasible: false; proven: true; conflict: ConflictSummary }
  // The exact search hit its resource budget: infeasibility was NOT proven.
  // Callers must never treat this as a definitive "no feasible assignment".
  | { feasible: false; proven: false; conflict: ConflictSummary };

const SEARCH_NODE_LIMIT = 3_000_000;
const SEARCH_TIME_LIMIT_MS = 8_000;

/** Optional overrides for the exact-search resource budget (mainly tests). */
export interface AllocateOptions {
  nodeLimit?: number;
  timeLimitMs?: number;
}

interface Objective {
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

export function allocate(
  req: AllocateRequest,
  options: AllocateOptions = {},
): AllocateResult {
  const nodeLimit = options.nodeLimit ?? SEARCH_NODE_LIMIT;
  const timeLimitMs = options.timeLimitMs ?? SEARCH_TIME_LIMIT_MS;
  const n = req.amplicons.length;
  const k = req.poolCount;
  const ids = req.amplicons.map(a => a.id);
  const loads = req.amplicons.map(a => a.load);
  const isControl = req.amplicons.map(a => a.control);
  const minLoad = req.loadRange.min;
  const maxLoad = req.loadRange.max;
  const thr = req.forbiddenThreshold;

  // ---- risk / forbidden matrices (entry-order indices) ----
  const risk = new Float64Array(n * n);
  const idIndex = new Map<string, number>();
  ids.forEach((id, i) => idIndex.set(id, i));
  for (const r of req.risks) {
    const i = idIndex.get(r.a)!;
    const j = idIndex.get(r.b)!;
    risk[i * n + j] = r.risk;
    risk[j * n + i] = r.risk;
  }
  const forb = new Uint8Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (risk[i * n + j]! >= thr) {
        forb[i * n + j] = 1;
        forb[j * n + i] = 1;
      }
  // Unlisted pairs carry risk zero: with a zero threshold every pair is hard.
  if (thr === 0) forb.fill(1);

  const controlIds = req.amplicons.filter(a => a.control).map(a => a.id);

  // ---- cheap feasibility prechecks ----
  if (controlIds.length < k) {
    return infeasible({
      reason: `not enough control amplicons: ${controlIds.length} control(s) cannot cover ${k} pools (each pool needs at least one)`,
      controlDeficit: { pools: k, controlCount: controlIds.length, controlIds },
    });
  }

  const overloaded = req.amplicons.filter(a => a.load > maxLoad).map(a => a.id);
  if (overloaded.length > 0) {
    return infeasible({
      reason: `amplicon load exceeds loadRange.max=${maxLoad}, so it can never be placed`,
      overloadedAmplicons: overloaded,
    });
  }

  const totalLoad = loads.reduce((s, v) => s + v, 0);
  if (totalLoad < k * minLoad) {
    return infeasible({
      reason: `total amplicon load ${totalLoad} is below ${k}*loadRange.min=${k * minLoad}; every pool must reach the minimum`,
      totalLoadBelowMinimum: { totalLoad, required: k * minLoad },
    });
  }
  if (totalLoad > k * maxLoad) {
    return infeasible({
      reason: `total amplicon load ${totalLoad} exceeds ${k}*loadRange.max=${k * maxLoad}; the pools cannot hold that much load`,
      totalLoadAboveMaximum: { totalLoad, capacity: k * maxLoad },
    });
  }

  if (thr === 0) {
    return infeasible({
      reason: `forbiddenThreshold is 0: every pair (including unlisted zero-risk pairs) is forbidden from sharing a pool, but ${n} amplicons must fit into ${k} pools`,
      zeroThresholdForbidsAll: { amplicons: n, pools: k },
    });
  }

  // ---- forbidden graph must be k-colorable ----
  const colorFailure = forbiddenColorFailure(forb, risk, n, k, ids);
  if (colorFailure) {
    return infeasible({
      reason: colorFailure.reason,
      unsatisfiableForbiddenPairs: colorFailure.edges,
    });
  }

  // ---- global soft-risk graph statistics for combinatorial risk bounds ----
  // A "soft" edge is a positive-risk pair that is NOT forbidden: it is the only
  // kind of edge that can contribute to a pool risk sum. The exact search's
  // weakness was that its internal risk bounds counted only risks already
  // locked into opened pools, staying zero until very deep in the tree; on
  // dense soft graphs this left ~25 million equally-good leaves to enumerate.
  //
  // We bound the risk ANY completion must carry using a complete-graph
  // relaxation with a global missing-edge allowance. Let Ns be the number of
  // amplicons incident to at least one soft edge, Ws the number of soft edges,
  // and miss = C(Ns,2) - Ws pairs that are not soft (zero-risk or forbidden).
  // If a pool finally contains t soft amplicons, then among its C(t,2) pairs
  // at most `miss` pairs can be non-soft GLOBALLY, so it holds at least
  // max(0, C(t,2) - miss) soft edges. Across pools with final soft counts
  // t_0..t_{k-1} (summing to Ns), total internal soft edges are at least
  // Ws - (Ns^2 - sum t_p^2)/2 (at most that many pairs can cross pools).
  // Both expressions are minimized (convexly) when the t_p are as balanced as
  // possible. At a search node the already-placed soft members of each pool are
  // fixed, so balancing the remaining soft amplicons by water-filling gives a
  // sound per-node bound in O(k * remaining) time. Every soft edge weighs at
  // least minSoftRisk, scaling edge counts to risk-score bounds.
  const softVertex = new Uint8Array(n);
  let Ws = 0;
  let minSoftRisk = Infinity;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const w = risk[i * n + j]!;
      if (w > 0 && !forb[i * n + j]) {
        softVertex[i] = 1;
        softVertex[j] = 1;
        Ws++;
        if (w < minSoftRisk) minSoftRisk = w;
      }
    }
  const Ns = softVertex.reduce((s, v) => s + v, 0);
  const softPairs = (Ns * (Ns - 1)) / 2;
  const miss = softPairs - Ws;
  if (Ws === 0) minSoftRisk = 0;

  // Number of soft amplicons still unplaced at search depth i.
  const softSuffix = new Int16Array(n + 1);
  for (let i = n - 1; i >= 0; i--)
    softSuffix[i] = softSuffix[i + 1]! + softVertex[i]!;

  // ---- exact branch & bound ----
  const outcome = search();
  if (outcome.timeout) {
    // The exact search stopped on its resource budget: feasibility was NEITHER
    // proven NOR disproven. This must never be reported as "infeasible".
    return {
      feasible: false,
      proven: false,
      conflict: {
        reason: 'the exact search reached its node/time budget before feasibility could be proven or disproven; the request is not known to be infeasible',
        searchLimitReached: true,
        resourceLimits: {
          nodeLimit,
          timeLimitMs,
        },
      },
    };
  }
  if (!outcome.assignment) {
    return infeasible({
      reason: 'no assignment satisfies the load interval and one-control-per-pool constraints simultaneously',
    });
  }
  return { feasible: true, data: buildData(outcome.assignment) };

  function infeasible(conflict: ConflictSummary): AllocateResult {
    return { feasible: false, proven: true, conflict };
  }

  // ----------------------------------------------------------------------

  function search(): { assignment: Int8Array | null; timeout: boolean } {
    // Fixed entry-order assignment with restricted growth labels:
    // amplicon i is assigned before i+1, and a new pool may only receive the
    // next index (0, 1, ..., k-1). Every partition is therefore represented
    // exactly once and labels are already canonical w.r.t. first appearance in
    // entry order — which is precisely what objective 4 compares. All four
    // lexicographic tiers can then be pruned soundly, including the sequence.
    const assn = new Int8Array(n).fill(-1);
    const poolLoad = new Int32Array(k);
    const poolControls = new Int16Array(k);
    const poolRisk = new Float64Array(k);
    // Soft (positive-risk, non-forbidden) amplicons already in each pool.
    const poolSoft = new Int16Array(k);
    let poolsOpened = 0;

    const totalRisk = (() => {
      let t = 0;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) t += risk[i * n + j]!;
      return t;
    })();

    // Controls among amplicons i..n-1 (suffix counts).
    const controlsSuffix = new Int16Array(n + 1);
    for (let i = n - 1; i >= 0; i--)
      controlsSuffix[i] = controlsSuffix[i + 1]! + (isControl[i] ? 1 : 0);

    let best: { obj: Objective; assn: Int8Array } | null = null;
    let nodes = 0;
    let timedOut = false;
    const deadline = Date.now() + timeLimitMs;

    const canonicalLabels = (src: Int8Array): Int8Array => {
      const map = new Int8Array(k).fill(-1);
      let next = 0;
      const out = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const p = src[i]!;
        if (map[p] === -1) map[p] = next++;
        out[i] = map[p]!;
      }
      return out;
    };

    // Greedy seed incumbent (accepted only if it fully satisfies constraints).
    const seedRaw = greedySeed();
    if (seedRaw) {
      const seed = canonicalLabels(seedRaw);
      const obj = scoreAssignment(seed);
      if (obj) best = { obj, assn: seed };
    }

    const lexCompareFull = (o: Objective, cand: Int8Array, b: NonNullable<typeof best>): number => {
      if (o.maxRisk !== b.obj.maxRisk) return o.maxRisk < b.obj.maxRisk ? -1 : 1;
      if (o.totalRisk !== b.obj.totalRisk) return o.totalRisk < b.obj.totalRisk ? -1 : 1;
      if (o.spread !== b.obj.spread) return o.spread < b.obj.spread ? -1 : 1;
      for (let i = 0; i < n; i++) {
        if (cand[i] !== b.assn[i]) return cand[i]! < b.assn[i]! ? -1 : 1;
      }
      return 0;
    };

    // Combinatorial risk lower bounds from the global soft-graph relaxation.
    // Pool p already holds poolSoft[p] soft amplicons; balance the unplaced
    // soft amplicons across all k pools by water filling on those baselines.
    // The resulting counts t_p are majorized by every feasible completion, so
    // they simultaneously minimize max t_p and sum t_p^2, which is all the two
    // bounds below need.
    //
    // A pool ending with t soft amplicons contains C(t,2) soft-vertex pairs;
    // at most `miss` pairs in the whole graph are non-soft, so at least
    // max(0, C(t,2) - miss) of them are soft edges, each weighing at least
    // minSoftRisk. This counts already-placed edges at their minimum possible
    // weight, so the bound stands on its own; poolRisk[] (actual placed risk)
    // and sumRisk are folded in with max rather than added. Load/control
    // capacities and forbidden edges are ignored here, so the relaxed feasible
    // set contains every real completion: the bounds are sound.
    const riskBounds = (depth: number): { lb1: number; lb2: number } => {
      const t = new Int16Array(k);
      for (let p = 0; p < poolsOpened; p++) t[p] = poolSoft[p]!;
      let remaining = softSuffix[depth]!;
      while (remaining > 0) {
        let q = 0;
        for (let p = 1; p < k; p++) if (t[p]! < t[q]!) q = p;
        t[q]!++;
        remaining--;
      }
      let sumSq = 0;
      let forcedEdgesSomePool = 0;
      for (let p = 0; p < k; p++) {
        const tp = t[p]!;
        sumSq += tp * tp;
        const forced = Math.max(0, (tp * (tp - 1)) / 2 - miss);
        if (forced > forcedEdgesSomePool) forcedEdgesSomePool = forced;
      }
      let sumRiskNow = 0;
      let maxRiskNow = 0;
      for (let p = 0; p < poolsOpened; p++) {
        sumRiskNow += poolRisk[p]!;
        if (poolRisk[p]! > maxRiskNow) maxRiskNow = poolRisk[p]!;
      }
      const forcedEdgesTotal = Math.max(0, Ws - (Ns * Ns - sumSq) / 2);
      return {
        lb1: Math.max(maxRiskNow, forcedEdgesSomePool * minSoftRisk),
        lb2: Math.max(sumRiskNow, forcedEdgesTotal * minSoftRisk),
      };
    };

    // i = index of the next amplicon to place (0..n).
    // remLoad: load of amplicons i..n-1 still to distribute.
    // remRisk: risk of every edge with at least one endpoint in {i..n-1}.
    const dfs = (i: number, remLoad: number, remRisk: number): boolean => {
      if ((++nodes & 4095) === 0) {
        if (nodes > nodeLimit || Date.now() > deadline) {
          timedOut = true;
          return true;
        }
      }

      if (i === n) {
        if (poolsOpened !== k) return false; // every pool must be nonempty
        const obj = currentObjectiveAtLeaf();
        if (obj && (!best || lexCompareFull(obj, assn, best) < 0)) {
          best = { obj, assn: Int8Array.from(assn) };
        }
        return false;
      }

      // ---- global feasibility checks for the current prefix ----
      // Enough amplicons must remain to open every still-unopened pool.
      const ampliconsLeft = n - i;
      const unopened = k - poolsOpened;
      if (ampliconsLeft < unopened) return false;

      // Future controls must cover control-less opened pools and all unopened.
      let controlLessOpened = 0;
      for (let p = 0; p < poolsOpened; p++) if (poolControls[p] === 0) controlLessOpened++;
      if (controlsSuffix[i]! < controlLessOpened + unopened) return false;

      // Remaining load must be able to fill deficits and fit spare capacity.
      let deficit = 0;
      let spare = 0;
      for (let p = 0; p < poolsOpened; p++) {
        deficit += Math.max(0, minLoad - poolLoad[p]!);
        spare += maxLoad - poolLoad[p]!;
      }
      deficit += unopened * minLoad;
      spare += unopened * maxLoad;
      if (remLoad < deficit || remLoad > spare) return false;

      // ---- objective bounds ----
      let curMaxRisk = 0;
      let sumRisk = 0;
      for (let p = 0; p < poolsOpened; p++) {
        if (poolRisk[p]! > curMaxRisk) curMaxRisk = poolRisk[p]!;
        sumRisk += poolRisk[p]!;
      }

      // Pool-aware combinatorial lower bounds over the future amplicons.
      let lb1Risk = curMaxRisk;
      let lb2Risk = sumRisk;
      if (best && Ws > 0) {
        const rb = riskBounds(i);
        if (rb.lb1 > lb1Risk) lb1Risk = rb.lb1;
        if (rb.lb2 > lb2Risk) lb2Risk = rb.lb2;
      }

      let curMaxLoad = -Infinity;
      for (let p = 0; p < poolsOpened; p++)
        if (poolLoad[p]! > curMaxLoad) curMaxLoad = poolLoad[p]!;
      const finalMaxLoadLB = Math.max(
        curMaxLoad === -Infinity ? 0 : curMaxLoad,
        unopened > 0 ? minLoad : 0,
        Math.ceil(totalLoad / k));
      const lbSpread = Math.max(0, finalMaxLoadLB - Math.floor(totalLoad / k));

      if (best && lexPrune(i, lb1Risk, lb2Risk, lbSpread)) return false;

      // ---- candidate labels: every opened pool, plus at most one new pool ----
      const li = loads[i]!;
      const decidedRisk = (() => {
        let t = 0;
        for (let j = 0; j < i; j++) t += risk[i * n + j]!;
        return t;
      })();

      interface Cand { p: number; opened: boolean; add: number }
      const cands: Cand[] = [];
      for (let p = 0; p < poolsOpened; p++) {
        if (poolLoad[p]! + li > maxLoad) continue;
        let blocked = false;
        let add = 0;
        for (let j = 0; j < i; j++) {
          if (assn[j] === p) {
            if (forb[i * n + j]) { blocked = true; break; }
            if (risk[i * n + j]! > 0) add += risk[i * n + j]!;
          }
        }
        if (!blocked) cands.push({ p, opened: true, add });
      }
      if (poolsOpened < k) {
        // Opening the next label; amplicons after i must open the rest.
        if (n - i - 1 >= k - poolsOpened - 1) {
          cands.push({ p: poolsOpened, opened: false, add: 0 });
        }
      }
      if (cands.length === 0) return false;

      // Risk-added first finds good incumbents; new-pool option (add 0) comes
      // naturally early, which also matches RGS's low-label preference.
      cands.sort((x, y) => x.add - y.add || x.p - y.p);

      for (const c of cands) {
        const p = c.p;
        const wasControlLess = c.opened && poolControls[p] === 0;

        assn[i] = p;
        poolLoad[p]! += li;
        if (isControl[i]) poolControls[p]!++;
        poolRisk[p]! += c.add;
        if (softVertex[i]) poolSoft[p]!++;
        if (!c.opened) poolsOpened++;

        const abort = dfs(i + 1, remLoad - li, remRisk - decidedRisk);

        if (!c.opened) poolsOpened--;
        if (softVertex[i]) poolSoft[p]!--;
        poolRisk[p]! -= c.add;
        if (isControl[i]) poolControls[p]!--;
        poolLoad[p]! -= li;
        assn[i] = -1;
        void wasControlLess;

        if (abort) return true;
      }
      return false;

      // Sound lexicographic pruning using the fixed prefix [0, i).
      function lexPrune(
        prefixLen: number,
        cur1: number,
        cur2: number,
        lb3: number,
      ): boolean {
        const b = best!;
        if (cur1 > b.obj.maxRisk) return true;
        if (cur1 < b.obj.maxRisk) return false; // strict tier-1 improvement open
        // tier 1 forced to tie
        if (cur2 > b.obj.totalRisk) return true;
        if (cur2 < b.obj.totalRisk) return false; // strict tier-2 improvement open
        // tiers 1-2 forced to tie
        if (lb3 > b.obj.spread) return true;
        if (lb3 < b.obj.spread) return false; // strict tier-3 improvement open
        // tiers 1-3 tie at best: the entry-order sequence decides.
        for (let idx = 0; idx < prefixLen; idx++) {
          const cur = assn[idx]!;
          const inc = b.assn[idx]!;
          if (cur > inc) return true; // already lexicographically behind
          if (cur < inc) return false; // ahead: win even on a full tie
        }
        return false; // prefix equal so far: future entries can still improve
      }
    };

    function currentObjectiveAtLeaf(): Objective | null {
      let hi = 0;
      let sum = 0;
      let maxL = -Infinity;
      let minL = Infinity;
      for (let p = 0; p < k; p++) {
        if (poolControls[p] === 0) return null;
        if (poolLoad[p]! < minLoad || poolLoad[p]! > maxLoad) return null;
        if (poolRisk[p]! > hi) hi = poolRisk[p]!;
        sum += poolRisk[p]!;
        if (poolLoad[p]! > maxL) maxL = poolLoad[p]!;
        if (poolLoad[p]! < minL) minL = poolLoad[p]!;
      }
      return { maxRisk: hi, totalRisk: sum, spread: maxL - minL };
    }

    dfs(0, totalLoad, totalRisk);
    return { assignment: timedOut || !best ? null : best.assn, timeout: timedOut };
  }

  function scoreAssignment(candidate: Int8Array): Objective | null {
    const l = new Int32Array(k);
    const c = new Int16Array(k);
    const r = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const p = candidate[i]!;
      if (p < 0 || p >= k) return null;
      l[p]! += loads[i]!;
      if (isControl[i]) c[p]!++;
      for (let j = 0; j < i; j++) {
        if (candidate[j] === p) {
          // Defense in depth: a seed incumbent may never violate a hard ban.
          if (forb[i * n + j]) return null;
          r[p]! += risk[i * n + j]!;
        }
      }
    }
    let hi = 0;
    let sum = 0;
    let maxL = -Infinity;
    let minL = Infinity;
    for (let p = 0; p < k; p++) {
      const lp = l[p]!;
      const cp = c[p]!;
      const rp = r[p]!;
      if (cp === 0 || lp < minLoad || lp > maxLoad) return null;
      if (rp > hi) hi = rp;
      sum += rp;
      if (lp > maxL) maxL = lp;
      if (lp < minL) minL = lp;
    }
    return { maxRisk: hi, totalRisk: sum, spread: maxL - minL };
  }

  /**
   * Deterministic greedy seed: most-forbidden amplicon first (then heaviest),
   * best-fit by added risk then distance from the average pool load. It can
   * fail; the exact search then starts without an incumbent.
   */
  function greedySeed(): Int8Array | null {
    const cand = new Int8Array(n).fill(-1);
    const l = new Int32Array(k);
    const c = new Int16Array(k);
    const orderA = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const da = forbiddenDegree(a);
      const db = forbiddenDegree(b);
      if (da !== db) return db - da;
      if (loads[b]! !== loads[a]!) return loads[b]! - loads[a]!;
      return a - b;
    });
    const used = new Uint8Array(n);
    for (const i of orderA) {
      let pick = -1;
      let pickAdd = Infinity;
      let pickDist = Infinity;
      for (let p = 0; p < k; p++) {
        if (l[p]! + loads[i]! > maxLoad) continue;
        let blocked = false;
        let add = 0;
        for (let j = 0; j < n; j++) {
          if (used[j] && cand[j] === p) {
            if (forb[i * n + j]) { blocked = true; break; }
            add += risk[i * n + j]!;
          }
        }
        if (blocked) continue;
        const dist = Math.abs(l[p]! + loads[i]! - totalLoad / k);
        if (add < pickAdd || (add === pickAdd && dist < pickDist) ||
          (add === pickAdd && dist === pickDist && p < pick)) {
          pick = p;
          pickAdd = add;
          pickDist = dist;
        }
      }
      if (pick < 0) return null;
      cand[i] = pick;
      l[pick]! += loads[i]!;
      if (isControl[i]) c[pick]!++;
      used[i] = 1;
    }
    return scoreAssignment(cand) ? cand : null;
  }

  function forbiddenDegree(i: number): number {
    let d = 0;
    for (let j = 0; j < n; j++) if (forb[i * n + j]) d++;
    return d;
  }

  function buildData(assn: Int8Array): AllocateData {
    const pools: PoolResult[] = [];
    let maxPoolRisk = 0;
    let totalRisk = 0;
    for (let p = 0; p < k; p++) {
      const memberIdx: number[] = [];
      const controls: string[] = [];
      let load = 0;
      for (let i = 0; i < n; i++) {
        if (assn[i] === p) {
          memberIdx.push(i);
          load += loads[i]!;
          if (isControl[i]) controls.push(ids[i]!);
        }
      }
      const risks: PoolResult['risks'] = [];
      let riskSum = 0;
      for (let x = 0; x < memberIdx.length; x++) {
        for (let y = x + 1; y < memberIdx.length; y++) {
          const i = memberIdx[x]!;
          const j = memberIdx[y]!;
          const rv = risk[i * n + j]!;
          if (rv > 0) {
            risks.push({ a: ids[i]!, b: ids[j]!, risk: rv, pool: p + 1 });
            riskSum += rv;
          }
        }
      }
      risks.sort((x, y) =>
        (idIndex.get(x.a)! - idIndex.get(y.a)!) ||
        (idIndex.get(x.b)! - idIndex.get(y.b)!));
      if (riskSum > maxPoolRisk) maxPoolRisk = riskSum;
      totalRisk += riskSum;
      pools.push({
        pool: p + 1,
        members: memberIdx.map(i => ids[i]!),
        load,
        controls,
        risks,
        riskSum,
      });
    }
    const poolLoads = pools.map(q => q.load);
    const spread = Math.max(...poolLoads) - Math.min(...poolLoads);
    return {
      poolCount: k,
      pools,
      maxPoolRisk,
      totalRisk,
      loadRangeSpread: spread,
      assignment: ids.map((id, i) => ({ id, pool: assn[i]! + 1 })),
    };
  }
}

/**
 * Check k-colorability of the forbidden graph per connected component using
 * MRV backtracking. For the first component that needs more than k colors,
 * return the forbidden edges of that component as a conflict witness.
 */
function forbiddenColorFailure(
  forb: Uint8Array,
  risk: Float64Array,
  n: number,
  k: number,
  ids: string[],
): { reason: string; edges: { a: string; b: string; risk: number }[] } | null {
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (let u = 0; u < n; u++) {
        if (forb[v * n + u] && !seen[u]) {
          seen[u] = 1;
          stack.push(u);
        }
      }
    }
    if (comp.length <= k) continue; // a component this small is trivially k-colorable

    const color = new Int8Array(n).fill(-1);
    const inComp = new Uint8Array(n);
    comp.forEach(v => { inComp[v] = 1; });
    const uncolored = new Set(comp);

    const colorable = (): boolean => {
      if (uncolored.size === 0) return true;
      let v = -1;
      let bestAvail = k + 1;
      for (const cand of uncolored) {
        const usedColor = new Uint8Array(k);
        for (let u = 0; u < n; u++) {
          const cu = color[u]!;
          if (inComp[u] && forb[cand * n + u]! && cu >= 0) usedColor[cu] = 1;
        }
        let avail = 0;
        for (let p = 0; p < k; p++) if (!usedColor[p]) avail++;
        if (avail < bestAvail) {
          bestAvail = avail;
          v = cand;
          if (avail === 0) return false;
        }
      }
      uncolored.delete(v);
      const usedColor = new Uint8Array(k);
      for (let u = 0; u < n; u++) {
        const cu = color[u]!;
        if (inComp[u] && forb[v * n + u]! && cu >= 0) usedColor[cu] = 1;
      }
      for (let p = 0; p < k; p++) {
        if (usedColor[p]) continue;
        color[v] = p;
        if (colorable()) return true;
      }
      color[v] = -1;
      uncolored.add(v);
      return false;
    };

    if (!colorable()) {
      const edges: { a: string; b: string; risk: number }[] = [];
      for (let x = 0; x < comp.length; x++) {
        for (let y = x + 1; y < comp.length; y++) {
          const i = comp[x]!;
          const j = comp[y]!;
          if (forb[i * n + j]) {
            edges.push({ a: ids[i]!, b: ids[j]!, risk: risk[i * n + j]! });
          }
        }
      }
      edges.sort((x, y) =>
        (ids.indexOf(x.a) - ids.indexOf(y.a)) ||
        (ids.indexOf(x.b) - ids.indexOf(y.b)));
      return {
        reason: `forbidden-pair graph cannot be colored with ${k} pool(s): a connected set of ${comp.length} amplicons linked by threshold-reaching pairs requires more than ${k} pools`,
        edges,
      };
    }
  }
  return null;
}
