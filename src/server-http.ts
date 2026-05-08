#!/usr/bin/env node
/**
 * SPIKE — HTTP entry point for bugspotter-mcp.
 *
 * Goal: prove that the SDK's StreamableHTTPServerTransport + per-request
 * API key auth lets us run one server process serving many tenants. NOT
 * production-shaped — uses transitive express, no rate limiting, no TLS,
 * no observability beyond the existing JSONL logger. Validates the
 * architecture for v1.0 hosted deployment.
 *
 * Run: BUGSPOTTER_BASE_URL=https://api.kz.bugspotter.io node dist/server-http.js
 * Test: curl -H "Authorization: Bearer bgs_xxx" http://localhost:8080/mcp -X POST ...
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';
import { randomUUID, createHash } from 'node:crypto';
// Side-effect import: this file augments Express Request with `auth?: AuthInfo`.
import '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { BugSpotterClient } from './client/bugspotter-client.js';
import {
  Logger,
  redactArgs,
  byteLength,
  serializeResult,
  type LogRecord,
} from './instrumentation/logger.js';
import { TOOLS } from './tools/index.js';
import {
  UpstreamError,
  type ToolDefinition,
  type ToolContext,
  type Config,
} from './types.js';

type AddFormatsFn = (ajv: Ajv) => void;
const addFormats: AddFormatsFn =
  (addFormatsImport as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsImport as unknown as AddFormatsFn);

const ajv = new Ajv({ allErrors: true, useDefaults: false, strict: false });
addFormats(ajv);

const VALIDATORS = new Map<string, ValidateFunction>(
  TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)])
);
const TOOL_BY_NAME = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

// ---- Config (process-wide; per-tenant key comes from headers per request) -----

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const BASE_URL = process.env.BUGSPOTTER_BASE_URL?.replace(/\/$/, '');
const LOG_DIR = process.env.LOG_DIR ?? './logs';
const TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 3;

if (!BASE_URL) {
  // eslint-disable-next-line no-console
  console.error('BUGSPOTTER_BASE_URL is required');
  process.exit(1);
}

const logger = new Logger(LOG_DIR);

// ---- Auth middleware: parse Bearer bgs_* into AuthInfo on req.auth ----
// (SDK augments Express Request with `auth?: AuthInfo` via bearerAuth module.)

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer bgs_')) {
    res.status(401).json({ error: 'Authorization: Bearer bgs_<key> required' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'empty token' });
    return;
  }
  // Hash the key for log identity. Never log the raw key.
  const sessionHash = createHash('sha256').update(token).digest('hex').slice(0, 12);
  const projectId = (req.headers['x-project-id'] as string | undefined)?.trim() || undefined;
  req.auth = {
    token,
    clientId: sessionHash,
    scopes: ['reports:read', 'reports:write'],
    extra: { sessionHash, projectId },
  };
  next();
}

// ---- Session map (stateful mode — one transport+server pair per MCP session) ----

const transports = new Map<string, StreamableHTTPServerTransport>();

function makeServer(): Server {
  const server = new Server(
    { name: 'bugspotter-mcp-http', version: '0.3.0-spike' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const apiKey = extra.authInfo?.token;
    const sessionHash = (extra.authInfo?.extra?.sessionHash as string | undefined) ?? 'unknown';
    const projectId = extra.authInfo?.extra?.projectId as string | undefined;

    if (!apiKey) {
      throw new McpError(ErrorCode.InvalidRequest, 'No API key in this session');
    }

    const config: Config = {
      baseUrl: BASE_URL!,
      apiKey,
      defaultProject: projectId,
      logDir: LOG_DIR,
      timeoutMs: TIMEOUT_MS,
      retryAttempts: RETRY_ATTEMPTS,
    };
    const client = new BugSpotterClient(config);
    const ctx: ToolContext = { client, logger, config };

    return dispatch(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx, sessionHash);
  });

  return server;
}

// ---- Dispatch (mirrors the stdio server, anonymized session_id) ----

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  sessionHash: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);

  const start = Date.now();
  const validate = VALIDATORS.get(tool.name)!;
  const base: Omit<LogRecord, 'duration_ms' | 'result_status' | 'result_count' | 'result_size_bytes' | 'error_class' | 'error_message' | 'upstream_url'> = {
    timestamp: new Date().toISOString(),
    session_id: sessionHash, // anonymized: sha256(apiKey)[:12]
    agent_hint: 'http',
    tool: tool.name,
    args: redactArgs(tool.name, args),
    args_size_bytes: byteLength(args),
  };

  if (!validate(args)) {
    const msg = ajv.errorsText(validate.errors, { dataVar: tool.name });
    await ctx.logger.write({
      ...base,
      duration_ms: Date.now() - start,
      result_status: 'error',
      result_count: null,
      result_size_bytes: 0,
      error_class: 'validation',
      error_message: msg,
      upstream_url: null,
    });
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${tool.name}: ${msg}`);
  }

  try {
    const result = await tool.handler(args, ctx);
    const text = serializeResult(result.data);
    await ctx.logger.write({
      ...base,
      duration_ms: Date.now() - start,
      result_status: 'ok',
      result_count: result.resultCount,
      result_size_bytes: byteLength(text),
      error_class: null,
      error_message: null,
      upstream_url: result.upstreamUrl,
    });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const upstream = err instanceof UpstreamError ? err : null;
    const errorClass = upstream?.errorClass ?? 'network';
    const message = err instanceof Error ? err.message : String(err);
    await ctx.logger.write({
      ...base,
      duration_ms: Date.now() - start,
      result_status: 'error',
      result_count: null,
      result_size_bytes: 0,
      error_class: errorClass,
      error_message: message,
      upstream_url: upstream?.upstreamUrl ?? null,
    });
    return {
      content: [
        {
          type: 'text',
          text: serializeResult({
            error: message,
            status: upstream?.status ?? null,
            error_class: errorClass,
          }),
        },
      ],
      isError: true,
    };
  }
}

// ---- HTTP wiring ----

const app = express();
app.use(express.json({ limit: '4mb' }));

// Health check (no auth)
app.get('/health', (_req, res) => {
  res.json({ ok: true, transports: transports.size });
});

// Everything below requires Bearer
app.use(authMiddleware);

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      const id = transport!.sessionId;
      if (id) transports.delete(id);
    };
    const server = makeServer();
    await server.connect(transport);
  }

  // The SDK transport reads req.auth (set by our middleware) and threads
  // it as authInfo into RequestHandlerExtra. No manual onmessage wrapping.
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId && !transports.has(transport.sessionId)) {
    transports.set(transport.sessionId, transport);
  }
});

// Allow GET for SSE notifications stream (per Streamable HTTP spec)
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).json({ error: 'unknown session' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).json({ error: 'unknown session' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `[bugspotter-mcp-http] listening on :${PORT}  upstream=${BASE_URL}  log_dir=${LOG_DIR}`
  );
});
