import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import { BugSpotterClient } from '../src/client/bugspotter-client.js';
import { Logger } from '../src/instrumentation/logger.js';
import { TOOLS } from '../src/tools/index.js';
import { UpstreamError, type ToolContext, type ToolDefinition } from '../src/types.js';

interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
let received: RequestRecord[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let logDir: string;

const PROJECT = '11111111-1111-1111-1111-111111111111';

function tool(name: string): ToolDefinition {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

async function makeCtx(): Promise<ToolContext> {
  const config = {
    baseUrl,
    apiKey: 'bgs_test',
    defaultProject: PROJECT,
    logDir,
    timeoutMs: 2000,
    retryAttempts: 2,
  };
  return {
    client: new BugSpotterClient(config),
    logger: new Logger(logDir),
    config,
  };
}

beforeAll(async () => {
  server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.statusCode = nextResponse.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  if (logDir) await rm(logDir, { recursive: true, force: true });
});

beforeEach(async () => {
  received = [];
  nextResponse = { status: 200, body: { ok: true } };
  logDir = await mkdtemp(path.join(os.tmpdir(), 'bgs-mcp-'));
});

describe('end-to-end tool dispatch against mocked BugSpotter', () => {
  it('search_bugs hits the intelligence search endpoint with X-API-Key', async () => {
    nextResponse = { status: 200, body: { results: [{ id: '1' }, { id: '2' }] } };
    const ctx = await makeCtx();
    const result = await tool('search_bugs').handler(
      { query: 'login flow broken', mode: 'fast', limit: 5 },
      ctx
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('POST');
    expect(received[0]!.url).toBe(`/api/v1/intelligence/projects/${PROJECT}/search`);
    expect(received[0]!.headers['x-api-key']).toBe('bgs_test');
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(result.resultCount).toBe(2);
    expect(result.upstreamUrl).toBe(`POST /api/v1/intelligence/projects/${PROJECT}/search`);
  });

  it('list_bugs translates from_date/to_date to created_after/created_before', async () => {
    nextResponse = { status: 200, body: { data: [] } };
    const ctx = await makeCtx();
    await tool('list_bugs').handler(
      { from_date: '2026-01-01', to_date: '2026-02-01', status: 'in-progress' },
      ctx
    );
    expect(received[0]!.url).toContain('created_after=2026-01-01');
    expect(received[0]!.url).toContain('created_before=2026-02-01');
    expect(received[0]!.url).toContain('status=in-progress');
    expect(received[0]!.url).not.toContain('from_date');
  });

  it('list_bugs strips heavy fields and returns a thin projection', async () => {
    const fatBug = {
      id: 'bug-1',
      title: 'Login button does nothing',
      status: 'open',
      priority: 'high',
      created_at: '2026-05-05T10:00:00Z',
      project_id: PROJECT,
      // Heavy fields that should be dropped — these are what blow context budgets in prod.
      description: 'x'.repeat(10_000),
      metadata: { browser: { ua: 'y'.repeat(2000) } },
      console_errors: Array(50).fill({ msg: 'TypeError: undefined' }),
      network_logs: Array(40).fill({ url: 'https://api/...', status: 500 }),
      stack_trace: 'a'.repeat(8000),
      replay_url: 'https://replays/...',
    };
    nextResponse = { status: 200, body: { data: [fatBug, fatBug, fatBug] } };
    const ctx = await makeCtx();
    const result = await tool('list_bugs').handler({ limit: 3 }, ctx);
    const data = result.data as { data: Record<string, unknown>[] };
    expect(data.data).toHaveLength(3);
    for (const b of data.data) {
      expect(Object.keys(b).sort()).toEqual(
        ['created_at', 'id', 'priority', 'project_id', 'status', 'title']
      );
      expect(b).not.toHaveProperty('description');
      expect(b).not.toHaveProperty('metadata');
      expect(b).not.toHaveProperty('console_errors');
      expect(b).not.toHaveProperty('network_logs');
      expect(b).not.toHaveProperty('stack_trace');
    }
    // Sanity-check the size collapse: thin record < 200 bytes; fat record > 25KB.
    const projectedBytes = Buffer.byteLength(JSON.stringify(data.data[0]));
    expect(projectedBytes).toBeLessThan(200);
  });

  it('search_bugs strips heavy fields and synthesizes excerpt from description', async () => {
    const longDescription = 'Connection reset on POST /orders. ' + 'x'.repeat(2000);
    const fatHit = {
      id: 'bug-2',
      title: 'POST /orders flaky',
      status: 'open',
      priority: 'high',
      score: 0.92,
      project_id: PROJECT,
      description: longDescription,
      console_errors: Array(20).fill({ msg: 'noise' }),
      stack_trace: 'z'.repeat(5000),
    };
    nextResponse = { status: 200, body: { results: [fatHit] } };
    const ctx = await makeCtx();
    const result = await tool('search_bugs').handler({ query: 'orders flaky' }, ctx);
    const data = result.data as { results: Record<string, unknown>[] };
    expect(data.results).toHaveLength(1);
    const hit = data.results[0]!;
    expect(hit).not.toHaveProperty('description');
    expect(hit).not.toHaveProperty('console_errors');
    expect(hit).not.toHaveProperty('stack_trace');
    expect(hit.excerpt).toBeTypeOf('string');
    expect((hit.excerpt as string).length).toBeLessThanOrEqual(241);
    expect(hit.score).toBe(0.92);
    expect(hit.title).toBe('POST /orders flaky');
  });

  it('search_bugs synthesizes excerpt when upstream returns excerpt: null/empty/whitespace', async () => {
    const ctx = await makeCtx();
    for (const badExcerpt of [null, '', '   '] as const) {
      received = [];
      nextResponse = {
        status: 200,
        body: {
          results: [
            {
              id: 'bug-x',
              title: 't',
              status: 'open',
              priority: 'high',
              excerpt: badExcerpt,
              description: 'A real description that should become the excerpt.',
            },
          ],
        },
      };
      const result = await tool('search_bugs').handler({ query: 'x' }, ctx);
      const hit = (result.data as { results: Record<string, unknown>[] }).results[0]!;
      expect(hit.excerpt).toBe('A real description that should become the excerpt.');
    }
  });

  it('search_bugs drops null upstream excerpt when description is also unusable', async () => {
    nextResponse = {
      status: 200,
      body: {
        results: [
          { id: 'b', title: 't', status: 'open', priority: 'low', excerpt: null },
          { id: 'c', title: 't', status: 'open', priority: 'low', excerpt: '   ', description: '\n  \t' },
          { id: 'd', title: 't', status: 'open', priority: 'low', excerpt: '' },
        ],
      },
    };
    const ctx = await makeCtx();
    const result = await tool('search_bugs').handler({ query: 'x' }, ctx);
    const hits = (result.data as { results: Record<string, unknown>[] }).results;
    // No usable excerpt + no usable description = no excerpt key at all.
    // The bad upstream value must not leak through to the agent.
    for (const h of hits) {
      expect(h).not.toHaveProperty('excerpt');
    }
  });

  it('search_bugs normalizes id from upstream bug_id and drops the duplicate field', async () => {
    nextResponse = {
      status: 200,
      body: {
        results: [
          { bug_id: 'BUG-42', title: 't', status: 'open', priority: 'low' },
          { id: 'BUG-43', title: 't2', status: 'open', priority: 'low' },
        ],
      },
    };
    const ctx = await makeCtx();
    const result = await tool('search_bugs').handler({ query: 'x' }, ctx);
    const hits = (result.data as { results: Record<string, unknown>[] }).results;
    expect(hits[0]!.id).toBe('BUG-42');
    expect(hits[1]!.id).toBe('BUG-43');
    // bug_id is no longer kept as a separate field — agents pass result.id to get_bug.
    expect(hits[0]).not.toHaveProperty('bug_id');
    expect(hits[1]).not.toHaveProperty('bug_id');
  });

  it('search_bugs coerces numeric bug_id/id to a string so get_bug stays callable', async () => {
    nextResponse = {
      status: 200,
      body: {
        results: [
          { bug_id: 12345, title: 't', status: 'open', priority: 'low' },
          { id: 67890, title: 't', status: 'open', priority: 'low' },
          // Reject things that aren't string-or-finite-number.
          { bug_id: null, id: { nested: 'object' }, title: 'no usable id', status: 'open', priority: 'low' },
          { bug_id: Number.NaN, title: 'NaN id', status: 'open', priority: 'low' },
        ],
      },
    };
    const ctx = await makeCtx();
    const result = await tool('search_bugs').handler({ query: 'x' }, ctx);
    const hits = (result.data as { results: Record<string, unknown>[] }).results;
    expect(hits[0]!.id).toBe('12345');
    expect(hits[1]!.id).toBe('67890');
    expect(hits[2]).not.toHaveProperty('id');
    expect(hits[3]).not.toHaveProperty('id');
  });

  it('list_bugs preserves upstream pagination metadata through projection', async () => {
    nextResponse = {
      status: 200,
      body: {
        data: [
          {
            id: 'b1',
            title: 't',
            status: 'open',
            priority: 'low',
            created_at: '2026-05-01T00:00:00Z',
            project_id: PROJECT,
          },
        ],
        pagination: { page: 2, per_page: 10, total: 95, total_pages: 10 },
      },
    };
    const ctx = await makeCtx();
    const result = await tool('list_bugs').handler({ limit: 10 }, ctx);
    const data = result.data as { data: unknown[]; pagination: Record<string, number> };
    expect(data.pagination).toEqual({ page: 2, per_page: 10, total: 95, total_pages: 10 });
    expect(data.data).toHaveLength(1);
  });

  it('update_bug_status renames note to resolution_notes in the PATCH body', async () => {
    const ctx = await makeCtx();
    await tool('update_bug_status').handler(
      { bug_id: 'abc', status: 'resolved', note: 'shipped fix' },
      ctx
    );
    expect(received[0]!.method).toBe('PATCH');
    expect(received[0]!.url).toBe('/api/v1/reports/abc');
    expect(received[0]!.body).toEqual({ status: 'resolved', resolution_notes: 'shipped fix' });
  });

  it('find_similar uses default project and forwards threshold/limit as query params', async () => {
    nextResponse = { status: 200, body: { results: [] } };
    const ctx = await makeCtx();
    await tool('find_similar').handler({ bug_id: 'bug-1', threshold: 0.8, limit: 3 }, ctx);
    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.url).toBe(
      `/api/v1/intelligence/projects/${PROJECT}/bugs/bug-1/similar?threshold=0.8&limit=3`
    );
  });

  it('ask forwards context/temperature/max_tokens body fields', async () => {
    const ctx = await makeCtx();
    await tool('ask').handler(
      { question: 'why does login fail?', temperature: 0.3, max_tokens: 100 },
      ctx
    );
    expect(received[0]!.body).toMatchObject({
      question: 'why does login fail?',
      temperature: 0.3,
      max_tokens: 100,
    });
  });

  it('classifies a 404 as upstream_4xx without retrying', async () => {
    nextResponse = { status: 404, body: { message: 'not found' } };
    const ctx = await makeCtx();
    await expect(tool('get_bug').handler({ bug_id: 'missing' }, ctx)).rejects.toBeInstanceOf(
      UpstreamError
    );
    expect(received).toHaveLength(1);
  });

  it('retries on 5xx up to retryAttempts', async () => {
    nextResponse = { status: 503, body: { message: 'down' } };
    const ctx = await makeCtx();
    await expect(tool('get_bug').handler({ bug_id: 'x' }, ctx)).rejects.toMatchObject({
      errorClass: 'upstream_5xx',
    });
    expect(received).toHaveLength(2); // retryAttempts=2 in test config
  });
});

describe('logger writes JSONL', () => {
  it('appends one record per tool call to calls-YYYY-MM-DD.jsonl', async () => {
    const ctx = await makeCtx();
    await ctx.logger.write({
      timestamp: '2026-05-06T10:00:00.000Z',
      session_id: null,
      agent_hint: 'unit-test',
      tool: 'search_bugs',
      args: { query: 'x' },
      args_size_bytes: 10,
      result_status: 'ok',
      result_count: 3,
      result_size_bytes: 100,
      duration_ms: 50,
      error_class: null,
      error_message: null,
      upstream_url: 'POST /api/v1/intelligence/projects/x/search',
    });
    const file = path.join(logDir, 'calls-2026-05-06.jsonl');
    const contents = await fs.readFile(file, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tool).toBe('search_bugs');
    expect(parsed.result_status).toBe('ok');
  });
});
