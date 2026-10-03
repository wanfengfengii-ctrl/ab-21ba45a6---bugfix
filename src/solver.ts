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
 * The search is branch & bound over entry-order restricted-growth sequences
 * (pool-symmetry breaking). Lower bounds derived from the not-yet-placed
 * suffix — per-pool intake capacities, the cheapest risk each unplaced
 * amplicon must pay, and the mutual risk any newcomer set must realize —
 * make all four lexicographic tiers prunable, including the pool-number
 * sequence. The search is exact: the returned assignment is a proven
 * optimum, not a greedy approximation.
 *
 * If the node/time budget is ever exhausted, the verdict is "undetermined"
 * and is never reported as infeasible.
 */
import type {
  AllocateRequest,
  AllocateData,
  ConflictSummary,
  PoolResult,
} from './types.js';

export type AllocateResult =
  | { feasible: true; data: AllocateData }
  | { feasible: false; undetermined?: false; conflict: ConflictSummary }
  | { feasible: false; undetermined: true; conflict: ConflictSummary };

export interface AllocateOptions {
  /** Maximum number of search nodes before the verdict becomes undetermined. */
  nodeLimit?: number;
  /** Wall-clock budget for the search, in milliseconds. */
  timeLimitMs?: number;
}

const DEFAULT_NODE_LIMIT = 3_000_000;
const DEFAULT_TIME_LIMIT_MS = 8_000;

