/**
 * Tests for validation and the exact allocator.
 *
 * Optimality is checked against an exhaustive brute-force reference over
 * random small instances (8 amplicons, 2-3 pools): every solver answer must
 * match the lexicographically best complete enumeration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/solver.js';
import { validateRequest } from '../src/validation.js';
import { handleRequest, mapAllocateResult } from '../src/app.js';
import type { AllocateRequest, AllocateData } from '../src/types.js';

const makeAmps = (
  specs: Array<[string, number, boolean?]>,
) => specs.map(([id, load, control = false]) => ({ id, load, control }));

function expectFeasible(req: AllocateRequest): AllocateData {
  const res = allocate(req);
  assert.equal(res.feasible, true,
    `expected feasible, got ${JSON.stringify(res)}`);
  return (res as { data: AllocateData }).data;
}

function assertHardConstraints(req: AllocateRequest, data: AllocateData) {
  const byId = new Map(req.amplicons.map(a => [a.id, a]));
  assert.equal(data.assignment.length, req.amplicons.length);
  for (const pool of data.pools) {
    assert.ok(pool.controls.length >= 1, `pool ${pool.pool} has no control`);
    assert.ok(pool.load >= req.loadRange.min, `pool ${pool.pool} below min load`);
    assert.ok(pool.load <= req.loadRange.max, `pool ${pool.pool} above max load`);
    for (const r of pool.risks) {
      assert.ok(r.risk < req.forbiddenThreshold,
        `forbidden pair ${r.a}-${r.b} co-located in pool ${pool.pool}`);
    }
  }
  for (const { id, pool } of data.assignment) {
    const p = data.pools.find(q => q.pool === pool)!;
    assert.ok(p.members.includes(id));
    void byId;
  }
}

// ---------------------------------------------------------------- brute force

interface RefObjective {
  maxRisk: number;
  totalRisk: number;
  spread: number;
  seq: number[];
}

function bruteForceBest(req: AllocateRequest): RefObjective | null {
  const n = req.amplicons.length;
  const k = req.poolCount;
  const loads = req.amplicons.map(a => a.load);
  const controls = req.amplicons.map(a => a.control);
  const risk = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const idx = new Map(req.amplicons.map((a, i) => [a.id, i]));
  for (const r of req.risks) {
    risk[idx.get(r.a)!]![idx.get(r.b)!] = r.risk;
    risk[idx.get(r.b)!]![idx.get(r.a)!] = r.risk;
  }

  let best: RefObjective | null = null;
  const assn = new Array<number>(n).fill(0);

  const lexBetter = (o: RefObjective, b: RefObjective) => {
    if (o.maxRisk !== b.maxRisk) return o.maxRisk < b.maxRisk;
    if (o.totalRisk !== b.totalRisk) return o.totalRisk < b.totalRisk;
    if (o.spread !== b.spread) return o.spread < b.spread;
    for (let i = 0; i < o.seq.length; i++) {
      if (o.seq[i] !== b.seq[i]) return o.seq[i]! < b.seq[i]!;
    }
    return false;
  };

  const enumerate = (pos: number) => {
    if (pos === n) {
      const l = new Array<number>(k).fill(0);
      const c = new Array<number>(k).fill(0);
      const r = new Array<number>(k).fill(0);
      for (let i = 0; i < n; i++) {
        const p = assn[i]!;
        l[p]! += loads[i]!;
        if (controls[i]) c[p]!++;
        for (let j = 0; j < i; j++) {
          if (assn[j] === p) {
            const rv = risk[i]![j]!;
            if (rv >= req.forbiddenThreshold) return; // hard violation
            r[p]! += rv;
          }
        }
      }
      for (let p = 0; p < k; p++) {
        if (c[p]! < 1 || l[p]! < req.loadRange.min || l[p]! > req.loadRange.max) return;
      }
      const obj: RefObjective = {
        maxRisk: Math.max(...r),
        totalRisk: r.reduce((s, v) => s + v, 0),
        spread: Math.max(...l) - Math.min(...l),
        seq: [...assn],
      };
      if (!best || lexBetter(obj, best)) best = obj;
      return;
    }
    for (let p = 0; p < k; p++) {
      assn[pos] = p;
      enumerate(pos + 1);
    }
  };
  enumerate(0);
  return best;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('solver matches brute-force optimum on random 8-amplicon instances', () => {
  const rand = mulberry32(20261002);
  let feasibleCases = 0;
  for (let trial = 0; trial < 120; trial++) {
    const k = 2 + Math.floor(rand() * 2); // 2 or 3 pools
    const n = 8;
    const amplicons = Array.from({ length: n }, (_, i) => ({
      id: `A${i}`,
      load: 1 + Math.floor(rand() * 6),
      control: false,
    }));
    // ensure enough controls
    const controlCount = k + Math.floor(rand() * (n - k));
    const perm = Array.from({ length: n }, (_, i) => i)
      .sort(() => rand() - 0.5)
      .slice(0, controlCount);
    for (const ci of perm) amplicons[ci]!.control = true;

    const risks = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.35) risks.push({ a: `A${i}`, b: `A${j}`, risk: 1 + Math.floor(rand() * 9) });
      }
    const req: AllocateRequest = {
      amplicons,
      poolCount: k,
      loadRange: { min: 6, max: 26 },
      risks,
      forbiddenThreshold: 8 + Math.floor(rand() * 4), // 8..11
    };

    const ref = bruteForceBest(req);
    const result = allocate(req);
    if (!ref) {
      assert.equal(result.feasible, false, `trial ${trial}: reference says infeasible`);
      continue;
    }
    feasibleCases++;
    assert.equal(result.feasible, true, `trial ${trial}: solver missed a feasible instance`);
    const data = (result as { data: AllocateData }).data;
    assertHardConstraints(req, data);
    assert.equal(data.maxPoolRisk, ref.maxRisk, `trial ${trial}: maxPoolRisk`);
    assert.equal(data.totalRisk, ref.totalRisk, `trial ${trial}: totalRisk`);
    assert.equal(data.loadRangeSpread, ref.spread, `trial ${trial}: spread`);
    assert.deepEqual(
      data.assignment.map(a => a.pool - 1),
      ref.seq,
      `trial ${trial}: entry-order pool sequence`,
    );
  }
  assert.ok(feasibleCases > 40, 'expected many feasible random cases');
});

// ------------------------------------------------------- non-greedy trap case

/**
 * The 18-amplicon dense-risk boundary panel: 4 controls + 14 non-controls,
 * all loads 1, 4 pools with load in [4,5], risk 1 on every non-control pair
 * (below the forbidden threshold, so nothing is hard-forbidden).
 */
