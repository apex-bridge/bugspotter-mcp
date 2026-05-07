#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';

// ajv-formats is CJS; under NodeNext the static type is a namespace, but at runtime
// the module.exports IS the plugin function (also re-exported as .default).
type AddFormatsFn = (ajv: Ajv) => void;
const addFormats: AddFormatsFn =
  (addFormatsImport as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsImport as unknown as AddFormatsFn);

import { loadConfig } from './config.js';
import { BugSpotterClient } from './client/bugspotter-client.js';
import {
  Logger,
  redactArgs,
  byteLength,
  serializeResult,
  type LogRecord,
} from './instrumentation/logger.js';
import { TOOLS } from './tools/index.js';
import { UpstreamError, type ToolDefinition, type ToolContext } from './types.js';

const ajv = new Ajv({ allErrors: true, useDefaults: false, strict: false });
addFormats(ajv);

const VALIDATORS = new Map<string, ValidateFunction>(
  TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)])
);
const TOOL_BY_NAME = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new BugSpotterClient(config);
  const logger = new Logger(config.logDir);
  const ctx: ToolContext = { client, logger, config };

  const server = new Server(
    { name: 'bugspotter-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return dispatch(tool, args, ctx, agentHint(server));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function dispatch(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
  agent: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const start = Date.now();
  const validate = VALIDATORS.get(tool.name)!;
  const base: Omit<LogRecord, 'duration_ms' | 'result_status' | 'result_count' | 'result_size_bytes' | 'error_class' | 'error_message' | 'upstream_url'> = {
    timestamp: new Date().toISOString(),
    session_id: null,
    agent_hint: agent,
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
          text: JSON.stringify({
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

function agentHint(server: Server): string {
  // SDK exposes the client's identification once initialize handshake completes.
  // Best-effort: fall back to "unknown" before init or when the client omits it.
  const info = (server as unknown as { getClientVersion?: () => { name?: string; version?: string } | undefined }).getClientVersion?.();
  if (!info?.name) return 'unknown';
  return info.version ? `${info.name}-${info.version}` : info.name;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bugspotter-mcp] Fatal:', err);
  process.exit(1);
});
