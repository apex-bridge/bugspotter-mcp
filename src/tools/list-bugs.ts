import type { ToolDefinition } from '../types.js';

interface ListBugsArgs {
  project_id?: string;
  status?: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  from_date?: string;
  to_date?: string;
  limit?: number;
}

// Fields kept in list-mode. Heavy fields (description, metadata, console
// errors, network logs, stack traces, replays) are dropped — agents must
// use get_bug to drill into a specific bug. This keeps a list of 20 bugs
// inside a single tool-result token budget.
const LIST_FIELDS = ['id', 'title', 'status', 'priority', 'created_at', 'project_id'] as const;

function thinBug(bug: unknown): Record<string, unknown> {
  if (!bug || typeof bug !== 'object') return {};
  const src = bug as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of LIST_FIELDS) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

export const listBugs: ToolDefinition<ListBugsArgs> = {
  name: 'list_bugs',
  description:
    'List bugs in a project with filters. Returns thin records (id, title, status, priority, created_at, project_id) — for full bug content, follow up with get_bug. Use for triage/overview, not for searching by content (use search_bugs for that).',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      status: { type: 'string', enum: ['open', 'in-progress', 'resolved', 'closed'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      from_date: { type: 'string', format: 'date', description: 'Maps to created_after upstream.' },
      to_date: { type: 'string', format: 'date', description: 'Maps to created_before upstream.' },
      limit: { type: 'integer', default: 20, maximum: 100 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const path = '/api/v1/reports';
    const params: Record<string, unknown> = {};
    const projectId = args.project_id ?? ctx.config.defaultProject;
    if (projectId) params.project_id = projectId;
    if (args.status) params.status = args.status;
    if (args.priority) params.priority = args.priority;
    if (args.from_date) params.created_after = args.from_date;
    if (args.to_date) params.created_before = args.to_date;
    params.limit = args.limit ?? 20;
    const upstream = await ctx.client.request<{ data?: unknown[]; pagination?: unknown }>(
      'GET',
      path,
      { params }
    );
    const bugs = Array.isArray(upstream?.data) ? upstream.data.map(thinBug) : [];
    return {
      data: { data: bugs, pagination: upstream?.pagination },
      resultCount: bugs.length,
      upstreamUrl: `GET ${path}`,
    };
  },
};
