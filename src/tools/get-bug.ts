import type { ToolDefinition } from '../types.js';

interface GetBugArgs {
  bug_id: string;
}

export const getBug: ToolDefinition<GetBugArgs> = {
  name: 'get_bug',
  description:
    'Fetch full details of a single bug: title, description, console errors, network logs, stack trace, status, priority, timestamps.',
  inputSchema: {
    type: 'object',
    properties: {
      bug_id: { type: 'string' },
    },
    required: ['bug_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const path = `/api/v1/reports/${args.bug_id}`;
    const data = await ctx.client.request<unknown>('GET', path);
    return { data, resultCount: 1, upstreamUrl: `GET ${path}` };
  },
};
