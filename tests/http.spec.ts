import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { Logger } from '../src/instrumentation/logger.js';
import { SessionStore, hashKey } from '../src/http/session-store.js';
import { buildApp } from '../src/server-http.js';

// ───── Mock upstream BugSpotter (mirrors integration.spec.ts pattern) ─────

interface UpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let upstream: http.Server;
let upstreamUrl: string;
let upstreamReceived: UpstreamRequest[] = [];
let upstreamResponse: { status: number; body: unknown } = { status: 200, body: { data: [] } };

beforeAll(async () => {
  upstream = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      upstreamReceived.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.statusCode = upstreamResponse.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(upstreamResponse.body));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no upstream addr');
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  upstreamReceived = [];
  upstreamResponse = { status: 200, body: { data: [] } };
});

// ───── Build the MCP HTTP server under test ──────────────────────────────

interface TestHarness {
  url: string;
  store: SessionStore;
  logDir: string;
  close: () => Promise<void>;
}

async function startMcp(): Promise<TestHarness> {
  const logDir = await mkdtemp(path.join(os.tmpdir(), 'bgs-mcp-http-'));
  const logger = new Logger(logDir);
  const store = new SessionStore({ sessionTtlMs: 60_000, sweepIntervalMs: 60_000 });
  const app = buildApp({
    config: {
      port: 0,
      baseUrl: upstreamUrl,
      logDir,
      timeoutMs: 2000,
      retryAttempts: 1,
      // Tests drive a mock upstream that returns 200 by default — auth-verify
      // would succeed but we want to control whether it runs explicitly.
      skipAuthVerify: true,
    },
    logger,
    store,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    store,
    logDir,
    close: async () => {
      store.stopSweeper();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      await rm(logDir, { recursive: true, force: true });
    },
  };
}

// ───── Helper: drive the MCP handshake, return the session id ────────────

const ACCEPT = 'application/json, text/event-stream';

async function initialize(harness: TestHarness, key: string): Promise<string> {
  const res = await fetch(`${harness.url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.1' },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  // Drain the SSE body so the connection is free.
  await res.text();
  return sid!;
}

async function callTool(
  harness: TestHarness,
  key: string,
  sid: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ status: number; rawBody: string; result?: unknown; toolText?: string }> {
  const res = await fetch(`${harness.url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${key}`,
      'Mcp-Session-Id': sid,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const rawBody = await res.text();
  // Streamable HTTP wraps responses in SSE: "event: message\ndata: <json>\n\n".
  // Extract the JSON-RPC payload so tests can assert against parsed shape.
  const dataLine = rawBody.split('\n').find((l) => l.startsWith('data: '));
  let result: unknown;
  let toolText: string | undefined;
  if (dataLine) {
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as {
      result?: { content?: Array<{ type: string; text?: string }> };
    };
    result = parsed.result;
    const text = parsed.result?.content?.[0]?.text;
    if (typeof text === 'string') toolText = text;
  }
  return { status: res.status, rawBody, result, toolText };
}

// ───── Tests ─────────────────────────────────────────────────────────────

describe('HTTP transport — auth middleware', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await startMcp();
  });
  afterAll(async () => {
    await h.close();
  });

  it('rejects requests without an Authorization header (401)', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed bearer (not bgs_) with 401', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-bgs-key',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('exposes /health without auth', async () => {
    const res = await fetch(`${h.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sessions: number };
    expect(body.ok).toBe(true);
    expect(typeof body.sessions).toBe('number');
  });
});

