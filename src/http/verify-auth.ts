import axios, { AxiosError } from 'axios';

/**
 * Cheap auth pre-verification. Called once per session on `initialize`.
 *
 * Strategy: hit a known authenticated endpoint with HEAD/GET and infer
 * key validity from the response code. We pick `GET /api/v1/reports?limit=1`
 * because:
 *  - It exists on every BugSpotter deployment we'll point at.
 *  - It requires the `reports:read` scope (which is the minimum scope
 *    the MCP server needs anyway).
 *  - With limit=1 the upstream cost is bounded.
 *
 * Returns the verification result. On failure, the HTTP layer should
 * fail the initialize early rather than waiting for the first real
 * tool call to surface a 401 — much better UX in clients that show
 * the connection as "connected" up until the first failed tool call.
 *
 * TODO(phase-2): once the BugSpotter backend exposes a dedicated
 * `/api/v1/auth/verify` endpoint that just inspects the key without a
 * DB query, switch to that.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; status: number | null; reason: string };

export async function verifyAuth(baseUrl: string, apiKey: string, timeoutMs = 5000): Promise<VerifyResult> {
  try {
    const res = await axios.get(`${baseUrl}/api/v1/reports`, {
      params: { limit: 1 },
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      timeout: timeoutMs,
      validateStatus: () => true, // we'll classify ourselves
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return {
      ok: false,
      status: res.status,
      reason: res.status === 401
        ? 'invalid api key'
        : res.status === 403
          ? 'api key lacks reports:read scope or project access'
          : `upstream returned ${res.status}`,
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError;
      if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
        return { ok: false, status: null, reason: 'upstream verification timed out' };
      }
      return { ok: false, status: null, reason: `network error: ${ax.message}` };
    }
    return { ok: false, status: null, reason: err instanceof Error ? err.message : String(err) };
  }
}
