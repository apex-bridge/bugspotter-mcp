import type { BugSpotterClient } from './client/bugspotter-client.js';
import type { Logger } from './instrumentation/logger.js';
import type { Config } from './config.js';

export type { Config };

export interface ToolContext {
  client: BugSpotterClient;
  logger: Logger;
  config: Config;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  data: unknown;
  resultCount: number | null;
  upstreamUrl: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public errorClass: 'upstream_4xx' | 'upstream_5xx' | 'timeout' | 'network',
    public upstreamUrl: string
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