function boundaryPanelRequest(): AllocateRequest {
  const amplicons = Array.from({ length: 18 }, (_, i) => ({
    id: `A${i}`,
    load: 1,
    control: i < 4,
  }));
  const risks = [];
  for (let i = 4; i < 18; i++)
    for (let j = i + 1; j < 18; j++)
      risks.push({ a: `A${i}`, b: `A${j}`, risk: 1 });
  return {
    amplicons,
    poolCount: 4,
    loadRange: { min: 4, max: 5 },
    risks,
    forbiddenThreshold: 2,
  };
}

test('18-amplicon dense-risk boundary panel is solved to its proven optimum', () => {
  // Feasible packing: one control per pool, non-controls split 4/4/3/3.
  // The search must prove this optimum, not give up at its budget.
  const req = boundaryPanelRequest();
  const data = expectFeasible(req);
  assertHardConstraints(req, data);
  assert.equal(data.maxPoolRisk, 6);
  assert.equal(data.totalRisk, 18);
  assert.equal(data.loadRangeSpread, 1);
  assert.deepEqual(
    data.assignment.map(a => a.pool),
    [1, 2, 3, 4, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4],
  );
  // Determinism: a repeated call returns the identical allocation.
  const again = expectFeasible(req);
  assert.deepEqual(again.assignment, data.assignment);
});

test('search budget exhaustion is undetermined, never a false infeasible', () => {
  const res = allocate(boundaryPanelRequest(), { nodeLimit: 5, timeLimitMs: 60_000 });
  if (res.feasible) assert.fail('expected an undetermined verdict, got feasible');
  assert.equal(res.undetermined, true);
  assert.equal(res.conflict.searchLimitReached, true);
});

