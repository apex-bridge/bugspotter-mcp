import type { ToolDefinition } from '../types.js';

interface AskArgs {
  question: string;
  project_id?: string;
  context?: string[];
  temperature?: number;
  max_tokens?: number;
}

export const ask: ToolDefinition<AskArgs> = {
  name: 'ask',
  description:
    'Ask a natural-language question about bugs in the project. RAG-backed: the intelligence service pulls relevant bugs as context and returns an LLM answer with citations.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      project_id: {
        type: 'string',
        description: 'Project UUID. Omit to use the default project from server config.',
      },
      context: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra context strings appended to the RAG prompt.',
      },
      temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.7 },
      max_tokens: { type: 'integer', minimum: 1, maximum: 4096 },
    },
    required: ['question'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const projectId = args.project_id ?? ctx.config.defaultProject;
    if (!projectId) {
      throw new Error('project_id is required (no BUGSPOTTER_DEFAULT_PROJECT configured).');
    }
    const path = `/api/v1/intelligence/projects/${projectId}/ask`;
    const body: Record<string, unknown> = { question: args.question };
    if (args.context !== undefined) body.context = args.context;
    if (args.temperature !== undefined) body.temperature = args.temperature;
    if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
    const data = await ctx.client.request<unknown>('POST', path, { body });
    return { data, resultCount: 1, upstreamUrl: `POST ${path}` };
  },
};
