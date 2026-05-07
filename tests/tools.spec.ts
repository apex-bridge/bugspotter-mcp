import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import addFormatsImport from 'ajv-formats';

type AddFormatsFn = (ajv: Ajv) => void;
const addFormats: AddFormatsFn =
  (addFormatsImport as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsImport as unknown as AddFormatsFn);
import { TOOLS } from '../src/tools/index.js';
import { redactArgs, redactPii } from '../src/instrumentation/logger.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

describe('tool registry', () => {
  it('registers exactly 6 tools with unique names', () => {
    expect(TOOLS).toHaveLength(6);
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(6);
    expect(names.sort()).toEqual(
      ['ask', 'find_similar', 'get_bug', 'list_bugs', 'search_bugs', 'update_bug_status'].sort()
    );
  });

  it('every tool has a description and a JSON-schema-valid inputSchema', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
    }
  });
});

describe('search_bugs schema', () => {
  const validate = ajv.compile(TOOLS.find((t) => t.name === 'search_bugs')!.inputSchema);

  it('accepts the minimal valid payload', () => {
    expect(validate({ query: 'login broken' })).toBe(true);
  });

  it('rejects missing query', () => {
    expect(validate({})).toBe(false);
  });

  it('rejects unknown mode', () => {
    expect(validate({ query: 'x', mode: 'turbo' })).toBe(false);
  });

  it('rejects limit above max', () => {
    expect(validate({ query: 'x', limit: 999 })).toBe(false);
  });
});

describe('list_bugs schema', () => {
  const validate = ajv.compile(TOOLS.find((t) => t.name === 'list_bugs')!.inputSchema);

  it('accepts in-progress status', () => {
    expect(validate({ status: 'in-progress' })).toBe(true);
  });

  it('rejects from_date that is not a date', () => {
    expect(validate({ from_date: 'last tuesday' })).toBe(false);
  });
});

describe('update_bug_status schema', () => {
  const validate = ajv.compile(TOOLS.find((t) => t.name === 'update_bug_status')!.inputSchema);

  it('accepts a status transition with a note', () => {
    expect(
      validate({ bug_id: 'abc', status: 'resolved', note: 'fixed in #123' })
    ).toBe(true);
  });

  it('rejects unknown status', () => {
    expect(validate({ bug_id: 'abc', status: 'wontfix' })).toBe(false);
  });

  it('requires bug_id', () => {
    expect(validate({ status: 'resolved' })).toBe(false);
  });
});

describe('ask schema', () => {
  const validate = ajv.compile(TOOLS.find((t) => t.name === 'ask')!.inputSchema);

  it('accepts question + context array + temperature', () => {
    expect(
      validate({
        question: 'Which bugs mention CORS?',
        context: ['user is on Chrome'],
        temperature: 0.5,
      })
    ).toBe(true);
  });

  it('rejects context as a string', () => {
    expect(validate({ question: 'x', context: 'not an array' })).toBe(false);
  });

  it('rejects temperature outside [0, 2]', () => {
    expect(validate({ question: 'x', temperature: 5 })).toBe(false);
  });
});

describe('serialization (regression guard)', () => {
  it('serializeResult emits compact JSON — no indentation', async () => {
    const { serializeResult } = await import('../src/instrumentation/logger.js');
    const out = serializeResult({ a: 1, b: { c: [2, 3] } });
    // No newlines, no double-spaces — would only appear if someone reverted
    // to JSON.stringify(data, null, 2) for a debug session and forgot.
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/ {2,}/);
    expect(out).toBe('{"a":1,"b":{"c":[2,3]}}');
  });
});

describe('defensive projections (null/undefined hits)', () => {
  it('list_bugs returns empty array when upstream sends non-object items', async () => {
    const listBugsTool = TOOLS.find((t) => t.name === 'list_bugs')!;
    // Build a minimal ctx that returns the bad payload and traps no HTTP call.
    const fakeCtx = {
      client: {
        request: async () => ({ data: [null, undefined, 'a string', 42, true] }),
      },
      logger: { write: async () => {} },
      config: { defaultProject: 'p' },
    } as Parameters<typeof listBugsTool.handler>[1];
    const result = await listBugsTool.handler({}, fakeCtx);
    const bugs = (result.data as { data: Record<string, unknown>[] }).data;
    expect(bugs).toHaveLength(5);
    // Each non-object input should map to an empty {} — survives, doesn't crash.
    for (const b of bugs) expect(b).toEqual({});
  });

  it('search_bugs survives non-object hits in upstream results array', async () => {
    const searchTool = TOOLS.find((t) => t.name === 'search_bugs')!;
    const fakeCtx = {
      client: {
        request: async () => ({ results: [null, 'oops', { id: 'real', title: 't', status: 'open', priority: 'low' }] }),
      },
      logger: { write: async () => {} },
      config: { defaultProject: 'p' },
    } as Parameters<typeof searchTool.handler>[1];
    const result = await searchTool.handler({ query: 'x' }, fakeCtx);
    const hits = (result.data as { results: Record<string, unknown>[] }).results;
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({});
    expect(hits[1]).toEqual({});
    expect(hits[2]!.id).toBe('real');
  });
});

describe('PII redaction', () => {
  it('redacts emails', () => {
    expect(redactPii('contact alice@example.com please')).toBe(
      'contact <redacted> please'
    );
  });

  it('redacts JWT-like strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123';
    expect(redactPii(`token=${jwt}`)).toBe('token=<redacted>');
  });

  it('redacts credit-card-shaped numbers', () => {
    expect(redactPii('card 4111 1111 1111 1111 here')).toBe('card <redacted> here');
  });

  it('only redacts args of search_bugs and ask', () => {
    const askArgs = { question: 'reset for bob@x.io', temperature: 0.5 };
    const redacted = redactArgs('ask', askArgs) as Record<string, unknown>;
    expect(redacted.question).toBe('reset for <redacted>');
    expect(redacted.temperature).toBe(0.5);

    const getBugArgs = { bug_id: 'bob@x.io' };
    expect(redactArgs('get_bug', getBugArgs)).toEqual(getBugArgs);
  });

  it('passes through clean strings unchanged', () => {
    const clean = { query: 'login button broken on Safari', limit: 10 };
    expect(redactArgs('search_bugs', clean)).toEqual(clean);
  });
});
