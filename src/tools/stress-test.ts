import type { ToolDefinition } from '../types.js';

interface StressTestArgs {
  target_kb: number;
  shape?: 'records' | 'string';
}

const MAX_KB = 256; // Cap to prevent abuse — well above any agent's context budget.

/**
 * Internal stress-test tool that returns a controlled-size payload.
 *
 * Purpose: validate how different MCP clients / agent harnesses behave when
 * a tool returns a response too large for the agent's context budget. Some
 * harnesses save the overflow to disk and recover via a sub-agent + grep;
 * others feed the bytes raw into the model's context, which can produce
 * silent degradation. This tool lets us trigger that condition on demand.
 *
 * The leading underscore in the name is a convention to mark the tool as
 * internal-test; it is still callable by any client with a valid API key,
 * but the description signals "do not include in user-facing tool lists."
 *
 * Two payload shapes:
 *   - "records" (default): an array of repeating bug-like JSON objects,
 *     so the harness sees a realistic-ish response (matches the production
 *     overflow shape from list_bugs).
 *   - "string": a single long string field, useful for testing how harnesses
 *     handle large primitive values vs structured arrays.
 */
export const stressTest: ToolDefinition<StressTestArgs> = {
  name: '_stress_test',
  description:
    'INTERNAL TEST TOOL. Returns a payload of approximately target_kb kilobytes. Used to test how MCP clients handle oversized tool responses. Not for production use.',
  inputSchema: {
    type: 'object',
    properties: {
      target_kb: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_KB,
        description: `Approximate size of the returned payload in kilobytes (capped at ${MAX_KB}).`,
      },
      shape: {
        type: 'string',
        enum: ['records', 'string'],
        default: 'records',
        description: 'Payload shape: "records" returns an array of bug-like objects, "string" returns a single long string.',
      },
    },
    required: ['target_kb'],
    additionalProperties: false,
  },
  async handler(args) {
    const targetKb = Math.min(Math.max(args.target_kb, 1), MAX_KB);
    const shape = args.shape ?? 'records';
    const targetBytes = targetKb * 1024;

    if (shape === 'string') {
      // Single long string — tests how harnesses handle a large primitive value.
      const text = 'x'.repeat(targetBytes);
      return {
        data: { value: text, target_kb: targetKb, actual_bytes: text.length },
        resultCount: 1,
        upstreamUrl: 'internal:_stress_test',
      };
    }

    // Records shape: repeating bug-like objects so the response resembles
    // the list_bugs overflow scenario from the post-mortem.
    const TEMPLATE = {
      id: '00000000-0000-0000-0000-000000000000',
      title: 'Stress-test record',
      description: 'A'.repeat(900), // ~900-byte description per record
      status: 'open',
      priority: 'medium',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      project_id: '00000000-0000-0000-0000-000000000000',
      console_errors: Array.from({ length: 5 }, (_, i) => ({
        level: 'error',
        message: `simulated console error ${i}`,
        timestamp: '2026-06-01T00:00:00.000Z',
      })),
      network_logs: Array.from({ length: 5 }, (_, i) => ({
        url: `https://example.com/api/${i}`,
        status: 500,
        duration_ms: 100,
      })),
    };

    const perRecordBytes = JSON.stringify(TEMPLATE).length;
    const count = Math.max(1, Math.ceil(targetBytes / perRecordBytes));
    const records = Array.from({ length: count }, (_, i) => ({
      ...TEMPLATE,
      id: `stress-test-${String(i).padStart(8, '0')}`,
    }));

    return {
      data: {
        data: records,
        meta: { count, target_kb: targetKb, per_record_bytes: perRecordBytes },
      },
      resultCount: count,
      upstreamUrl: 'internal:_stress_test',
    };
  },
};
