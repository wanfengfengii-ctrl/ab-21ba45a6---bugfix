/**
 * Ad-hoc stress harness (not part of the test suite): checks larger instances
 * for performance, constraint validity and response determinism.
 * Run: npx tsx verify/stress.ts
 */
import { allocate } from '../src/solver.js';
import type { AllocateRequest, AllocateData } from '../src/types.js';

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

function check(req: AllocateRequest, data: AllocateData) {
  for (const pool of data.pools) {
    if (pool.controls.length < 1) throw new Error('pool without control');
    if (pool.load < req.loadRange.min || pool.load > req.loadRange.max)
      throw new Error(`pool load ${pool.load} out of range`);
    for (const r of pool.risks) if (r.risk >= req.forbiddenThreshold)
      throw new Error(`forbidden pair ${r.a}-${r.b} co-located`);
  }
}

const rand = mulberry32(42);
const buckets = new Map<string, { n: number; ms: number[]; feasible: number }>();
for (let trial = 0; trial < 300; trial++) {
  const n = 8 + Math.floor(rand() * 11); // 8..18
  const k = 2 + Math.floor(rand() * 3);  // 2..4
  const amps = Array.from({ length: n }, (_, i) => ({
    id: `A${i}`,
    load: 1 + Math.floor(rand() * 10),
    control: false,
  }));
  const cc = k + Math.floor(rand() * Math.min(4, n - k + 1));
  const ids = [...amps.keys()].sort(() => rand() - 0.5).slice(0, cc);
  for (const i of ids) amps[i]!.control = true;
  const risks = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (rand() < 0.3) risks.push({ a: `A${i}`, b: `A${j}`, risk: 1 + Math.floor(rand() * 20) });
  const req: AllocateRequest = {
    amplicons: amps,
    poolCount: k,
    loadRange: { min: 10 + Math.floor(rand() * 10), max: 60 + Math.floor(rand() * 40) },
    risks,
    forbiddenThreshold: 12 + Math.floor(rand() * 12),
  };
  const t0 = Date.now();
  const res = allocate(req);
  const ms = Date.now() - t0;
  const key = `${n}/${k}`;
  const b = buckets.get(key) ?? { n: 0, ms: [], feasible: 0 };
  b.n++;
  b.ms.push(ms);
  if (res.feasible) {
    b.feasible++;
    check(req, res.data);
    // determinism
    const again = allocate(req);
    if (JSON.stringify(again.feasible ? again.data.assignment : null) !==
        JSON.stringify(res.feasible ? res.data.assignment : null))
      throw new Error('non-deterministic result');
  }
  buckets.set(key, b);
}

let slowest = 0;
for (const [key, b] of [...buckets].sort()) {
  const avg = b.ms.reduce((s, v) => s + v, 0) / b.ms.length;
  slowest = Math.max(slowest, ...b.ms);
  console.log(`${key}: cases=${b.n} feasible=${b.feasible} avgMs=${avg.toFixed(1)} maxMs=${Math.max(...b.ms)}`);
}
console.log(`slowest=${slowest}ms`);
