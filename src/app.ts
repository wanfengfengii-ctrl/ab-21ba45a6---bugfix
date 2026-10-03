/**
 * HTTP application: routing, JSON parsing and response mapping.
 * Kept dependency-free so it runs on a bare Node.js image.
 */
import type { AllocateData, ConflictSummary, Json } from './types.js';
import { validateRequest } from './validation.js';
import { allocate } from './solver.js';

const MAX_BODY_BYTES = 1_048_576;

export interface Response {
  status: number;
  body: Json;
}

export async function handleRequest(method: string, url: string, body: Buffer): Promise<Response> {
  if (method === 'GET' && (url === '/health' || url === '/healthz')) {
    return { status: 200, body: { status: 'ok' } };
  }

  if (url !== '/api/pools/allocate') {
    return {
      status: 404,
      body: { error: 'not_found', message: `unknown route: ${method} ${url}` },
    };
  }
  if (method !== 'POST') {
    return {
      status: 405,
      body: { error: 'method_not_allowed', message: 'use POST /api/pools/allocate' },
    };
  }

  let raw: unknown;
  if (body.length === 0) {
    return {
      status: 400,
      body: { error: 'validation_failed', fields: [{ field: '', message: 'request body is empty' }] },
    };
  }
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { error: 'validation_failed', fields: [{ field: '', message: 'body is not valid JSON' }] },
    };
  }

  const parsed = validateRequest(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: 'validation_failed', fields: parsed.errors as unknown as Json } };
  }

  const result = allocate(parsed.value);
  if (result.feasible) {
    const data: AllocateData = result.data;
    return {
      status: 200,
      body: {
        status: 'feasible',
        message: `allocated ${parsed.value.amplicons.length} amplicons across ${data.poolCount} pools`,
        allocation: data as unknown as Json,
      },
    };
  }

  const conflict: ConflictSummary = result.conflict;
  return {
    status: 422,
    body: {
      status: 'infeasible',
      message: 'no feasible pool assignment exists for this request',
      conflict: conflict as unknown as Json,
    },
  };
}

export function readBody(req: { on: Function }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.on('error', () => {});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