interface Objective {
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

export function allocate(req: AllocateRequest, options?: AllocateOptions): AllocateResult {
  const nodeLimit = options?.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const timeLimitMs = options?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
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

  // ---- exact branch & bound ----
  const outcome = search();
  if (outcome.limitReached) {
    // The budget ran out before the search space was exhausted: feasibility
    // is unknown. This must never surface as "no feasible assignment".
    return {
      feasible: false,
      undetermined: true,
      conflict: {
        reason: `search exceeded its budget (${nodeLimit} nodes / ${timeLimitMs}ms) before a verdict was proven; the request may still be satisfiable`,
        searchLimitReached: true,
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
    return { feasible: false, conflict };
  }

  // ----------------------------------------------------------------------

  function search(): { assignment: Int8Array | null; limitReached: boolean } {
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
    let poolsOpened = 0;

    // riskToPool[j*k + q]: risk that the still-unplaced amplicon j would add
    // if it joined pool q right now (its risk sum against the amplicons
    // currently in q). Maintained incrementally as the search (un)places.
    const riskToPool = new Float64Array(n * k);

    // Scratch buffers for the per-node lower-bound computation.
    const sortBuf = new Float64Array(n);
    const prefixP = new Float64Array(k * (n + 1)); // prefixP[q*(n+1)+t]
    const minMutual = new Float64Array(n);         // per newcomer-count bound
    const gPool = new Float64Array(k * (n + 1));   // gPool[q*(n+1)+t]
    const candV = new Float64Array(k * (n + 1));
    const deltaBuf = new Float64Array(k * n);
    const loArr = new Int32Array(k);
    const capArr = new Int32Array(k);

    // Controls among amplicons i..n-1 (suffix counts).
    const controlsSuffix = new Int16Array(n + 1);
    for (let i = n - 1; i >= 0; i--)
      controlsSuffix[i] = controlsSuffix[i + 1]! + (isControl[i] ? 1 : 0);

    let best: { obj: Objective; assn: Int8Array } | null = null;
    let nodes = 0;
    let limitReached = false;
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

    // Insertion sort on sortBuf[0..len): tiny lengths, no allocations.
    const sortAsc = (len: number) => {
      for (let a = 1; a < len; a++) {
        const v = sortBuf[a]!;
        let b = a - 1;
        while (b >= 0 && sortBuf[b]! > v) {
          sortBuf[b + 1] = sortBuf[b]!;
          b--;
        }
        sortBuf[b + 1] = v;
      }
    };

    // i = index of the next amplicon to place (0..n).
    // remLoad: load of amplicons i..n-1 still to distribute.
    const dfs = (i: number, remLoad: number): boolean => {
      if (++nodes > nodeLimit || ((nodes & 1023) === 0 && Date.now() > deadline)) {
        limitReached = true;
        return true;
      }

      if (i === n) {
        if (poolsOpened !== k) return false; // every pool must be nonempty
        const obj = currentObjectiveAtLeaf();
        if (obj && (!best || lexCompareFull(obj, assn, best) < 0)) {
          best = { obj, assn: Int8Array.from(assn) };
        }
        return false;
      }

      const r = n - i; // amplicons still to place

      // ---- global feasibility checks for the current prefix ----
      // Enough amplicons must remain to open every still-unopened pool.
      const unopened = k - poolsOpened;
      if (r < unopened) return false;

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

      // ---- count-level feasibility over the remaining amplicons ----
      // loArr[q]: amplicons pool q still needs to reach loadRange.min.
      // capArr[q]: amplicons pool q can still take under loadRange.max.
      let minRem = Infinity;
      let maxRem = 0;
      for (let j = i; j < n; j++) {
        const lj = loads[j]!;
        if (lj < minRem) minRem = lj;
        if (lj > maxRem) maxRem = lj;
      }
      let loSum = 0;
      let capSum = 0;
      for (let q = 0; q < k; q++) {
        const deficitQ = minLoad - poolLoad[q]!;
        const lo = deficitQ > 0 ? Math.ceil(deficitQ / maxRem) : 0;
        let cap = Math.floor((maxLoad - poolLoad[q]!) / minRem);
        if (cap > r) cap = r;
        if (lo > cap) return false;
        loArr[q] = lo;
        capArr[q] = cap;
        loSum += lo;
        capSum += cap;
      }
      if (loSum > r || capSum < r) return false;

      // ---- objective bounds ----
      let curMaxLoad = -Infinity;
      for (let p = 0; p < poolsOpened; p++)
        if (poolLoad[p]! > curMaxLoad) curMaxLoad = poolLoad[p]!;
      const finalMaxLoadLB = Math.max(
        curMaxLoad === -Infinity ? 0 : curMaxLoad,
        unopened > 0 ? minLoad : 0,
        Math.ceil(totalLoad / k));
      const lbSpread = Math.max(0, finalMaxLoadLB - Math.floor(totalLoad / k));

      if (best) {
        // Lower bounds for tiers 1-2 derived from the unplaced suffix.
        //
        // If pool q receives exactly t more amplicons, its final risk sum is
        // at least
        //   g_q(t) = curRisk[q] + P_q(t) + M(t)
        // where P_q(t) is the sum of the t smallest riskToPool values of
        // unplaced amplicons (each newcomer pays at least its current
        // risk-to-pool, which only grows) and M(t) lower-bounds the mutual
        // risk any t newcomers must realize among themselves:
        //   M(t) = (t/2) * min_j (sum of the t-1 smallest risks from j to
        //          other unplaced amplicons).
        // Tier 2: min over intake vectors of the sum of g_q(t_q), relaxed to
        // base sums plus the cheapest per-pool increments.
        // Tier 1: the smallest V such that some intake vector keeps every
        // g_q(t_q) <= V (a min-max relaxation).

        // prefixP: sorted riskToPool values per pool, prefix-summed.
        for (let q = 0; q < k; q++) {
          let m = 0;
          for (let j = i; j < n; j++) sortBuf[m++] = riskToPool[j * k + q]!;
          sortAsc(m);
          const pp = q * (n + 1);
          prefixP[pp] = 0;
          for (let t = 1; t <= m; t++) prefixP[pp + t] = prefixP[pp + t - 1]! + sortBuf[t - 1]!;
        }

        // minMutual[u]: min over unplaced j of the sum of the u smallest
        // risks from j to other unplaced amplicons.
        minMutual[0] = 0;
        for (let u = 1; u < r; u++) minMutual[u] = Infinity;
        for (let j = i; j < n; j++) {
          let m = 0;
          for (let j2 = i; j2 < n; j2++) {
            if (j2 !== j) sortBuf[m++] = risk[j * n + j2]!;
          }
          sortAsc(m); // m = r-1
          let acc = 0;
          for (let u = 1; u <= m; u++) {
            acc += sortBuf[u - 1]!;
            if (acc < minMutual[u]!) minMutual[u] = acc;
          }
        }

        // g_q(t) tables, base sums and per-pool increments.
        let gCount = 0;
        let deltaCount = 0;
        let baseSum = 0;
        for (let q = 0; q < k; q++) {
          const pp = q * (n + 1);
          const cur = poolRisk[q]!;
          const lo = loArr[q]!;
          const cap = capArr[q]!;
          let prevG = 0;
          for (let t = lo; t <= cap; t++) {
            const g = cur + prefixP[pp + t]! + (t > 0 ? (t * minMutual[t - 1]!) / 2 : 0);
            gPool[pp + t] = g;
            candV[gCount++] = g;
            if (t === lo) baseSum += g;
            else deltaBuf[deltaCount++] = g - prevG;
            prevG = g;
          }
        }

        // Tier-2 bound: base sums plus the (r - loSum) cheapest increments.
        const need = r - loSum;
        sortAscBuf(deltaBuf, deltaCount);
        let lbTotal = baseSum;
        for (let d = 0; d < need; d++) lbTotal += deltaBuf[d]!;

        // Tier-1 bound: smallest candidate V admitting a count-feasible
        // intake vector that keeps every pool at or below V.
        sortAscBuf(candV, gCount);
        let loI = 0;
        let hiI = gCount - 1;
        while (loI < hiI) {
          const mid = (loI + hiI) >> 1;
          if (maxIntakeFeasible(candV[mid]!)) hiI = mid;
          else loI = mid + 1;
        }
        const lbMax = candV[loI]!;

        if (lexPrune(i, lbMax, lbTotal, lbSpread)) return false;
      }

      // ---- candidate labels: every opened pool, plus at most one new pool ----
      const li = loads[i]!;
      interface Cand { p: number; opened: boolean; add: number }
      const cands: Cand[] = [];
      for (let p = 0; p < poolsOpened; p++) {
        if (poolLoad[p]! + li > maxLoad) continue;
        let blocked = false;
        for (let j = 0; j < i; j++) {
          if (assn[j] === p && forb[i * n + j]) { blocked = true; break; }
        }
        if (!blocked) cands.push({ p, opened: true, add: riskToPool[i * k + p]! });
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

        assn[i] = p;
        poolLoad[p]! += li;
        if (isControl[i]) poolControls[p]!++;
        poolRisk[p]! += c.add;
        if (!c.opened) poolsOpened++;
        for (let j = i + 1; j < n; j++) riskToPool[j * k + p]! += risk[i * n + j]!;

        const abort = dfs(i + 1, remLoad - li);

        for (let j = i + 1; j < n; j++) riskToPool[j * k + p]! -= risk[i * n + j]!;
        if (!c.opened) poolsOpened--;
        poolRisk[p]! -= c.add;
        if (isControl[i]) poolControls[p]!--;
        poolLoad[p]! -= li;
        assn[i] = -1;

        if (abort) return true;
      }
      return false;

      // Largest per-pool intake such that every pool's g stays <= v, summed;
      // feasible iff that total can absorb all remaining amplicons.
      function maxIntakeFeasible(v: number): boolean {
        let totalMaxT = 0;
        for (let q = 0; q < k; q++) {
          const pp = q * (n + 1);
          const lo = loArr[q]!;
          const cap = capArr[q]!;
          if (gPool[pp + lo]! > v) return false;
          let a = lo;
          let b = cap;
          while (a < b) {
            const mid = (a + b + 1) >> 1;
            if (gPool[pp + mid]! <= v) a = mid;
            else b = mid - 1;
          }
          totalMaxT += a;
        }
        return totalMaxT >= r;
      }

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

    // Insertion sort on an arbitrary buffer (deltaBuf / candV).
    function sortAscBuf(buf: Float64Array, len: number) {
      for (let a = 1; a < len; a++) {
        const v = buf[a]!;
        let b = a - 1;
        while (b >= 0 && buf[b]! > v) {
          buf[b + 1] = buf[b]!;
          b--;
        }
        buf[b + 1] = v;
      }
    }

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

    dfs(0, totalLoad);
    return { assignment: limitReached || !best ? null : best.assn, limitReached };
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
   * best-fit by added risk then distance from the average pool load. Control
   * amplicons are steered to pools that still lack one, so the seed covers
   * every pool with a control whenever that is possible. It can still fail;
   * the exact search then starts without an incumbent.
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
      // A control goes to a control-less pool while any remains.
      let steerToControlLess = false;
      if (isControl[i]) {
        for (let p = 0; p < k; p++) {
          if (c[p] === 0) { steerToControlLess = true; break; }
        }
      }
      let pick = -1;
      let pickAdd = Infinity;
      let pickDist = Infinity;
      for (let p = 0; p < k; p++) {
        if (l[p]! + loads[i]! > maxLoad) continue;
        if (steerToControlLess && c[p]! > 0) continue;
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
