/**
 * One-shot verification service.
 *
 * Phases:
 *   1. unit tests   (bit 0 -> exit code 1 on failure)
 *   2. TypeScript build (bit 1 -> exit code 2 on failure)
 *   3. wait for application health (bit 2 -> exit code 4)
 *   4. live API checks, including a non-greedy trap (bit 3 -> exit code 8)
 *
 * Exit code is the bitmask of failed phases (0 == everything passed), so the
 * container reports the complete verification summary in a single code.
 */
import { spawnSync } from 'node:child_process';

const BASE_URL = process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000';
const HEALTH_TIMEOUT_MS = 30_000;

const log = (msg: string) => console.log(`[verify] ${msg}`);
const ok = (msg: string) => console.log(`[verify]   PASS  ${msg}`);
const bad = (msg: string) => console.error(`[verify]   FAIL  ${msg}`);

// --------------------------------------------------------------- phases 1-2

function runPhase(name: string, cmd: string, args: string[], bit: number): number {
  log(`phase: ${name} (${cmd} ${args.join(' ')})`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status === 0) {
    ok(name);
    return 0;
  }
  bad(`${name} failed with exit code ${res.status ?? 'unknown'}`);
  return bit;
}

// --------------------------------------------------------------- phase 3

async function waitForHealth(): Promise<number> {
  log(`phase: waiting for application health at ${BASE_URL}/health`);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const body = await res.json() as { status?: string };
        if (body.status === 'ok') {
          ok('application is healthy');
          return 0;
        }
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  bad(`application did not become healthy in time (${lastErr})`);
  return 4;
}

// --------------------------------------------------------------- phase 4

const trapRequest = {
  // Non-greedy trap: round-robin into the currently emptiest pool co-locates
  // the A0-A2 dimer carrying risk 100. The exact allocator must separate them.
  amplicons: [
    { id: 'A0', load: 5, control: true },
    { id: 'A1', load: 5, control: false },
    { id: 'A2', load: 5, control: false },
    { id: 'A3', load: 5, control: false },
    { id: 'A4', load: 5, control: true },
    { id: 'A5', load: 5, control: false },
    { id: 'A6', load: 5, control: false },
    { id: 'A7', load: 5, control: false },
  ],
  poolCount: 2,
  loadRange: { min: 8, max: 20 },
  risks: [{ a: 'A0', b: 'A2', risk: 100 }],
  forbiddenThreshold: 1000,
};

const infeasibleRequest = {
  // Three pairwise-forbidden amplicons cannot fit into two pools.
  amplicons: [
    { id: 'A0', load: 5, control: true },
    { id: 'A1', load: 5, control: true },
    { id: 'A2', load: 5, control: true },
    { id: 'A3', load: 5, control: false },
    { id: 'A4', load: 5, control: false },
    { id: 'A5', load: 5, control: false },
    { id: 'A6', load: 5, control: false },
    { id: 'A7', load: 5, control: false },
  ],
  poolCount: 2,
  loadRange: { min: 8, max: 22 },
  risks: [
    { a: 'A0', b: 'A1', risk: 9 },
    { a: 'A1', b: 'A2', risk: 9 },
    { a: 'A0', b: 'A2', risk: 9 },
  ],
  forbiddenThreshold: 9,
};

const invalidRequest = {
  amplicons: [{ id: 'A0', load: -1, control: true }],
  poolCount: 9,
  loadRange: { min: 20, max: 4 },
  risks: [],
  forbiddenThreshold: -3,
};

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE_URL}/api/pools/allocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as any;
  return { status: res.status, json };
}

