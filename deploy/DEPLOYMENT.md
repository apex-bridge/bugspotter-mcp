# Deployment

End-to-end walkthrough for running `bugspotter-mcp` as a hosted, multi-tenant endpoint at a public hostname (e.g. `mcp.kz.bugspotter.io`).

The `bugspotter-mcp` HTTP server is a stateless-per-process Express app. Three deployment shapes are supported:

| Shape | When | What you run |
|---|---|---|
| **Standalone with Caddy** | You don't already run a reverse proxy on this host. Caddy handles TLS via Let's Encrypt automatically. | `docker compose up -d` from `deploy/` |
| **Standalone behind nginx** | You already run nginx + certbot. | Deploy the container behind your nginx, paste `deploy/nginx.conf` |
| **Sidecar in existing BugSpotter compose** | The MCP container should join the same network as a self-hosted BugSpotter. | `docker compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d` |

---

## Prerequisites

- A host with Docker + Compose v2 installed
- A domain you control with an A/AAAA record pointing at the host (`mcp.kz.bugspotter.io` → host IP)
- An existing BugSpotter instance reachable from the host (SaaS at `api.kz.bugspotter.io` or self-hosted)
- An email address Let's Encrypt can use for renewal warnings — `info@bugspotter.io` is fine

---

## Standalone with Caddy (recommended for a fresh host)

This is the path that gets you from "fresh VM" to "agent-callable endpoint" in about 5 minutes.

```bash
# 1. Get the code
git clone https://github.com/apex-bridge/bugspotter-mcp.git
cd bugspotter-mcp/deploy

# 2. Configure
cp .env.example .env
# Edit .env:
#   MCP_DOMAIN=mcp.kz.bugspotter.io
#   ACME_EMAIL=info@bugspotter.io
#   BUGSPOTTER_BASE_URL=https://api.kz.bugspotter.io
#   MCP_LOG_FORMAT=json   (optional but recommended for prod)

# 3. Bring it up
docker compose up -d

# 4. Verify
curl https://mcp.kz.bugspotter.io/health
# → {"ok":true,"sessions":0}
```

That's the deploy. Caddy handles cert provisioning + renewal; the MCP container handles auth and dispatch.

The first hit to the domain may take ~30 seconds while Caddy obtains the certificate. Subsequent traffic is fast.

---

## Behind your existing nginx

If you already terminate TLS with nginx + certbot:

```bash
# 1. Get the code
git clone https://github.com/apex-bridge/bugspotter-mcp.git
cd bugspotter-mcp

# 2. Run the container, exposing 8080 only on localhost
docker run -d --name bugspotter-mcp \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e BUGSPOTTER_BASE_URL=https://api.kz.bugspotter.io \
  -e MCP_LOG_FORMAT=json \
  -v bugspotter-mcp-logs:/var/log/bugspotter-mcp \
  $(docker build -q .)

# 3. Drop deploy/nginx.conf into /etc/nginx/conf.d/bugspotter-mcp.conf
#    (replace MCP_DOMAIN placeholder), then:
sudo certbot --nginx -d mcp.kz.bugspotter.io
sudo systemctl reload nginx
```

Critical bits in the nginx config that **must not be changed**:

- `proxy_buffering off;` — Streamable HTTP needs SSE; nginx default buffering breaks it
- `proxy_read_timeout 600s;` — long-running tool calls (especially `ask` against Ollama) can take minutes
- `proxy_set_header Connection "";` + `proxy_http_version 1.1;` — keeps the upstream connection alive

Both are baked into [`deploy/nginx.conf`](nginx.conf); just don't strip them when you adapt the file to your stack.

---

## Sidecar mode (alongside self-hosted BugSpotter)

If you're already running BugSpotter via the [`bugspotter-deploy`](https://github.com/apex-bridge/bugspotter-deploy) compose stack, drop the MCP container into the same network:

```bash
cd bugspotter-mcp/deploy
cp .env.example .env
# Edit .env:
#   MCP_DOMAIN=mcp.kz.bugspotter.io
#   BUGSPOTTER_BASE_URL=http://bugspotter:3000   ← internal service name
#   BUGSPOTTER_NETWORK=bugspotter                ← name of the existing network
#   ACME_EMAIL=info@bugspotter.io

docker compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d
```

In this mode the embedded Caddy is disabled (the override sets the `never` profile), and the container expects to be reached via the existing BugSpotter reverse proxy. Add the equivalent of `deploy/nginx.conf` (or a Caddy block) to your existing TLS config.

