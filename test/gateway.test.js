import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.js';
import { whatsappTransport } from '../src/wacli.js';

const key = 'test-key';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const read = { type: 'function', function: { name: 'read', parameters: { type: 'object' } } };
const user = (content) => ({ role: 'user', content });

async function testGateway(t) {
  const store = await mkdtemp(join(tmpdir(), 'instinct-coder-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const complete = whatsappTransport({
    bin: fileURLToPath(new URL('./fake-wacli', import.meta.url)), chat: '+15551234567', store, pollMs: 25,
  });
  const gateway = createGateway({ key, complete, timeoutMs: 500, maxChars: 2_000 });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const baseURL = `http://127.0.0.1:${gateway.address().port}/v1`;
  return {
    baseURL,
    post: (body) => fetch(`${baseURL}/chat/completions`, {
      headers, method: 'POST', body: JSON.stringify({ model: 'instinct-whatsapp', messages: [user('Hello')], ...body }),
    }),
  };
}

test('requires a token and returns model discovery', async (t) => {
  const { baseURL } = await testGateway(t);
  assert.equal((await fetch(`${baseURL}/models`)).status, 401);
  const response = await fetch(`${baseURL}/models`, { headers });
  assert.equal((await response.json()).data[0].id, 'instinct-whatsapp');
});

test('accepts only the correlated incoming response and serializes concurrent turns', async (t) => {
  const { post } = await testGateway(t);
  const responses = await Promise.all([post({}), post({})]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    const [choice] = (await response.json()).choices;
    assert.equal(choice.message.content, 'Hello through the bridge.');
    assert.equal(choice.finish_reason, 'stop');
  }
});

test('streams a tool call, then sends its result on the next turn', async (t) => {
  const { post } = await testGateway(t);
  const task = user('READ_BRIDGE_FIXTURE /tmp/bridge-fixture.txt');
  const response = await post({ stream: true, tools: [read], messages: [task] });
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => frame.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const [role, call, finish] = events.map((event) => JSON.parse(event).choices[0]);
  assert.deepEqual(role.delta, { role: 'assistant' });
  assert.equal(finish.finish_reason, 'tool_calls');
  const [{ index, ...tool }] = call.delta.tool_calls;
  assert.equal(index, 0);
  assert.equal(tool.function.name, 'read');
  assert.deepEqual(JSON.parse(tool.function.arguments), { filePath: '/tmp/bridge-fixture.txt' });

  const second = await post({ tools: [read], messages: [task,
    { role: 'assistant', content: null, tool_calls: [tool] },
    { role: 'tool', content: 'bridge-fixture-verified', tool_call_id: tool.id },
  ] });
  assert.equal((await second.json()).choices[0].message.content, 'I read the file: bridge-fixture-verified');
});

test('rejects oversized, non-text, and unknown-tool responses and reports timeouts', async (t) => {
  const { post } = await testGateway(t);
  assert.equal((await post({ messages: [user('a'.repeat(3000))] })).status, 413);
  assert.equal((await post({ messages: [user([{ type: 'image_url', image_url: { url: 'https://example.com' } }])] })).status, 400);
  const unknown = await post({ messages: [user('INVALID_TOOL')], tools: [read] });
  assert.equal(unknown.status, 422);
  assert.equal((await unknown.json()).error.code, 'invalid_whatsapp_reply');
  const timedOut = await post({ messages: [user('TIMEOUT_FIXTURE')] });
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).error.code, 'reply_timeout');
});
