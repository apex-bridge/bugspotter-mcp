# Connecting bugspotter-mcp to Claude Desktop

This guide walks through wiring the `bugspotter-mcp` server into Claude
Desktop so Claude can search bugs, open full bug cards, dedupe with
similarity search, and answer project questions inline.

The local (stdio) and hosted (HTTP) modes are covered separately —
they're independent and can be installed side-by-side.

---

## What you need

1. **Claude Desktop** (Windows / macOS) — download at
   <https://claude.ai/download>.
2. A **BugSpotter API key** starting with `bgs_…`, issued from the
   *API Keys* tab in your BugSpotter admin UI. For the hosted mode
   the key needs `reports:read` (and optionally `reports:write`),
   plus at least one project in `allowed_projects`.
3. A **project UUID** — from the admin UI or from the project page URL.
4. **Node.js 20+** on `PATH` if you'll use stdio or the `mcp-remote`
   bridge.

---

## Two ways to wire it up

| Mode | When to pick it | How it works |
|---|---|---|
| **Stdio (local)** | You have the `bugspotter-mcp` repo cloned and direct access to BugSpotter. Lowest latency, no network hop. | Claude Desktop spawns a local Node process with the API key in environment variables. |
| **HTTP (hosted)** | You're using a shared endpoint such as `https://mcp.kz.bugspotter.io` or an internal corporate one. No local clone needed. | Claude Desktop spawns the `mcp-remote` bridge, which forwards MCP traffic over HTTPS with an `Authorization: Bearer …` header. |

You can configure both at the same time — they appear in Claude Desktop
as two distinct connectors.

---

## Where the config file lives

Claude Desktop reads `claude_desktop_config.json`. The exact path
depends on how it was installed:

| Install path | Config path |
|---|---|
| Windows · Microsoft Store | `%LOCALAPPDATA%\Packages\Claude_<package-id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| Windows · `.exe` installer from claude.ai/download | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

**Windows gotcha.** If Claude Desktop was installed from the Microsoft
Store (sandboxed app), editing `%APPDATA%\Claude\` does nothing — the
app reads from its isolated package storage. To find the right
`<package-id>`, run in PowerShell:

```powershell
Get-AppxPackage *claude* | Select-Object PackageFamilyName, InstallLocation
```

The package family name gives you the `<package-id>` to substitute in
the path above.

If the file doesn't exist, create it. The content is plain JSON with a
top-level `mcpServers` object.

---

## Mode 1. Stdio (local)

Assumes the repo is cloned and built:

```bash
git clone https://github.com/apex-bridge/bugspotter-mcp.git
cd bugspotter-mcp
npm install
npm run build
```

Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "bugspotter": {
      "command": "node",
      "args": [
        "C:/path/to/bugspotter-mcp/dist/server.js"
      ],
      "env": {
        "BUGSPOTTER_BASE_URL": "https://api.kz.bugspotter.io",
        "BUGSPOTTER_API_KEY": "bgs_<your-key>",
        "BUGSPOTTER_DEFAULT_PROJECT": "<project-uuid>",
        "LOG_DIR": "C:/path/to/bugspotter-mcp/logs"
      }
    }
  }
}
```

`BUGSPOTTER_DEFAULT_PROJECT` is optional. With it set, Claude can call
`list_bugs` / `search_bugs` / `ask` without an explicit `project_id`.

---

## Mode 2. HTTP (hosted)

Claude Desktop can't yet talk to MCP servers over HTTP with a Bearer
token directly — the built-in *Settings → Connectors → Add Custom
Connector* UI only supports OAuth at this point. So we use the
`mcp-remote` bridge: a small Node package that turns Claude's stdio
traffic into HTTPS requests.

### Step 1. Install `mcp-remote` globally

```bash
npm install -g mcp-remote
```