---

## Health checks and observability

- **Health endpoint:** `GET /health` returns `{"ok": true, "sessions": <n>}`. No auth required. Use it for load-balancer health checks and uptime monitoring.
- **Container healthcheck:** the Dockerfile includes a `HEALTHCHECK` that hits `/health` every 30 s. `docker ps` shows a `(healthy)` indicator after the start period.
- **Lifecycle logs:** the server emits structured stdout logs (set `MCP_LOG_FORMAT=json`) for events like `listening`, `shutting down`, and `fatal`. Pick these up with `docker logs` or any log shipper that reads container stdout.
- **Behavioral logs:** every tool call writes a JSONL record to `LOG_DIR` (default `/var/log/bugspotter-mcp` inside the container, mounted as a volume). The `session_id` is `sha256(api_key)[:32]`, never the raw key. Use these for analyzing agent behavior — see [`docs/behavioral-logs.md`](../docs/behavioral-logs.md) for `jq` recipes.

---

## Smoke test against your deployment

Once it's up, this is the canonical "is the endpoint really working" test:

```bash
KEY="bgs_..."           # a real BugSpotter API key with reports:read + reports:write
PROJECT="<uuid>"        # a project the key has access to
DOMAIN="mcp.kz.bugspotter.io"

# 1. health (no auth)
curl https://$DOMAIN/health

# 2. initialize (capture Mcp-Session-Id from response headers)
SID=$(curl -sSi -X POST https://$DOMAIN/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Project-ID: $PROJECT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# 3. notifications/initialized
curl -X POST https://$DOMAIN/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

# 4. call a tool
curl -X POST https://$DOMAIN/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $KEY" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_bugs","arguments":{"limit":3}}}'
```

A real bug list comes back as SSE-wrapped JSON-RPC. If something's wrong:

| Status | Meaning | Where to look |
|---|---|---|
| 401 on `/mcp` | Missing or malformed `Authorization: Bearer bgs_*` | Client side |
| 401 on initialize with valid bearer shape | Auth pre-verify failed against upstream BugSpotter — bad key, wrong scope | BugSpotter admin: check the key is active and has `reports:read` |
| 502 on initialize | Upstream BugSpotter returned 5xx during pre-verify | Upstream is degraded; not a key problem |
| 403 on a follow-up call | The bearer doesn't match the bearer that initialized this session | Make sure your client uses the same key for the whole session |
| Connection hangs on tool call | Reverse proxy is buffering SSE | Re-check `proxy_buffering off` (nginx) / `flush_interval -1` (Caddy) |

---

## Connecting agents to the deployed endpoint

Once `mcp.kz.bugspotter.io` is up, agents connect using HTTP MCP rather than spawning a local subprocess.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "bugspotter": {
      "url": "https://mcp.kz.bugspotter.io/mcp",
      "headers": {
        "Authorization": "Bearer bgs_<your_key>",
        "X-Project-ID": "<project_uuid>"
      }
    }
  }
}
```

(Both clients support remote MCP via a `url` block; the exact key may be `transport: "http"` in some versions — check your client's docs.)

### Claude Code

```bash
claude mcp add bugspotter \
  --transport http \
  --url https://mcp.kz.bugspotter.io/mcp \
  --header "Authorization: Bearer bgs_<your_key>" \
  --header "X-Project-ID: <project_uuid>"
```

No local install required. Each user supplies their own key — the hosted server multiplexes.

---

## Operational notes

- **Sessions:** stateful, in-process. A 30-minute inactivity TTL evicts stale sessions. If you scale horizontally, sessions are sticky per process, so the load balancer must route on `Mcp-Session-Id` header.
- **Rate limiting:** the MCP server doesn't add its own — defers to BugSpotter's per-key limits. If you need pre-emptive rate limiting at the edge (to protect upstream), add it at the reverse proxy.
- **Updates:** `git pull && docker compose up -d --build` rebuilds and restarts. In-flight sessions break across restarts (clients re-handshake automatically — agents will see one transient error and recover).
- **Memory profile:** ~80–120 MB resident at idle, ~5 MB per active session. A single container handles dozens of concurrent sessions easily; horizontal-scale only when you hit hundreds.
- **Backup / state:** the container is stateless except for the JSONL behavioral log volume. Back that up if you care about the analysis stream; otherwise the container is freely replaceable.
