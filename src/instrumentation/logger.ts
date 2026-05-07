import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LogRecord {
  timestamp: string;
  session_id: string | null;
  agent_hint: string;
  tool: string;
  args: unknown;
  args_size_bytes: number;
  result_status: 'ok' | 'error';
  result_count: number | null;
  result_size_bytes: number;
  duration_ms: number;
  error_class: 'validation' | 'upstream_4xx' | 'upstream_5xx' | 'timeout' | 'network' | null;
  error_message: string | null;
  upstream_url: string | null;
}

// Tools whose primary args are free-form natural language. We redact PII matches
// from these before writing to disk.
const REDACT_TOOLS = new Set(['ask', 'search_bugs']);

const PII_PATTERNS: RegExp[] = [
  // emails
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // credit cards (13–19 digits with optional separators)
  /\b(?:\d[ -]*?){13,19}\b/g,
  // JWT-ish (three base64url segments)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

export function redactPii(value: string): string {
  let out = value;
  for (const re of PII_PATTERNS) {
    out = out.replace(re, '<redacted>');
  }
  return out;
}

export function redactArgs(toolName: string, args: unknown): unknown {
  if (!REDACT_TOOLS.has(toolName) || args === null || typeof args !== 'object') {
    return args;
  }
  const clone: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    const v = clone[key];
    if (typeof v === 'string') clone[key] = redactPii(v);
  }
  return clone;
}

export class Logger {
  constructor(private logDir: string) {}

  async write(rec: LogRecord): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
    const date = rec.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = path.join(this.logDir, `calls-${date}.jsonl`);
    await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  }
}

export function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