test('an exhausted time budget is likewise undetermined', () => {
  const res = allocate(boundaryPanelRequest(), { nodeLimit: 1_000_000_000, timeLimitMs: 0 });
  if (res.feasible) assert.fail('expected an undetermined verdict, got feasible');
  assert.equal(res.undetermined, true);
});

test('undetermined verdicts map to 503, proven infeasible ones to 422', () => {
  const req = boundaryPanelRequest();
  const und = mapAllocateResult(
    { feasible: false, undetermined: true, conflict: { reason: 'x', searchLimitReached: true } },
    req,
  );
  assert.equal(und.status, 503);
  const undBody = und.body as { status: string };
  assert.equal(undBody.status, 'undetermined');
  assert.notEqual(undBody.status, 'infeasible');

  const inf = mapAllocateResult(
    { feasible: false, conflict: { reason: 'proven' } },
    req,
  );
  assert.equal(inf.status, 422);
  assert.equal((inf.body as { status: string }).status, 'infeasible');
});

test('non-greedy trap: emptiest-pool greedy would create a high-risk dimer', () => {
  // 8 amplicons, load 5 each -> each of the 2 pools must total exactly 20.
  // Controls: A0 and A4. Pair A0-A2 carries risk 100; threshold keeps it
  // allowed. Alternating "into the currently emptiest pool" placement
  // produces [1,2,1,2,1,2,1,2], co-locating A0 and A2 (risk 100).
  // The exact optimum separates them for maxPoolRisk 0.
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 5, true], ['A1', 5], ['A2', 5], ['A3', 5],
      ['A4', 5, true], ['A5', 5], ['A6', 5], ['A7', 5],
    ]),
    poolCount: 2,
    loadRange: { min: 8, max: 20 },
    risks: [{ a: 'A0', b: 'A2', risk: 100 }],
    forbiddenThreshold: 1000,
  };
  const data = expectFeasible(req);
  assertHardConstraints(req, data);
  assert.equal(data.maxPoolRisk, 0);
  assert.equal(data.totalRisk, 0);
  assert.equal(data.loadRangeSpread, 0);
  const p0 = data.assignment.find(a => a.id === 'A0')!.pool;
  const p2 = data.assignment.find(a => a.id === 'A2')!.pool;
  assert.notEqual(p0, p2);
  for (const pool of data.pools) assert.equal(pool.members.length, 4);
});

test('higher objective tiers: balances risk before load spread', () => {
  // Two kinds of optimum: force the solver to accept a wider load spread in
  // exchange for a lower maximum pool risk.
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 6, true], ['A1', 4], ['A2', 6, true], ['A3', 4],
      ['A4', 4], ['A5', 6], ['A6', 4], ['A7', 6],
    ]),
    poolCount: 2,
    loadRange: { min: 16, max: 24 },
    risks: [
      { a: 'A1', b: 'A3', risk: 9 },
      { a: 'A5', b: 'A7', risk: 9 },
    ],
    forbiddenThreshold: 100,
  };
  const ref = bruteForceBest(req)!;
  const data = expectFeasible(req);
  assert.equal(data.maxPoolRisk, ref.maxRisk);
  assert.equal(data.totalRisk, ref.totalRisk);
  assert.equal(data.loadRangeSpread, ref.spread);
});

// ------------------------------------------------------------- hard conflicts

test('a pair with risk exactly at threshold is forbidden from sharing', () => {
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 5, true], ['A1', 5, true], ['A2', 5], ['A3', 5],
      ['A4', 5], ['A5', 5], ['A6', 5], ['A7', 5],
    ]),
    poolCount: 2,
    loadRange: { min: 8, max: 22 },
    risks: [{ a: 'A0', b: 'A1', risk: 7 }],
    forbiddenThreshold: 7,
  };
  const data = expectFeasible(req);
  assertHardConstraints(req, data);
  assert.notEqual(
    data.assignment.find(a => a.id === 'A0')!.pool,
    data.assignment.find(a => a.id === 'A1')!.pool,
  );
});

