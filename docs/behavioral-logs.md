# Behavioral logs

Every tool call writes one line to `${LOG_DIR}/calls-YYYY-MM-DD.jsonl`. This is the data substrate for understanding *how* AI agents reason about a bug-tracker — which tools they pick, which they over-use, where they fail.

If you're using this server for the article research described in [`PROMPT-build.md`](../../experiments/mcp-bug-server/PROMPT-build.md), this file is the recipe book.

---

## Schema

One line, one record. Always 13 fields, always flat:

| Field | Type | Notes |
|---|---|---|
| `timestamp` | string (ISO 8601) | Wall-clock at dispatch start. UTC. |
| `session_id` | string \| null | MCP session UUID if available. The SDK doesn't always expose one — `null` is common, not an error. |
| `agent_hint` | string | `"<clientName>-<clientVersion>"` from the `clientInfo` of the MCP `initialize` handshake. `"unknown"` when the client omits it. |
| `tool` | string | One of the 6 tool names. |
| `args` | object | The full input *after* PII redaction (`search_bugs` and `ask` only). |
| `args_size_bytes` | integer | UTF-8 byte length of the *original* args (before redaction). |
| `result_status` | `"ok"` \| `"error"` | |
| `result_count` | integer \| null | List length when the response is list-shaped; `1` for singletons; `null` when not meaningful. |
| `result_size_bytes` | integer | UTF-8 byte length of the JSON result returned to the agent. `0` on error. |
| `duration_ms` | integer | Wall-clock from dispatch entry to log write. |
| `error_class` | string \| null | `"validation"`, `"upstream_4xx"`, `"upstream_5xx"`, `"timeout"`, `"network"`, or `null` on success. |
| `error_message` | string \| null | Free-form. Includes upstream HTTP status when applicable. |
| `upstream_url` | string \| null | `"METHOD /path"`. `null` on validation errors (no upstream call was made). |

### Sample records

Successful `search_bugs`:
```json
{"timestamp":"2026-05-06T12:34:56.789Z","session_id":null,"agent_hint":"claude-code-1.0.0","tool":"search_bugs","args":{"query":"login broken","mode":"fast","limit":10},"args_size_bytes":48,"result_status":"ok","result_count":5,"result_size_bytes":2340,"duration_ms":145,"error_class":null,"error_message":null,"upstream_url":"POST /api/v1/intelligence/projects/abc/search"}
```

Validation failure (no upstream call made):
```json
{"timestamp":"2026-05-06T12:35:01.012Z","session_id":null,"agent_hint":"claude-desktop-0.7.4","tool":"update_bug_status","args":{"status":"resolved"},"args_size_bytes":22,"result_status":"error","result_count":null,"result_size_bytes":0,"duration_ms":2,"error_class":"validation","error_message":"update_bug_status must have required property 'bug_id'","upstream_url":null}
```

Upstream 503 after retries exhausted:
```json
{"timestamp":"2026-05-06T12:35:30.500Z","session_id":null,"agent_hint":"cursor-0.42.1","tool":"get_bug","args":{"bug_id":"abc"},"args_size_bytes":18,"result_status":"error","result_count":null,"result_size_bytes":0,"duration_ms":4250,"error_class":"upstream_5xx","error_message":"BugSpotter 503: down","upstream_url":"GET /api/v1/reports/abc"}
```

PII-redacted `ask`:
```json
{"timestamp":"2026-05-06T12:36:00.000Z","session_id":null,"agent_hint":"claude-code-1.0.0","tool":"ask","args":{"question":"Why does <redacted> see 401s?"},"args_size_bytes":58,"result_status":"ok","result_count":1,"result_size_bytes":890,"duration_ms":2100,"error_class":null,"error_message":null,"upstream_url":"POST /api/v1/intelligence/projects/abc/ask"}
```

Note `args_size_bytes` is the *pre-redaction* length — useful for spotting whether a redaction happened (compare to size of `args` field after the fact).

---

## Analysis recipes

All examples assume `LOG_DIR=./logs` and use [`jq`](https://stedolan.github.io/jq/). Aggregate across days with `cat logs/calls-*.jsonl | jq …`.

### Tool usage distribution

```bash
jq -r '.tool' logs/calls-*.jsonl | sort | uniq -c | sort -rn
```

What it tells you: which tools the agent reaches for. If `get_bug` >> `list_bugs` + `search_bugs`, the agent is over-drilling. If `ask` ≈ 0, the agent isn't using RAG at all (your tool descriptions probably aren't selling it).

