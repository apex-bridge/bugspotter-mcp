import type { ToolDefinition } from '../types.js';

interface SearchArgs {
  query: string;
  project_id?: string;
  mode?: 'fast' | 'smart';
  limit?: number;
}

// Note: `id` is normalized below from upstream's `bug_id ?? id` so callers
// always pass `result.id` straight to get_bug / find_similar — no guessing
// between the two names depending on which intelligence variant served us.
const SEARCH_FIELDS = [
  'title',
  'status',
  'priority',
  'created_at',
  'project_id',
  'excerpt',
  'score',
  'similarity',
] as const;
const EXCERPT_MAX = 240;

// Build a clean excerpt: collapse runs of whitespace (newlines, tabs,
// double-spaces from "Steps to reproduce:\n\n1. …" style descriptions)
// into single spaces, then cut on a word boundary if one exists in the
// last ~40 chars of the window. Keeps the excerpt readable to the agent
// without wasting characters on \n\n.
//
// Exported for direct unit testing — the integration tests only cover
// length, not the whitespace-collapse / word-boundary logic.
export function makeExcerpt(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_MAX) return flat;
  const cut = flat.slice(0, EXCERPT_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > EXCERPT_MAX - 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

function thinSearchHit(hit: unknown): Record<string, unknown> {
  if (!hit || typeof hit !== 'object') return {};
  const src = hit as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Normalize the bug identifier: prefer upstream `bug_id`, fall back to `id`.
  // Either may exist depending on which intelligence endpoint variant served
  // the response; agents pass `id` straight to get_bug.
  //
  // Coerce numeric ids to strings — REST contracts evolve, and a numeric
  // bug_id silently dropping the entire `id` field is a "agent silently
  // broken" failure mode (the get_bug call on the next step has nothing
  // to call with). Strings pass through; finite numbers are stringified;
  // everything else (null, object, boolean, NaN, …) is rejected.
  const rawId = src.bug_id ?? src.id;
  if (typeof rawId === 'string' && rawId) {
    out.id = rawId;
  } else if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    out.id = String(rawId);
  }

  for (const k of SEARCH_FIELDS) {
    if (k in src) out[k] = src[k];
  }

  // Excerpt handling. Upstream may send a usable excerpt, an unusable one
  // (null / empty / whitespace-only), or none at all. We want exactly one
  // outcome: either a clean string, or no `excerpt` key in the projection.
  // Never pass a null/empty upstream value through to the agent.
  const hasUsableExcerpt = typeof out.excerpt === 'string' && out.excerpt.trim().length > 0;
  if (!hasUsableExcerpt) {
    if (typeof src.description === 'string' && src.description.trim()) {
      out.excerpt = makeExcerpt(src.description);
    } else {
      delete out.excerpt; // load-bearing: drops null/empty/whitespace upstream value
    }
  }
  return out;
}

export const searchBugs: ToolDefinition<SearchArgs> = {
  name: 'search_bugs',
  description:
    'Search bugs in a BugSpotter project using natural language. Returns thin ranked records — id, title, status, priority, created_at, project_id, excerpt, and score/similarity if upstream provides one — optimized for context budget. For full bug content (description, console errors, network logs, stack trace) follow up with get_bug.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      project_id: {
        type: 'string',
        description: 'Project UUID. Omit to use the default project from server config.',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'smart'],
        default: 'fast',
        description: 'fast = vector-only, smart = vector + LLM rerank',
      },
      limit: { type: 'integer', default: 10, maximum: 50 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const projectId = args.project_id ?? ctx.config.defaultProject;
    if (!projectId) {
      throw new Error('project_id is required (no BUGSPOTTER_DEFAULT_PROJECT configured).');
    }
    const path = `/api/v1/intelligence/projects/${projectId}/search`;
    const upstream = await ctx.client.request<{ results?: unknown[] }>('POST', path, {
      body: {
        query: args.query,
        mode: args.mode ?? 'fast',
        limit: args.limit ?? 10,
      },
    });
    const hits = Array.isArray(upstream?.results) ? upstream.results.map(thinSearchHit) : [];
    return {
      data: { results: hits },
      resultCount: hits.length,
      upstreamUrl: `POST ${path}`,
    };
  },
};
