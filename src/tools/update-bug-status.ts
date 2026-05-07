import type { ToolDefinition } from '../types.js';

interface UpdateBugStatusArgs {
  bug_id: string;
  status?: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  note?: string;
}

export const updateBugStatus: ToolDefinition<UpdateBugStatusArgs> = {
  name: 'update_bug_status',
  description:
    'Update the status or priority of a bug. Use sparingly — agents should not auto-resolve without explicit user instruction.',
  inputSchema: {
    type: 'object',
    properties: {
      bug_id: { type: 'string' },
      status: { type: 'string', enum: ['open', 'in-progress', 'resolved', 'closed'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      note: {
        type: 'string',
        maxLength: 5000,
        description: 'Reason for the status change. Sent upstream as resolution_notes.',
      },
    },
    required: ['bug_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const path = `/api/v1/reports/${args.bug_id}`;
    const body: Record<string, unknown> = {};
    if (args.status) body.status = args.status;
    if (args.priority) body.priority = args.priority;
    if (args.note) body.resolution_notes = args.note;
    const data = await ctx.client.request<unknown>('PATCH', path, { body });
    return { data, resultCount: 1, upstreamUrl: `PATCH ${path}` };
  },
};