describe('HTTP transport — session lifecycle', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await startMcp();
  });
  afterAll(async () => {
    await h.close();
  });

  it('initialize creates a session and returns Mcp-Session-Id header', async () => {
    const sid = await initialize(h, 'bgs_test_alpha');
    expect(sid).toMatch(/^[0-9a-f-]+$/);
    expect(h.store.size()).toBeGreaterThan(0);
  });

  it('rejects non-initialize first request on a new session (400)', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: 'Bearer bgs_test_beta',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown session id', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: 'Bearer bgs_test_gamma',
        'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('HTTP transport — session-auth binding (security)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await startMcp();
  });
  afterAll(async () => {
    await h.close();
  });

  it('rejects User B presenting User A`s session id with 403', async () => {
    const sidA = await initialize(h, 'bgs_user_alpha');

    // User B tries to use User A's session.
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: 'Bearer bgs_user_beta',
        'Mcp-Session-Id': sidA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('different identity');
  });

  it('accepts the same key returning to its own session', async () => {
    upstreamResponse = {
      status: 200,
      body: {
        data: [
          {
            id: 'b1',
            title: 't',
            status: 'open',
            priority: 'low',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    };
    const sid = await initialize(h, 'bgs_user_delta');
    const r = await callTool(h, 'bgs_user_delta', sid, 'list_bugs', { limit: 1 });
    expect(r.status).toBe(200);
    const inner = JSON.parse(r.toolText ?? '{}') as { data?: Array<{ id: string }> };
    expect(inner.data?.[0]?.id).toBe('b1');
  });
});

describe('HTTP transport — tool dispatch reaches upstream with correct key', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await startMcp();
  });
  afterAll(async () => {
    await h.close();
  });

  it('forwards X-API-Key to upstream BugSpotter and returns thin record', async () => {
    upstreamResponse = {
      status: 200,
      body: {
        data: [
          {
            id: 'bug-99',
            title: 'Test bug',
            status: 'open',
            priority: 'medium',
            created_at: '2026-05-08T00:00:00Z',
            project_id: 'p1',
            description: 'x'.repeat(20_000), // heavy field that must be projected away
            console_errors: Array(50).fill({ msg: 'noise' }),
          },
        ],
      },
    };
    const sid = await initialize(h, 'bgs_dispatch_test');
    upstreamReceived = []; // reset after auth-verify call (which is skipped here, but be safe)

    const r = await callTool(h, 'bgs_dispatch_test', sid, 'list_bugs', { limit: 1 });
    expect(r.status).toBe(200);

    // Upstream got our X-API-Key, not Bearer.
    expect(upstreamReceived).toHaveLength(1);
    expect(upstreamReceived[0]!.headers['x-api-key']).toBe('bgs_dispatch_test');
    expect(upstreamReceived[0]!.headers.authorization).toBeUndefined();

    // Response is thin (heavy fields projected away by list_bugs).
    const inner = JSON.parse(r.toolText ?? '{}') as { data?: Array<Record<string, unknown>> };
    const bug = inner.data?.[0];
    expect(bug?.id).toBe('bug-99');
    expect(bug).not.toHaveProperty('description');
    expect(bug).not.toHaveProperty('console_errors');
  });

  it('writes a JSONL log line per tool call with anonymized session_id', async () => {
    upstreamResponse = { status: 200, body: { data: [] } };
    const key = 'bgs_log_test';
    const expectedHash = hashKey(key);
    const sid = await initialize(h, key);
    await callTool(h, key, sid, 'list_bugs', { limit: 3 });

    // Find today's log file.
    const files = await readdir(h.logDir);
    const logFile = files.find((f) => f.startsWith('calls-') && f.endsWith('.jsonl'));
    expect(logFile).toBeDefined();
    const contents = await readFile(path.join(h.logDir, logFile!), 'utf8');
    const lines = contents.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(last.session_id).toBe(expectedHash);
    expect(last.session_id).not.toBe(key); // never log the raw key
    expect(last.agent_hint).toBe('http');
    expect(last.tool).toBe('list_bugs');
  });
});

