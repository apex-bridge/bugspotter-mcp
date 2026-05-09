#!/usr/bin/env node
/**
 * HTTP entry point for bugspotter-mcp.
 *
 * Multi-tenant: one process serves many users; auth is per-request via
 * `Authorization: Bearer bgs_<key>` header. Optional project scoping
 * via `X-Project-ID` header.
 *
 * Architecture:
 *  - One shared `Server` instance for all sessions (handlers read auth
 *    from `extra.authInfo`, no per-session Server needed).
 *  - SessionStore holds (sessionId → { transport, sessionHash, client })
 *    with TTL sweeper for stale sessions and auth-binding to prevent
 *    session hijacking.
 *  - One `BugSpotterClient` per session (cached), not per request.
 *  - Auth pre-verification on initialize — fail fast if the key is bad.
 *
 * Run:
 *   BUGSPOTTER_BASE_URL=https://api.kz.bugspotter.io node dist/server-http.js
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
import { randomUUID } from 'node:crypto';
// Side-effect import: this file augments Express Request with `auth?: AuthInfo`.
import '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

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
import { SessionStore, hashKey, buildSessionClient } from './http/session-store.js';
import { verifyAuth } from './http/verify-auth.js';

// ───── Validators ─────────────────────────────────────────────────────────

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

// ───── Config (process-wide; per-tenant key is per-request) ───────────────

interface HttpConfig {
  port: number;
  baseUrl: string;
  logDir: string;
  timeoutMs: number;
  retryAttempts: number;
  /** Skip pre-verification on initialize. Useful for tests against mocks. */
  skipAuthVerify: boolean;
}

export function loadHttpConfig(env = process.env): HttpConfig {
  const baseUrl = env.BUGSPOTTER_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) throw new Error('BUGSPOTTER_BASE_URL is required');
  return {
    port: parseInt(env.PORT ?? '8080', 10),
    baseUrl,
    logDir: env.LOG_DIR ?? './logs',
    timeoutMs: 10_000,
    retryAttempts: 3,
    skipAuthVerify: env.MCP_SKIP_AUTH_VERIFY === '1',
  };
}

// ───── Auth middleware ────────────────────────────────────────────────────

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
  const sessionHash = hashKey(token);
  const projectId = (req.headers['x-project-id'] as string | undefined)?.trim() || undefined;
  req.auth = {
    token,
    clientId: sessionHash,
    scopes: ['reports:read', 'reports:write'],
    extra: { sessionHash, projectId },
  };
  next();
}

// ───── Build a Server — one instance per session ─────────────────────────
//
// We create a fresh `Server` instance per session, NOT a single shared one.
// The MCP SDK's `Server.connect(transport)` binds the transport into the
// server's internal `_transport` slot — calling `connect` twice replaces
// the previous transport rather than additively serving both, so a shared
// Server only works in single-transport modes (stdio). For HTTP we accept
// the small per-session memory cost (a few KB per Server instance) to keep
// transport-server pairs intact.
//
// Gemini-Code-Assist flagged the spike's per-session Server as wasteful,
// but the suggested optimization conflicts with the SDK's connect() model.
// Documented here so the next person doesn't repeat the experiment.
export function buildServer(logger: Logger): Server {
  const server = new Server(
    { name: 'bugspotter-mcp-http', version: '0.3.0' },
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
    if (!apiKey) throw new McpError(ErrorCode.InvalidRequest, 'no api key in this session');

    // The HTTP route layer is contracted to populate authInfo.extra with
    // a cached BugSpotterClient + per-request Config before forwarding
    // to the transport. If either is missing, that contract has been
    // broken — fail loudly rather than silently constructing a client
    // with a hollow `baseUrl: ''` (which axios would resolve against
    // the MCP server's own host, an even worse failure mode).
    const client = extra.authInfo?.extra?.client as ToolContext['client'] | undefined;
    const config = extra.authInfo?.extra?.config as Config | undefined;
    if (!client || !config) {
      throw new McpError(
        ErrorCode.InternalError,
        'session client/config not initialized — HTTP route layer did not populate authInfo.extra'
      );
    }
    const ctx: ToolContext = { client, logger, config };

    return dispatch(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx, sessionHash);
  });

  return server;
}

// ───── Dispatch (mirrors stdio server, anonymized session_id) ─────────────

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
    session_id: sessionHash,
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

// ───── Build the Express app (factored for tests) ─────────────────────────

export interface AppDeps {
  config: HttpConfig;
  logger: Logger;
  store: SessionStore;
  /** Override for tests — defaults to `buildServer(logger)`. */
  serverFactory?: () => Server;
}

