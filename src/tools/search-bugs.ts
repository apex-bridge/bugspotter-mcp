import type { ToolDefinition } from '../types.js';

interface SearchArgs {
  query: string;
  project_id?: string;
  mode?: 'fast' | 'smart';
  limit?: number;
}

export const searchBugs: ToolDefinition<SearchArgs> = {
  name: 'search_bugs',
  description:
    'Search bugs in a BugSpotter project using natural language. Returns ranked results with title, status, priority, excerpt, and bug_id.',
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
    const data = await ctx.client.request<{ results?: unknown[] }>('POST', path, {
      body: {
        query: args.query,
        mode: args.mode ?? 'fast',
        limit: args.limit ?? 10,
      },
    });
    return {
      data,
      resultCount: Array.isArray(data?.results) ? data.results.length : null,
      upstreamUrl: `POST ${path}`,
    } as const;
  },
};
