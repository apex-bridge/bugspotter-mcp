import type { ToolDefinition } from '../types.js';

interface SearchArgs {
  query: string;
  project_id?: string;
  mode?: 'fast' | 'smart';
  limit?: number;
}

const SEARCH_FIELDS = [
  'id',
  'bug_id',
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

function thinSearchHit(hit: unknown): Record<string, unknown> {
  if (!hit || typeof hit !== 'object') return {};
  const src = hit as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SEARCH_FIELDS) {
    if (k in src) out[k] = src[k];
  }
  // If upstream gave no excerpt but did give description, synthesize a short one.
  if (!('excerpt' in out) && typeof src.description === 'string') {
    out.excerpt =
      src.description.length > EXCERPT_MAX
        ? src.description.slice(0, EXCERPT_MAX) + '…'
        : src.description;
  }
  return out;
}

export const searchBugs: ToolDefinition<SearchArgs> = {
  name: 'search_bugs',
  description:
    'Search bugs in a BugSpotter project using natural language. Returns thin ranked records (id, title, status, priority, excerpt, score) — for full bug content, follow up with get_bug.',
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