async function apiChecks(): Promise<number> {
  log('phase: live API checks');
  let failures = 0;
  const check = (cond: boolean, name: string, detail?: string) => {
    if (cond) ok(name);
    else {
      bad(`${name}${detail ? ` — ${detail}` : ''}`);
      failures++;
    }
  };

  // ---- non-greedy trap ----
  const trap = await post(trapRequest);
  check(trap.status === 200, 'trap request returns 200', `got ${trap.status}: ${JSON.stringify(trap.json)}`);
  if (trap.status === 200) {
    const a = trap.json.allocation;
    check(a.pools.length === 2, 'response lists two pools');
    check(a.maxPoolRisk === 0, 'maximum per-pool risk is minimized to 0', `maxPoolRisk=${a.maxPoolRisk}`);
    check(a.totalRisk === 0, 'total risk is 0', `totalRisk=${a.totalRisk}`);
    const assn = new Map<string, number>(a.assignment.map((x: any) => [x.id, x.pool]));
    check(assn.get('A0') !== assn.get('A2'), 'A0/A2 high-risk dimer is split across pools');
    for (const pool of a.pools) {
      check(pool.controls.length >= 1, `pool ${pool.pool} has a positive control`);
      check(pool.load >= 8 && pool.load <= 20, `pool ${pool.pool} load ${pool.load} within [8,20]`);
      check(pool.members.length === pool.controls.length +
        trapRequest.amplicons.filter(x => !x.control && a.assignment.find((z: any) => z.id === x.id)?.pool === pool.pool).length,
        `pool ${pool.pool} member roster is internally consistent`);
    }
    check(a.assignment.length === 8, 'assignment covers all 8 amplicons in entry order');
    check(a.assignment.every((x: any, i: number) => x.id === trapRequest.amplicons[i]!.id),
      'assignment follows amplicon entry order');
    // Stability: repeat request yields an identical pool sequence.
    const again = await post(trapRequest);
    check(JSON.stringify(again.json.allocation.assignment) === JSON.stringify(a.assignment),
      'repeated request yields the identical (stable) assignment');
  }

  // ---- infeasible ----
  const inf = await post(infeasibleRequest);
  check(inf.status === 422, 'infeasible request returns 422', `got ${inf.status}`);
  check(inf.json.status === 'infeasible', 'infeasible body marked infeasible');
  check(typeof inf.json.conflict?.reason === 'string' && inf.json.conflict.reason.length > 0,
    'infeasible body explains the conflict');
  check(Array.isArray(inf.json.conflict?.unsatisfiableForbiddenPairs) &&
    inf.json.conflict.unsatisfiableForbiddenPairs.length === 3,
    'conflict summary lists the 3 pairwise-forbidden edges');

  // ---- invalid input ----
  const inv = await post(invalidRequest);
  check(inv.status === 400, 'invalid request returns 400', `got ${inv.status}`);
  check(inv.json.error === 'validation_failed', 'invalid body reports validation_failed');
  const fields = Array.isArray(inv.json.fields) ? inv.json.fields.map((f: any) => f.field) : [];
  for (const f of ['amplicons', 'poolCount', 'loadRange', 'forbiddenThreshold']) {
    check(fields.some((x: string) => x === f || x.startsWith(`${f}.`) || x.startsWith(`${f}[`)),
      `validation error locates field "${f}"`, `fields=${JSON.stringify(fields)}`);
  }

  return failures === 0 ? 0 : 8;
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  log(`one-shot verification starting (target: ${BASE_URL})`);
  let code = 0;
  code |= runPhase('unit tests', 'npm', ['test', '--silent'], 1);
  code |= runPhase('TypeScript build', 'npm', ['run', 'build'], 2);
  code |= await waitForHealth();
  if ((code & 4) === 0) code |= await apiChecks();

  console.log('');
  if (code === 0) {
    log('ALL CHECKS PASSED');
  } else {
    const parts: string[] = [];
    if (code & 1) parts.push('unit tests');
    if (code & 2) parts.push('build');
    if (code & 4) parts.push('health');
    if (code & 8) parts.push('API checks');
    bad(`verification failed: ${parts.join(', ')}`);
  }
  process.exit(code);
}

main().catch(err => {
  console.error('[verify] fatal', err);
  process.exit(15);
});
