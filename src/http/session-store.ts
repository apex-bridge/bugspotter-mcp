import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BugSpotterClient } from '../client/bugspotter-client.js';
import type { Config } from '../types.js';

/**
 * Per-session state for the HTTP transport.
 *
 * Owns three things that must stay in lock-step:
 *  1. The MCP transport (for the underlying SSE / JSON-RPC plumbing).
 *  2. The hash of the auth that initialized the session — used to reject
 *     requests that present a known sessionId with a different Bearer.
 *     This closes the session-hijacking gap Gemini caught in the spike.
 *  3. A cached BugSpotterClient bound to that auth — avoids the per-call
 *     axios churn the spike had.
 *
 * Plus a `lastActivity` stamp so the TTL sweeper can collect zombie
 * sessions where the client dropped without sending DELETE.
 */
export interface SessionState {
  transport: StreamableHTTPServerTransport;
  sessionHash: string;
  client: BugSpotterClient;
  lastActivity: number;
}

export interface SessionStoreOptions {
  /** Time-to-live for inactive sessions, in ms. Default 30 min. */
  sessionTtlMs?: number;
  /** Sweeper cadence, in ms. Default 5 min. */
  sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

export function hashKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export class SessionStore {
  private sessions = new Map<string, SessionState>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly sweepMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.ttlMs = opts.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  }

  /**
   * Register a brand-new session. Called once per `initialize`.
   * The transport is expected to have already gone through the SDK's
   * session-id assignment by the time this is called.
   */
  register(state: Omit<SessionState, 'lastActivity'>): void {
    const sessionId = state.transport.sessionId;
    if (!sessionId) {
      throw new Error('cannot register session: transport has no sessionId');
    }
    this.sessions.set(sessionId, { ...state, lastActivity: Date.now() });
    state.transport.onclose = () => this.delete(sessionId);
  }

  /**
   * Look up a session, gated on auth match. Returns the session iff:
   *   1. A session exists for the given sessionId, and
   *   2. The presenting auth's hash matches the one that initialized it.
   *
   * Returns null + a reason for any other case. The reason is structured
   * so callers can map it to the correct HTTP status (404 vs 403).
   */
  lookup(
    sessionId: string,
    presentingHash: string
  ): { ok: true; state: SessionState } | { ok: false; reason: 'unknown' | 'auth-mismatch' } {
    const state = this.sessions.get(sessionId);
    if (!state) return { ok: false, reason: 'unknown' };
    if (state.sessionHash !== presentingHash) return { ok: false, reason: 'auth-mismatch' };
    state.lastActivity = Date.now();
    return { ok: true, state };
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** For tests + observability. Don't use as a primary API. */
  size(): number {
    return this.sessions.size;
  }

  /** Boot the periodic sweeper. Idempotent. */
  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepOnce(Date.now()), this.sweepMs);
    // Allow the process to exit even if the sweeper is still scheduled.
    this.sweepTimer.unref?.();
  }

  /** Stop the sweeper. Idempotent. Safe in tests / shutdown hooks. */
  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Single sweep pass. Exported so tests can drive it deterministically
   * without waiting for setInterval. Returns the number of sessions removed.
   */
  sweepOnce(now: number): number {
    let removed = 0;
    for (const [sessionId, state] of this.sessions) {
      if (now - state.lastActivity > this.ttlMs) {
        // Best-effort close — ignore errors from already-closed transports.
        state.transport.close?.().catch(() => {});
        this.sessions.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Build a per-session BugSpotterClient. Keeps the axios instance alive
 * for the session's lifetime (one client per tenant, not per request).
 */
export function buildSessionClient(baseConfig: Omit<Config, 'apiKey'>, apiKey: string): BugSpotterClient {
  return new BugSpotterClient({ ...baseConfig, apiKey });
}