describe('HTTP transport — auth pre-verification (fail-fast)', () => {
  // These tests don't reuse the default harness because they need
  // skipAuthVerify: false to actually exercise the verify path.
  async function startWithVerify(): Promise<TestHarness> {
    const logDir = await mkdtemp(path.join(os.tmpdir(), 'bgs-mcp-verify-'));
    const logger = new Logger(logDir);
    const store = new SessionStore({ sessionTtlMs: 60_000, sweepIntervalMs: 60_000 });
    const app = buildApp({
      config: {
        port: 0,
        baseUrl: upstreamUrl,
        logDir,
        timeoutMs: 2000,
        retryAttempts: 1,
        skipAuthVerify: false, // <-- the point of this suite
      },
      logger,
      store,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    return {
      url: `http://127.0.0.1:${addr.port}`,
      store,
      logDir,
      close: async () => {
        store.stopSweeper();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
        await rm(logDir, { recursive: true, force: true });
      },
    };
  }

  async function tryInitialize(harness: TestHarness, key: string): Promise<{ status: number; body: { error?: string; reason?: string; upstream_status?: number | null } }> {
    const res = await fetch(`${harness.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'verify-test', version: '0' },
        },
      }),
    });
    // Errors return JSON; success returns SSE. Discriminate by content-type
    // so tests can assert on either path without a parse-bombing happy case.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      return { status: res.status, body: (await res.json()) as { error?: string; reason?: string } };
    }
    await res.text(); // drain body
    return { status: res.status, body: {} };
  }

  it('returns 401 when upstream rejects the key with 401', async () => {
    upstreamResponse = { status: 401, body: { message: 'invalid api key' } };
    const h = await startWithVerify();
    try {
      const r = await tryInitialize(h, 'bgs_invalid_for_verify');
      expect(r.status).toBe(401);
      expect(r.body.error).toContain('auth verification failed');
      expect(r.body.upstream_status).toBe(401);
      // Initialize was rejected before any session was created.
      expect(h.store.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('returns 403 when upstream rejects the key with 403', async () => {
    upstreamResponse = { status: 403, body: { message: 'forbidden' } };
    const h = await startWithVerify();
    try {
      const r = await tryInitialize(h, 'bgs_no_scope');
      expect(r.status).toBe(403);
      expect(r.body.upstream_status).toBe(403);
      expect(h.store.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('returns 502 (NOT 401) when upstream is degraded — distinguishes "key bad" from "upstream broken"', async () => {
    upstreamResponse = { status: 503, body: { message: 'service unavailable' } };
    const h = await startWithVerify();
    try {
      const r = await tryInitialize(h, 'bgs_innocent_during_outage');
      expect(r.status).toBe(502); // Bad Gateway, not 401
      expect(r.body.error).toContain('upstream verification unavailable');
      expect(r.body.upstream_status).toBe(503);
    } finally {
      await h.close();
    }
  });

  it('proceeds with initialize when verify succeeds (200 from upstream)', async () => {
    upstreamResponse = { status: 200, body: { data: [] } };
    const h = await startWithVerify();
    try {
      const r = await tryInitialize(h, 'bgs_valid_for_verify');
      // We don't get JSON back (we get SSE). 200 here means initialize
      // proceeded past the verify gate.
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(403);
      expect(r.status).not.toBe(502);
      expect(h.store.size()).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('HTTP transport — TTL sweeper', () => {
  it('removes sessions whose lastActivity is older than ttl', async () => {
    const h = await startMcp();
    try {
      await initialize(h, 'bgs_ttl_test');
      expect(h.store.size()).toBe(1);

      // Drive the sweeper directly with a future "now" — nothing time-mocked.
      const removed = h.store.sweepOnce(Date.now() + 24 * 60 * 60 * 1000);
      expect(removed).toBe(1);
      expect(h.store.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('keeps sessions whose lastActivity is within ttl', async () => {
    const h = await startMcp();
    try {
      await initialize(h, 'bgs_ttl_keep');
      const removed = h.store.sweepOnce(Date.now()); // immediate sweep
      expect(removed).toBe(0);
      expect(h.store.size()).toBe(1);
    } finally {
      await h.close();
    }
  });
});
