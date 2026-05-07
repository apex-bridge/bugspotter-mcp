# Use cases

Five concrete workflows for an AI agent connected to `bugspotter-mcp`. Each shows the user prompt, the tool sequence the agent typically picks, and a sequence diagram. Sample tool calls use the actual MCP `tools/call` shape.

---

## 1. Triage: "What landed in the bug tracker yesterday?"

A daily standup question. The agent should bias toward `list_bugs` over `search_bugs` because the user is asking by *time*, not *content*.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent
    participant M as bugspotter-mcp

    U->>A: "What new bugs came in yesterday?"
    A->>M: list_bugs { from_date: "2026-05-05", to_date: "2026-05-05", limit: 50 }
    M-->>A: { data: [12 bugs] }
    A-->>U: Summary grouped by priority<br/>+ links to each bug
```

Sample call:

```json
{ "name": "list_bugs",
  "arguments": { "from_date": "2026-05-05", "to_date": "2026-05-05", "status": "open", "limit": 50 } }
```

Why not `search_bugs`? Because semantic search ranks by similarity; it would surface old bugs that *sound like* yesterday's reports. `list_bugs` is filtered by the actual `created_at` column.

---

## 2. Dedup before filing a new bug

The user is about to file a bug. The agent should check if a similar one already exists before creating a duplicate.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent
    participant M as bugspotter-mcp

    U->>A: "I want to file: 'Login button does nothing on Safari 17'"
    A->>M: search_bugs { query: "login button broken safari", mode: "smart", limit: 5 }
    M-->>A: { results: [3 candidates] }
    A->>M: get_bug { bug_id: "<top match>" }
    M-->>A: full bug detail
    alt match looks like a duplicate
        A-->>U: "Looks like #BUG-1234 covers this — comment there?"
    else no convincing match
        A-->>U: "Looks new. Here's a draft you can paste into the report form."
    end
```

Sample call sequence:

```json
{ "name": "search_bugs",
  "arguments": { "query": "login button does nothing safari 17", "mode": "smart", "limit": 5 } }
```

```json
{ "name": "get_bug",
  "arguments": { "bug_id": "9b2d…" } }
```

Why `mode: "smart"`? The user's wording ("does nothing") may not lexically match the existing bug's wording ("button is unresponsive"). LLM rerank pulls semantic matches that pure-vector similarity often misses.

Why follow up with `get_bug`? Search results include a short excerpt; deciding "duplicate vs. new" needs the full description, console errors, and stack trace.

---

## 3. Postmortem: "Did we ship a regression in the Tuesday release?"

The user wants to spot-check whether bugs spiked in a window. This is `ask` territory — the question requires reasoning across multiple bugs, not just a list.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent
    participant M as bugspotter-mcp

    U->>A: "Did the Tuesday release introduce a regression?"
    A->>M: list_bugs { from_date: "2026-05-04", limit: 100 }
    M-->>A: { data: [bugs since release] }
    A->>M: ask { question: "Of bugs filed since 2026-05-04, which clusters look like regressions caused by the auth refactor?",<br/>context: ["release notes 2026-05-04: auth middleware rewrite, ..."] }
    M-->>A: { answer: "...", citations: [bug ids] }
    A->>M: get_bug { bug_id: "<cited>" } (per citation, in parallel)
    A-->>U: Narrative answer + linked evidence
```

Why not just `ask` directly? The agent needs to scope the RAG window — feeding *all* historical bugs would dilute the analysis. A `list_bugs` with the date filter narrows the candidate set, then `ask` reasons over relevant ones (the intelligence service does its own retrieval, but knowing the time window helps the agent ground the question).

The `context` field on `ask` is the right place to inject release notes or feature-flag context the bug DB doesn't know about.

---

## 4. "Close everything that looks like the auth-token bug we fixed"

A semi-automated cleanup. The agent uses `find_similar` against a reference bug, lets the user confirm, then bulk-resolves. This is the **only** flow where `update_bug_status` is appropriate without an explicit user instruction *per bug*.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent
    participant M as bugspotter-mcp

    U->>A: "We fixed BUG-1234. Close everything similar to it."
    A->>M: find_similar { bug_id: "BUG-1234", threshold: 0.85, limit: 20 }
    M-->>A: { results: [7 similar bugs above threshold] }
    A-->>U: "Found 7. Confirm closing all of them?"
    U-->>A: "Yes"
    loop per matched bug
        A->>M: update_bug_status { bug_id, status: "closed", note: "Duplicate of BUG-1234, fixed in release X" }
    end
    A-->>U: "Closed 7 bugs."
```

Sample resolution call:

```json
{ "name": "update_bug_status",
  "arguments": {
    "bug_id": "abc-123",
    "status": "closed",
    "note": "Duplicate of BUG-1234, fixed in release 2026.05.04 (auth middleware rewrite)."
  } }
```

Threshold is the safety knob. `0.85` keeps recall conservative; `0.7` (default) would catch more loosely related bugs but increase false-positive closes. Tune up, not down.

---

## 5. Self-debugging: "Why is the build failing in CI?"

An agent debugging *its own user's* code. It pulls in BugSpotter context to check whether the failure mode is already a known issue.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent
    participant M as bugspotter-mcp

    U->>A: "CI is red. Fix it."
    A->>A: read CI logs, extract error signature
    A->>M: search_bugs { query: "<extracted error message>", mode: "fast", limit: 3 }
    alt known issue exists
        M-->>A: { results: [matching bugs] }
        A->>M: get_bug { bug_id: "<top>" }
        M-->>A: { description, resolution_notes }
        A-->>U: "This is BUG-9876, marked resolved in v2.4.1. Pinning that version fixes it."
    else nothing matches
        M-->>A: { results: [] }
        A-->>U: Continues debugging from first principles
    end
```

Why `mode: "fast"` here? The error string from CI is usually distinctive enough that vector similarity alone produces high-precision matches. `smart` mode adds latency that's not worth it inside a debugging hot loop.

---

## Anti-patterns

Patterns the agent should **not** fall into:

- **Calling `update_bug_status` without explicit user confirmation.** It's the one write tool. Default to "ask first."
- **Using `search_bugs` for time-bounded queries.** Use `list_bugs` with `from_date`/`to_date`. Search is for content; list is for filters.
- **Calling `get_bug` for every result of `search_bugs` upfront.** Search returns excerpts; only drill in when you need full detail. Logs from over-eager `get_bug` chains will show up as low-`result_count`-per-call patterns and inflate cost.
- **Looping `find_similar` on every list element.** If you're trying to find duplicate clusters across many bugs, that's not a 6-tool job — escalate to a one-off batch script.
- **Asking `ask` open-ended product-strategy questions.** It's RAG-grounded in the bug DB. "Why are users frustrated?" → use product analytics. "What bugs cluster around feature X?" → that's `ask`'s sweet spot.