### Error rate by tool

```bash
jq -r 'select(.result_status=="error") | .tool' logs/calls-*.jsonl \
  | sort | uniq -c | sort -rn
```

Pair with totals:

```bash
jq -r '[.tool, .result_status] | @tsv' logs/calls-*.jsonl \
  | sort | uniq -c
```

### Validation failures (the agent picked wrong arg shapes)

```bash
jq 'select(.error_class=="validation") | {tool, error_message, args}' logs/calls-*.jsonl
```

Each line is an agent mistake — usually a hint that the tool's `inputSchema` description should be tightened. Common patterns:

- Missing `bug_id` on `update_bug_status` → the description doesn't make it clear bug_id isn't optional.
- `mode: "deep"` on `search_bugs` → tool description should explicitly enumerate `fast` and `smart`.

### p50 / p95 latency by tool

```bash
jq -r '[.tool, .duration_ms] | @tsv' logs/calls-*.jsonl \
  | awk -F'\t' '
      { d[$1] = d[$1] " " $2 }
      END {
        for (t in d) {
          n = split(d[t], a, " ")
          asort(a)
          p50 = a[int(n*0.5)]; p95 = a[int(n*0.95)]
          printf "%-22s p50=%4dms  p95=%5dms  n=%d\n", t, p50, p95, n-1
        }
      }
  '
```

A `search_bugs mode=smart` p95 above ~3 s means the LLM rerank step is slow — usually Ollama is under-resourced, not the MCP server.

### Result-count distribution for search_bugs

```bash
jq 'select(.tool=="search_bugs" and .result_status=="ok") | .result_count' \
  logs/calls-*.jsonl | sort -n | uniq -c
```

Lots of zeros means the agent's queries are too narrow / too literal. Lots of values clamped at the `limit` ceiling means the agent is asking too broadly and probably not following up with `get_bug` on the right candidate.

### "Drill chains" — search_bugs followed by get_bug

```bash
jq -r '[.timestamp, .tool, .args.bug_id // .args.query // ""] | @tsv' \
  logs/calls-*.jsonl \
  | awk -F'\t' '
      $2=="search_bugs" { last_search=$1; last_query=$3 }
      $2=="get_bug" && last_search { print last_query " → " $3; last_search="" }
  '
```

Each line is a search→drill pair. High-quality drills (the agent picks one bug from search results and inspects it) look healthy; chains where every search is followed by 5+ `get_bug`s mean the agent is hedging.

### Agent comparison

```bash
jq -r '[.agent_hint, .tool, .result_status] | @tsv' logs/calls-*.jsonl \
  | sort | uniq -c | awk '{printf "%6d  %s\n", $1, substr($0, index($0,$2))}'
```

Splits tool usage by client. Useful when the same BugSpotter is connected to multiple agents (Claude Code, Claude Desktop, Cursor) — they have measurably different reasoning styles.

### Catastrophic-failure lookback

```bash
jq 'select(.error_class=="upstream_5xx" or .error_class=="timeout")' \
  logs/calls-*.jsonl
```

If your BugSpotter had a brownout and the agent kept hammering, this is what the recovery story looks like. Compare against your BugSpotter access log to attribute downtime.

---

## Privacy boundaries

Two things the logs deliberately *do not* contain:

1. **The bug content the agent saw.** `result_size_bytes` is logged; the result body is not. If you want to reconstruct what the agent reasoned over, replay the call against the live BugSpotter — don't expect it from the logs.
2. **Free-text PII in `query` / `question`.** Emails, JWT-shaped strings, and credit-card-shaped digit runs are replaced with `<redacted>` before the line is written. This is best-effort, not a DLP guarantee.

If you need stricter handling (no logs at all, or hashed args), set `LOG_DIR=/dev/null`-equivalent — the writer no-ops cleanly when the dir is unwritable.

---

## What the logs are *not* good for

- **Real-time alerting.** Daily rotation means a long-running dispatch can write to today's file even if your monitoring is watching yesterday's. Use the upstream BugSpotter logs for SLO alerting.
- **Reconstructing exact agent reasoning.** You see the tool calls, not the agent's internal scratchpad. Combine with the agent's transcript log (Claude Code stores these under `~/.claude/projects/`) for full causality.
- **User attribution.** `agent_hint` identifies the client *software*, not the user. There's no field for "which human typed the prompt." Don't assume otherwise.