export function buildApp(deps: AppDeps): express.Express {
  const makeServer = deps.serverFactory ?? (() => buildServer(deps.logger));
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: deps.store.size() });
  });

  app.use(authMiddleware);

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const presenting = req.auth!;
    const presentingHash = (presenting.extra?.sessionHash as string) ?? '';

    if (sessionId) {
      // Existing session: must match the auth that initialized it.
      const found = deps.store.lookup(sessionId, presentingHash);
      if (!found.ok) {
        const status = found.reason === 'unknown' ? 404 : 403;
        const error =
          found.reason === 'unknown'
            ? 'unknown session'
            : 'session belongs to a different identity';
        res.status(status).json({ error });
        return;
      }
      // Inject the cached client + per-request config into authInfo.extra
      // so the per-session Server's tool handler can reuse the cached
      // axios while the live X-Project-ID header still flows through to
      // the per-call ToolContext.config.
      presenting.extra = {
        ...(presenting.extra ?? {}),
        client: found.state.client,
        config: clientConfigFor(deps.config, presenting.token, presenting.extra?.projectId as string | undefined),
      };
      await found.state.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — only `initialize` is allowed without an existing sessionId.
    const method = (req.body as { method?: string } | undefined)?.method;
    if (method !== 'initialize') {
      res.status(400).json({ error: 'first request on a new session must be initialize' });
      return;
    }

    // Fail fast on bad auth: hit BugSpotter once before doing the MCP dance.
    if (!deps.config.skipAuthVerify) {
      const v = await verifyAuth(deps.config.baseUrl, presenting.token);
      if (!v.ok) {
        // 401/403 from upstream → key really is bad; surface as auth error.
        // Anything else (502, timeout, network) → upstream is degraded; surface
        // as 502 Bad Gateway so the client can distinguish "fix your key" from
        // "retry later" and not falsely tell the user their key is invalid.
        const isAuthFailure = v.status === 401 || v.status === 403;
        res.status(isAuthFailure ? (v.status as 401 | 403) : 502).json({
          error: isAuthFailure ? 'auth verification failed' : 'upstream verification unavailable',
          reason: v.reason,
          upstream_status: v.status,
        });
        return;
      }
    }

    // Spin up a Server + transport pair. One Server per session — see
    // comment on buildServer for why we don't share.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Pre-arm cleanup: if the transport closes BEFORE we register the
    // session (early client disconnect, server crash, handler throw),
    // we still need to release whatever the SDK allocated. Once
    // `register()` is called below, it will replace this onclose with
    // its own (which also drops the session from the store).
    let registered = false;
    transport.onclose = () => {
      if (!registered) {
        // Transport closed before we got a session id. Nothing to clean
        // up in the store; the SDK handles its own resources.
      }
    };

    const server = makeServer();
    await server.connect(transport);

    const cfg = clientConfigFor(deps.config, presenting.token, presenting.extra?.projectId as string | undefined);
    const client = buildSessionClient(
      { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, retryAttempts: cfg.retryAttempts },
      presenting.token
    );
    presenting.extra = { ...(presenting.extra ?? {}), client, config: cfg };

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // handleRequest threw before assigning a sessionId or before we
      // could register. Tear the transport down explicitly; whatever
      // partial state the SDK held is now garbage.
      await transport.close?.().catch(() => {});
      throw err;
    }

    if (transport.sessionId) {
      deps.store.register({
        transport,
        sessionHash: presentingHash,
        client,
      });
      registered = true;
    } else {
      // Transport finished the request but no session id was assigned —
      // shouldn't happen on a successful initialize, but if it does we
      // shouldn't leak the transport.
      await transport.close?.().catch(() => {});
    }
  });

  // Notification stream (SSE) + session termination — both go through the same
  // session-bound transport, with the same auth-binding check.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const presentingHash = (req.auth!.extra?.sessionHash as string) ?? '';
      if (!sessionId) {
        res.status(400).json({ error: 'Mcp-Session-Id header required' });
        return;
      }
      const found = deps.store.lookup(sessionId, presentingHash);
      if (!found.ok) {
        const status = found.reason === 'unknown' ? 404 : 403;
        const error =
          found.reason === 'unknown'
            ? 'unknown session'
            : 'session belongs to a different identity';
        res.status(status).json({ error });
        return;
      }
      await found.state.transport.handleRequest(req, res);
    });
  }

  // Terminal JSON error handler. Without this, Express 5 forwards async
  // rejections (including malformed JSON bodies and overflow from
  // express.json's `limit`) to the default error handler which serves
  // an HTML stack trace — useless to MCP SDK clients that expect JSON.
  // Make sure every error response is content-type application/json
  // with a structured shape.
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({
      error: err.message || 'internal error',
      code: status,
    });
  });

  return app;
}

function clientConfigFor(http: HttpConfig, apiKey: string, projectId: string | undefined): Config {
  return {
    baseUrl: http.baseUrl,
    apiKey,
    defaultProject: projectId,
    logDir: http.logDir,
    timeoutMs: http.timeoutMs,
    retryAttempts: http.retryAttempts,
  };
}

// ───── Ops logging (stdout/stderr; distinct from the JSONL behavioral log) ─

/**
 * Emit a lifecycle / ops log line. Two formats:
 *   - "text" (default) — human-readable, single line for `docker logs` tailing.
 *   - "json"           — one-line JSON for log shippers (Loki, Vector, Fluentd).
 * Picked via `MCP_LOG_FORMAT` env. Behavioral / per-call logs are independent
 * and always JSONL on disk; this helper is for the server's own lifecycle.
 */
type LogLevel = 'info' | 'warn' | 'error';
function logEvent(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const format = process.env.MCP_LOG_FORMAT === 'json' ? 'json' : 'text';
  if (format === 'json') {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    return;
  }
  const fieldsStr = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : '';
  // eslint-disable-next-line no-console
  console.error(`[bugspotter-mcp-http] ${level.toUpperCase()} ${msg}${fieldsStr}`);
}

// ───── Entry point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const logger = new Logger(config.logDir);
  const store = new SessionStore();
  const app = buildApp({ config, logger, store });

  store.startSweeper();

  const httpServer = app.listen(config.port, () => {
    logEvent('info', 'listening', {
      port: config.port,
      upstream: config.baseUrl,
      log_dir: config.logDir,
      log_format: process.env.MCP_LOG_FORMAT === 'json' ? 'json' : 'text',
    });
  });

  const shutdown = (sig: string): void => {
    logEvent('info', 'shutting down', { signal: sig });
    store.stopSweeper();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only run main() when invoked directly, not when imported by tests.
// `pathToFileURL` handles Windows file:// vs file:/// quirks correctly.
import { pathToFileURL } from 'node:url';
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logEvent('error', 'fatal', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