test('pairwise-forbidden triple is infeasible with two pools', () => {
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 5, true], ['A1', 5, true], ['A2', 5, true], ['A3', 5],
      ['A4', 5], ['A5', 5], ['A6', 5], ['A7', 5],
    ]),
    poolCount: 2,
    loadRange: { min: 8, max: 22 },
    risks: [
      { a: 'A0', b: 'A1', risk: 9 },
      { a: 'A1', b: 'A2', risk: 9 },
      { a: 'A0', b: 'A2', risk: 9 },
    ],
    forbiddenThreshold: 9,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  if (!res.feasible) {
    const edges = res.conflict.unsatisfiableForbiddenPairs!;
    assert.equal(edges.length, 3);
  }
});

test('fewer controls than pools is infeasible', () => {
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 5, true], ['A1', 5], ['A2', 5], ['A3', 5],
      ['A4', 5], ['A5', 5], ['A6', 5], ['A7', 5],
    ]),
    poolCount: 3,
    loadRange: { min: 5, max: 30 },
    risks: [],
    forbiddenThreshold: 10,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  if (!res.feasible) assert.ok(res.conflict.controlDeficit);
});

test('total load below k*min is infeasible with a conflict summary', () => {
  const req: AllocateRequest = {
    amplicons: makeAmps([
      ['A0', 1, true], ['A1', 1], ['A2', 1], ['A3', 1],
      ['A4', 1, true], ['A5', 1], ['A6', 1], ['A7', 1],
    ]),
    poolCount: 2,
    loadRange: { min: 10, max: 20 },
    risks: [],
    forbiddenThreshold: 10,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
});

// --------------------------------------------------------------- validation

test('validation locates offending fields', () => {
  const bad = {
    amplicons: [
      { id: 'X1', load: 2, control: true },
      { id: 'X1', load: -3, control: 'yes' },
    ],
    poolCount: 5,
    loadRange: { min: 10, max: 4 },
    risks: [{ a: 'X1', b: 'GHOST', risk: 1 }],
    forbiddenThreshold: -1,
  };
  const res = validateRequest(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    const fields = res.errors.map(e => e.field);
    assert.ok(fields.includes('amplicons'));
    assert.ok(fields.some(f => f.startsWith('amplicons[1].id')));
    assert.ok(fields.includes('amplicons[1].load'));
    assert.ok(fields.includes('amplicons[1].control'));
    assert.ok(fields.includes('poolCount'));
    assert.ok(fields.includes('loadRange'));
    assert.ok(fields.includes('risks[0].b'));
    assert.ok(fields.includes('forbiddenThreshold'));
  }
});

test('rejects unlisted-pair risk assumption violations gracefully (bad JSON)', async () => {
  const res = await handleRequest('POST', '/api/pools/allocate', Buffer.from('{nope'));
  assert.equal(res.status, 400);
});

test('HTTP layer: 400 with field errors, 422 on infeasible, 200 on success', async () => {
  const badRes = await handleRequest(
    'POST', '/api/pools/allocate',
    Buffer.from(JSON.stringify({ amplicons: [], poolCount: 2 })),
  );
  assert.equal(badRes.status, 400);

  const infeasible = await handleRequest(
    'POST', '/api/pools/allocate',
    Buffer.from(JSON.stringify({
      amplicons: makeAmps([
        ['A0', 1, true], ['A1', 1], ['A2', 1], ['A3', 1],
        ['A4', 1, true], ['A5', 1], ['A6', 1], ['A7', 1],
      ]),
      poolCount: 2,
      loadRange: { min: 10, max: 20 },
      risks: [],
      forbiddenThreshold: 5,
    })),
  );
  assert.equal(infeasible.status, 422);
  const body = infeasible.body as { status: string; conflict: { reason: string } };
  assert.equal(body.status, 'infeasible');
  assert.ok(body.conflict.reason.length > 0);

  const ok = await handleRequest(
    'POST', '/api/pools/allocate',
    Buffer.from(JSON.stringify({
      amplicons: makeAmps([
        ['A0', 5, true], ['A1', 5, true], ['A2', 5], ['A3', 5],
        ['A4', 5], ['A5', 5], ['A6', 5], ['A7', 5],
      ]),
      poolCount: 2,
      loadRange: { min: 8, max: 22 },
      risks: [],
      forbiddenThreshold: 5,
    })),
  );
  assert.equal(ok.status, 200);
});
