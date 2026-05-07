import type { ToolDefinition } from '../types.js';

interface FindSimilarArgs {
  bug_id: string;
  project_id?: string;
  threshold?: number;
  limit?: number;
}

export const findSimilar: ToolDefinition<FindSimilarArgs> = {
  name: 'find_similar',
  description:
    'Find bugs similar to a given bug via embedding similarity. Use before creating a new bug to check for duplicates.',
  inputSchema: {
    type: 'object',
    properties: {
      bug_id: { type: 'string' },
      project_id: {
        type: 'string',
        description: 'Project UUID. Omit to use the default project from server config.',
      },
      threshold: { type: 'number', default: 0.7, minimum: 0, maximum: 1 },
      limit: { type: 'integer', default: 5, maximum: 20 },
    },
    required: ['bug_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const projectId = args.project_id ?? ctx.config.defaultProject;
    if (!projectId) {
      throw new Error('project_id is required (no BUGSPOTTER_DEFAULT_PROJECT configured).');
    }
    const path = `/api/v1/intelligence/projects/${projectId}/bugs/${args.bug_id}/similar`;
    const params: Record<string, unknown> = {};
    if (args.threshold !== undefined) params.threshold = args.threshold;
    if (args.limit !== undefined) params.limit = args.limit;
    const data = await ctx.client.request<{ results?: unknown[] }>('GET', path, { params });
    return {
      data,
      resultCount: Array.isArray(data?.results) ? data.results.length : null,
      upstreamUrl: `GET ${path}`,
    };
  },
};
