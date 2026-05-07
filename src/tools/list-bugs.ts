import type { ToolDefinition } from '../types.js';

interface ListBugsArgs {
  project_id?: string;
  status?: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  from_date?: string;
  to_date?: string;
  limit?: number;
}

export const listBugs: ToolDefinition<ListBugsArgs> = {
  name: 'list_bugs',
  description:
    'List bugs in a project with filters. Use for triage/overview, not for searching by content (use search_bugs for that).',
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
    const data = await ctx.client.request<{ data?: unknown[] }>('GET', path, { params });
    return {
      data,
      resultCount: Array.isArray(data?.data) ? data.data.length : null,
      upstreamUrl: `GET ${path}`,
    };
  },
};
