import assert from 'node:assert/strict';
import test from 'node:test';

import { ReActApprovalReviewer } from './approval-reviewer.js';

const request = {
  approvalId: 'apv_1', runId: 'run_1', sessionId: 'sess_1', userRequest: 'Write the requested file',
  environment: { approval_mode: 'ai_review' as const, system: { platform: 'windows' as const, arch: 'x64', shell: 'pwsh' }, workspace: { root: 'E:\\work' } },
  origin: { kind: 'local' as const }, tool: 'write_file', input: { path: 'a.md', token: 'secret', content: 'x'.repeat(700) },
};

test('Responses AI reviewer parses a structured decision and redacts its input', async () => {
  const originalFetch = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ output_text: '{"decision":"approved","reason":"Requested file"}' }), { status: 200 });
  };
  try {
    const reviewer = new ReActApprovalReviewer(() => ({
      type: 'openai-responses', apiKey: 'key', apiBaseUrl: 'http://example.test/v1', model: 'test', timeoutMs: 1000,
    }));
    assert.deepEqual(await reviewer.review(request, {}), { decision: 'approved', reason: 'Requested file' });
    assert.equal(body.includes('secret'), false);
    assert.equal(body.includes('[REDACTED]'), true);
    assert.equal(body.includes('x'.repeat(700)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI reviewer rejects invalid structured output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: '{"decision":"unknown"}' }), { status: 200 });
  try {
    const reviewer = new ReActApprovalReviewer(() => ({
      type: 'openai-responses', apiKey: 'key', apiBaseUrl: 'http://example.test/v1', model: 'test', timeoutMs: 1000,
    }));
    await assert.rejects(() => reviewer.review(request, {}), /invalid decision/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
