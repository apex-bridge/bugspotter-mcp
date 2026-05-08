# Spike: HTTP transport for hosted MCP

**Date:** 2026-05-08
**Branch:** `spike/http-transport`
**Goal:** answer Phase 0 question — can we host one bugspotter-mcp process and serve many tenants via HTTP, with per-request API key auth?

**Verdict:** **yes**. Architecture works. ~250 lines in one new file (`src/server-http.ts`), no changes to existing tools / client / logger / tests. Stdio path unchanged, 42/42 tests still pass.

---

## What was built

A minimal HTTP entry point that stands up next to the existing stdio entry point:

```
src/
├── server.ts         (existing stdio entry, untouched)
├── server-http.ts    (NEW — Express + Streamable HTTP transport)
├── tools/            (shared)
├── client/           (shared)
└── instrumentation/  (shared)
```

The HTTP server is **stateful** (one transport+server pair per MCP session ID), reads `Authorization: Bearer bgs_…` per request, optionally `X-Project-ID`, and constructs a per-request `BugSpotterClient` inside the tool dispatch handler. No global API-key state.

## End-to-end smoke test

Started against prod (`api.kz.bugspotter.io`), drove it via curl:

| Step | HTTP code | Outcome |
|---|---|---|
| `GET /health` | 200 | `{ ok: true, transports: 0 }` |
| `POST /mcp` (no auth) | 401 | `Authorization: Bearer bgs_<key> required` |
| `POST /mcp initialize` | 200 (SSE) | session ID assigned, server info returned |
| `POST /mcp notifications/initialized` | 202 | session active |
| `POST /mcp tools/list` | 200 (SSE) | all 6 tools returned |
| `POST /mcp tools/call list_bugs` | 200 (SSE) | **3 prod bugs, 885 B** — identical to stdio result |

Behavioral log line (anonymized session ID, never raw key):

```json
{"timestamp":"2026-05-08T13:17:15.937Z","session_id":"bc30219e1c47","agent_hint":"http",
 "tool":"list_bugs","args":{"limit":3},"args_size_bytes":11,"duration_ms":443,
 "result_status":"ok","result_count":3,"result_size_bytes":885,
 "error_class":null,"error_message":null,"upstream_url":"GET /api/v1/reports"}
```

`result_size_bytes` is **identical** between stdio (765 measured pre-v0.2.1, 885 post-v0.2.1) and HTTP — confirming the HTTP path adds zero overhead to the agent-visible payload.

## Decision answers from the spike

| Question | Answer | Why |
|---|---|---|
| **Code home** | Same repo, two entry points | Shared tools/client/logger; minimal divergence; single source of truth for article #2 receipts. Confirmed practical with the spike's file layout. |
| **Auth header** | `Authorization: Bearer bgs_…` | SDK's `bearerAuth` middleware augments Express `Request.auth` with `AuthInfo` for free; standard MCP convention; spike works today. Internal call to BugSpotter still uses `X-API-Key` (translated by our client). |
| **Project scoping** | `X-Project-ID` header (optional, per-request) | Spike accepts it on initialize, threads through `extra.authInfo.extra.projectId` into per-request config. Auto-resolve from key (single-project keys) is a backend feature for later — doesn't change the transport story. |
| **Logging policy** | Anonymized always — `session_id = sha256(apiKey).slice(0,12)` | Spike already implements; raw key never leaves the request boundary. Opt-in for richer args logging is a config flag we can add without architectural change. |
| **Pricing tier** | Not affected by transport choice | Architectural decision, deferred. |

## Things that worked surprisingly well

- **`StreamableHTTPServerTransport.handleRequest(req, res, body)`** — the SDK does all the JSON-RPC plumbing, SSE streaming, session ID management. Our code just wires Express auth in front and the `Server` instance behind.
- **`extra.authInfo` propagation** — the SDK reads `req.auth` from the Express request and threads it through `MessageExtraInfo → RequestHandlerExtra` automatically. No custom `onmessage` interception needed. Setting `req.auth = { token, clientId, scopes, extra: { ... } }` in middleware was sufficient.
- **`req.auth.extra`** — arbitrary metadata bag. Used for `sessionHash` and `projectId` without polluting the standard AuthInfo shape.
- **Per-request `BugSpotterClient`** — no architectural refactor needed. Just instantiate inside the request handler with the per-session config. Tiny axios-instance churn, ignorable for moderate load.

## Things that surprised me (mildly)

- **Side-effect import for the type augmentation.** Without `import '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'`, TypeScript doesn't know about `req.auth: AuthInfo`. Importing the file purely for its `declare module` augmentation feels gross but is the canonical pattern. Documented in code comment.
- **`@types/express` not transitive.** Express itself is in our tree (transitive from MCP SDK), but `@types/express` was not. Added as devDep. Production version should make Express a direct dep.
- **MCP `Accept` header requirement.** Clients have to send `Accept: application/json, text/event-stream` — otherwise the transport returns 406. Worth flagging in customer-facing docs.

## Open questions / TODOs surfaced (all non-blocking for go/no-go)

1. **Stale session GC.** `transports` Map grows unbounded if clients drop without sending DELETE. Need session TTL + sweeper.
2. **Auth verification.** Spike accepts any `bgs_*`-shaped string; first real REST call surfaces 401 if invalid. Production should fail fast on connect with an explicit `/api/v1/auth/verify` round-trip cached for the session.
3. **Rate limiting.** Not in spike. Our backend already rate-limits per API key, so we can defer to that — but the MCP layer should pre-empt obviously hot loops to protect upstream.
4. **Concurrency model.** Express + axios — single Node process is fine for moderate load (10s of concurrent sessions). Beyond that, horizontal scaling is just running multiple containers behind a load balancer; sessions are sticky to the process holding them, so the LB needs sticky routing on `Mcp-Session-Id`.
5. **TLS / production deployment.** Out of scope for spike. Will live behind nginx / Caddy / Traefik on `mcp.kz.bugspotter.io`.

## Recommendation

**Go on Phases 1–4.** No architectural blockers. Estimates from the previous plan still hold:

| Phase | Work | Original estimate | Updated after spike |
|---|---|---|---|
| 1. Refactor for multi-tenancy | Production-grade `server-http.ts`, session GC, auth pre-verify, structured config | 3-5 days | **2-3 days** (less than feared — most of the architecture is the spike file) |
| 2. Deployment infra | Dockerfile, DNS, TLS, health checks, monitoring | 2-3 days | unchanged |
| 3. Customer UX | Landing-page section, in-admin "AI Connections" tab | 2 days | unchanged |
| 4. Docs + launch | README, article #2 update, marketing announce | 2 days | unchanged |

**Total: ~9-10 days of focused work** — modestly faster than the original 2-3 weeks, because the SDK does more than I expected and the auth augmentation works cleanly.

## Reproducing the spike

```bash
git checkout spike/http-transport
npm install
npm run build

BUGSPOTTER_BASE_URL=https://api.kz.bugspotter.io \
  PORT=8765 \
  node dist/server-http.js
```

Then in another shell:

```bash
KEY="bgs_xxx"
PROJECT="<uuid>"

# initialize, capture Mcp-Session-Id header
SID=$(curl -sSi -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Project-ID: $PROJECT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# initialized notification
curl -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

# call a tool
curl -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_bugs","arguments":{"limit":3}}}'
```