Using `npx mcp-remote …` in `command` theoretically works too, but on
Windows it routinely breaks because of spaces in
`C:\Program Files\nodejs\` (see *Common issues* below). Global install
eliminates that risk.

### Step 2. Find the exact path of the executable

```bash
where.exe mcp-remote    # Windows
which mcp-remote        # macOS / Linux
```

Note the path — you'll need it for `command`.

### Step 3. Declare the connector

```json
{
  "mcpServers": {
    "bugspotter-hosted": {
      "command": "C:\\nvm\\nodejs\\mcp-remote.cmd",
      "args": [
        "https://mcp.kz.bugspotter.io/mcp",
        "--header",
        "Authorization:Bearer bgs_<your-key>",
        "--header",
        "X-Project-Id:<project-uuid>"
      ]
    }
  }
}
```

Things to watch out for:

- Use the **literal** API key — not `${BUGSPOTTER_API_KEY}`. Claude
  Desktop passes args straight to the child process; it does not
  shell-expand `${VAR}` substitutions.
- The `X-Project-Id` header sets the default project for every request.
  Without it, each `list_bugs` / `search_bugs` / `ask` call has to
  pass `project_id` explicitly.
- On Windows, escape backslashes in JSON paths (`\\`).

### Step 4. Restart Claude Desktop

Fully quit the process — closing the window leaves it running in the
tray. In PowerShell:

```powershell
Get-Process Claude -ErrorAction SilentlyContinue | Stop-Process
```

Then relaunch. Config is only read at startup.

### Step 5. Verify the connection

In Claude Desktop, open *Settings → Developer*. You should see
`bugspotter-hosted` with status `running`. If the status is red,
check the log file in the same config folder
(`logs/mcp-server-bugspotter-hosted.log`).

---

## Available tools

Once connected, Claude has access to six operations:

| Tool | What it does | Required args | Useful options |
|---|---|---|---|
| `list_bugs` | Thin list for triage/overview — id, title, status, priority, timestamps | — (if `BUGSPOTTER_DEFAULT_PROJECT` env var or `X-Project-Id` header is set) | `status`, `priority`, `from_date`, `to_date`, `limit` (≤100) |
| `search_bugs` | Ranked natural-language search; returns thin cards with excerpt + score | `query` | `mode`: `fast` (vectors only) or `smart` (vectors + LLM rerank); `limit` (≤50) |
| `get_bug` | Full bug card: description, console errors, network logs, stack | `bug_id` | — |
| `find_similar` | Embedding-similarity neighbours — use before filing a new bug to avoid duplicates | `bug_id` | `threshold` (0–1, default 0.7), `limit` (≤20) |
| `ask` | RAG question over a project: LLM answer with citations to specific bugs | `question` | `context[]`, `temperature`, `max_tokens` |
| `update_bug_status` | Updates `status` and/or `priority`; optional `note` maps to `resolution_notes` upstream | `bug_id` | `status`, `priority`, `note` (≤5000 chars) |

---

## How to use it

Just write to Claude in natural language — it picks the right tool
from your phrasing. A few examples:

| Goal | What to type |
|---|---|
| Open-bug overview | *"Show me 5 recent open bugs"* |
| Content search | *"Find bugs related to the vacancy search"* |
| Full bug details | *"Get bug f8278dd4-1b79-4383-a39e-51aab5c2f8ae"* |
| Duplicate check | *"Are there any bugs similar to … ?"* |
| Analytics question | *"What are the most common failure modes in this project?"* |
| Status change | *"Close bug … with note: fixed in PR #123"* |

Claude will ask for confirmation before each tool call (once per tool
per session, unless you tick *Always allow*).

If both connectors are configured (`bugspotter` and `bugspotter-hosted`),
Claude may pick either one. To force a specific one, say so explicitly:
*"Using the bugspotter-hosted connector, list the latest bugs…"*.

---

## Common issues

### `Server disconnected` immediately after start

Open `logs/mcp-server-bugspotter-hosted.log` in the Claude config
folder. Typical causes:

- **`'C:\Program' is not recognized…`** — Windows chokes on spaces in
  the Node.js path. Fix: install `mcp-remote` globally and use a
  space-free path (`C:\nvm\nodejs\mcp-remote.cmd`) instead of `npx`.
  See Mode 2, Step 1.
- **`401 Unauthorized`** — the key is invalid or expired. Check that
  the key was copied in full (no line breaks), starts with `bgs_`, and
  isn't revoked in the admin UI.
- **`404`** — wrong URL. The hosted endpoint always ends with `/mcp`.

### DNS returns a stale address

If you see admin-UI HTML instead of JSON, your local DNS cache or
home router is holding a stale wildcard record. Flush it:

```powershell
ipconfig /flushdns
```

And check via a public resolver:

```powershell
nslookup mcp.kz.bugspotter.io 8.8.8.8
```

If the public resolver shows the correct CNAME chain to `*.fly.dev`
but the local one returns an old IP, reboot the home router or switch
to DNS-over-HTTPS.

### Tool fires but returns `project_id is required`

The connector has no default project set. Either add the
`X-Project-Id` header (Mode 2, Step 3), or include the project ID
explicitly in every request: *"In project …, list the bugs"*.

### Custom Connectors UI demands OAuth, but our server uses Bearer

This is a current limitation of the built-in Claude Desktop connector
UI (in beta). Use the JSON-config path with the `mcp-remote` bridge,
as described in Mode 2.

---

## Security

- The API key is stored in the local config file as plain text.
  Protect the file with OS permissions; don't commit it to git.
- The hosted endpoint isolates tenants by key — one client's session
  cannot see another's data, even with different keys.
- For CI / automation, issue a separate key with `reports:read` only
  (no write), scoped to specific `allowed_projects`.

---

## Where to go next

- [docs/architecture.md](architecture.md) — server design, request
  lifecycle, design decisions.
- [docs/use-cases.md](use-cases.md) — concrete agent workflows.
- [docs/troubleshooting.md](troubleshooting.md) — extended diagnostic
  recipes.
- [docs/claude-desktop-ru.md](claude-desktop-ru.md) — Russian version
  of this guide.
