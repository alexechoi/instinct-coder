import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.js';
import { parseReply } from '../src/protocol.js';
import { whatsappTransport } from '../src/wacli.js';

const key = 'test-key';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const read = { type: 'function', function: { name: 'read', parameters: { type: 'object' } } };
const user = (content) => ({ role: 'user', content });

async function testGateway(t, { dispatch, maxChars = 2_000 } = {}) {
  const store = await mkdtemp(join(tmpdir(), 'instinct-coder-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const complete = dispatch ?? whatsappTransport({
    bin: fileURLToPath(new URL('./fake-wacli', import.meta.url)), chat: '+15551234567', store, pollMs: 25,
  });
  const gateway = createGateway({ key, complete, timeoutMs: 500, maxChars });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const baseURL = `http://127.0.0.1:${gateway.address().port}/v1`;
  const request = (route, body, auth = headers) => fetch(`${baseURL}/${route}`, {
    headers: auth, method: 'POST', body: JSON.stringify({ model: 'instinct-whatsapp', ...body }),
  });
  return { baseURL, request, post: (body) => request('chat/completions', { messages: [user('Hello')], ...body }) };
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

test('OpenCode fits large instruction files and completed tool history without triggering overflow compaction', async (t) => {
  const auth = { ...headers, 'x-instinct-coder-client': 'opencode' };
  const task = user('Build a matching card game.');
  const filePath = '/project with spaces/AGENTS.md';
  const original = 'Start of guide\n' + 'Project instruction\n'.repeat(3_000) + 'End of guide\n';
  const output = 'First log line\n' + 'Tool output\n'.repeat(5_000) + 'Last log line';
  const dispatch = (turn) => {
    assert.ok(turn.prompt.length <= 40_000);
    assert.equal(turn.promptParts, undefined);
    const conversation = JSON.parse(turn.prompt.split('\n').at(-1));
    assert.deepEqual(conversation.tools, [read.function]);
    const [system, request, previousCall, result] = conversation.messages;
    assert.match(system.content, /^Keep the existing system instructions\./);
    assert.ok(system.content.includes(`Instructions from: ${filePath}`));
    assert.ok(system.content.includes('Start of guide') && system.content.includes('End of guide'));
    assert.match(system.content, /<mcp_instructions>\nKeep these instructions\.\n<\/mcp_instructions>$/);
    assert.deepEqual(request, task);
    const [call] = previousCall.tool_calls;
    assert.equal(call.id, result.tool_call_id);
    const args = JSON.parse(call.function.arguments);
    assert.equal(args.filePath, '/project with spaces/index.html');
    assert.match(args.content, /excerpt shortened by Instinct Coder/);
    assert.match(result.content, /^First log line\n[\s\S]+Last log line$/);
    assert.match(result.content, /excerpt shortened by Instinct Coder/);
    return parseReply(turn, `${turn.marker}\n${JSON.stringify({ tool_calls: [{ name: 'read', arguments: { filePath, offset: 100, limit: 500 } }] })}`);
  };
  const { request } = await testGateway(t, { maxChars: 40_000, dispatch });
  const response = await request('chat/completions', { tools: [read], messages: [
    { role: 'system', content: `Keep the existing system instructions.\n\nInstructions from: ${filePath}\n${original}\n<mcp_instructions>\nKeep these instructions.\n</mcp_instructions>` },
    task,
    { role: 'assistant', tool_calls: [{ id: 'call_write', type: 'function', function: {
      name: 'write', arguments: JSON.stringify({ filePath: '/project with spaces/index.html', content: 'code '.repeat(10_000) }),
    } }] },
    { role: 'tool', tool_call_id: 'call_write', content: output },
  ] }, auth);
  assert.equal(response.status, 200);
  const [call] = (await response.json()).choices[0].message.tool_calls;
  assert.deepEqual(JSON.parse(call.function.arguments), { filePath, offset: 100, limit: 48 });

  const tooLarge = await request('chat/completions', { messages: [user('User content '.repeat(8_000))] }, auth);
  assert.equal(tooLarge.status, 400);
  assert.equal((await tooLarge.json()).error.code, 'whatsapp_context_limit');
});

test('OpenCode multipart leaves normal requests alone and bounds oversized UTF-8 requests to two messages', async (t) => {
  const auth = { ...headers, 'x-instinct-coder-client': 'opencode', 'x-instinct-coder-multipart': '1' };
  const short = user('Hello');
  const oversized = user('前'.repeat(40_000) + '🎴'.repeat(8_000) + ' end of request');
  const dispatch = (turn) => {
    if (turn.promptParts) {
      const [first, final] = turn.promptParts;
      assert.equal(turn.promptParts.length, 2);
      assert.ok(!first.includes(turn.marker));
      assert.ok(final.includes(turn.marker));
      const chunks = [first, final].map((part) => {
        assert.ok(part.length <= 40_000 && Buffer.byteLength(part) <= 120_000);
        assert.equal(part, part.toWellFormed());
        return part.split('<context-part>\n')[1].split('\n</context-part>')[0];
      });
      assert.deepEqual(JSON.parse(chunks.join('')), { tools: [], messages: [oversized] });
    } else {
      assert.deepEqual(JSON.parse(turn.prompt.split('\n').at(-1)).messages, [short]);
    }
    return parseReply(turn, `${turn.marker}\n{"text":"Received."}`);
  };
  const { request } = await testGateway(t, { maxChars: 40_000, dispatch });
  for (const message of [short, oversized]) {
    const response = await request('chat/completions', { messages: [message] }, auth);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'Received.');
  }
  const tooLarge = await request('chat/completions', { messages: [user('前'.repeat(81_000))] }, auth);
  assert.equal(tooLarge.status, 400);
  assert.equal((await tooLarge.json()).error.code, 'whatsapp_context_limit');
});


async function streamEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const data = (await response.text()).split('\n').filter((line) => line.startsWith('data: '));
  return data.map((line) => JSON.parse(line.slice(6)));
}

test('Responses streams a function call and accepts its output on the next turn', async (t) => {
  const { request } = await testGateway(t);
  const input = user('READ_BRIDGE_FIXTURE /tmp/bridge-fixture.txt');
  const events = await streamEvents(await request('responses', {
    input: [input], stream: true, tools: [{ type: 'function', ...read.function }],
  }));
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  const [tool] = events.at(-1).response.output;
  assert.equal(tool.type, 'function_call');
  assert.equal(tool.name, 'read');
  assert.deepEqual(JSON.parse(tool.arguments), { filePath: '/tmp/bridge-fixture.txt' });

  const answer = await request('responses', { input: [
    input, tool, { type: 'function_call_output', call_id: tool.call_id, output: 'bridge-fixture-verified' },
  ] });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).output[0].content[0].text, 'I read the file: bridge-fixture-verified');
});

test('Anthropic Messages accepts system blocks and round-trips a streaming tool call', async (t) => {
  const { request } = await testGateway(t);
  const auth = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const input = user('READ_BRIDGE_FIXTURE /tmp/bridge-fixture.txt');
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'Use local tools.' }] }, input],
    tools: [{ name: 'read', input_schema: { type: 'object' } }] };
  const count = await request('messages/count_tokens', body, auth);
  assert.equal(count.status, 200);
  assert.ok((await count.json()).input_tokens > 0);
  const events = await streamEvents(await request('messages?beta=true', { ...body, stream: true }, auth));
  assert.equal(events[0].type, 'message_start');
  assert.equal(events.at(-1).type, 'message_stop');
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  const tool = events.find((event) => event.type === 'content_block_start').content_block;
  const args = JSON.parse(events.find((event) => event.type === 'content_block_delta').delta.partial_json);
  assert.equal(tool.type, 'tool_use');
  assert.deepEqual(args, { filePath: '/tmp/bridge-fixture.txt' });

  const answer = await request('messages', { ...body, messages: [...body.messages,
    { role: 'assistant', content: [{ ...tool, input: args }] },
    user([{ type: 'tool_result', tool_use_id: tool.id, content: [{ type: 'text', text: 'bridge-fixture-verified' }] }]),
  ] }, auth);
  const result = await answer.json();
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.content[0].text, 'I read the file: bridge-fixture-verified');
});

test('Responses preserves raw custom-tool input and matches the output by call ID', async (t) => {
  const { request } = await testGateway(t);
  const input = user('CUSTOM_BRIDGE_FIXTURE');
  const tools = [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }];
  const events = await streamEvents(await request('responses', { input: [input], tools, stream: true }));
  const [tool] = events.at(-1).response.output;
  assert.equal(tool.type, 'custom_tool_call');
  assert.equal(tool.input, 'Example patch text');
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.delta'));

  const answer = await request('responses', { input: [
    input, tool, { type: 'custom_tool_call_output', call_id: tool.call_id, output: 'Patch applied.' },
  ] });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).output[0].content[0].text, 'Patch was applied.');
});

test('retries a wacli lock before send dispatch and reports streamed provider failures', async (t) => {
  const { request, post } = await testGateway(t);
  const retried = await post({ messages: [user('LOCK_BRIDGE_FIXTURE')] });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).choices[0].message.content, 'Hello through the bridge.');

  const events = await streamEvents(await request('responses', {
    input: 'INVALID_TOOL', stream: true, tools: [{ type: 'function', ...read.function }],
  }));
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'invalid_whatsapp_reply');
});

test('oversized Claude Code instruction reminders become file references without dropping the user message', async (t) => {
  const { request } = await testGateway(t);
  const reminder = [
    '<system-reminder>',
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions.',
    '',
    'Contents of /project with spaces/CLAUDE.md (project instructions, checked into the codebase):',
    'oversized instruction text\n'.repeat(200),
    '</system-reminder>',
  ].join('\n');
  const body = { messages: [user([
    { type: 'text', text: reminder },
    { type: 'text', text: 'INSTRUCTION_BUDGET_FIXTURE. Keep this original user message.' },
  ])] };
  const read = { name: 'Read', input_schema: { type: 'object' } };
  const answer = await request('messages', { ...body, tools: [read] });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).content[0].text, 'Hello through the bridge.');

  const readAnswer = await request('messages', { tools: [read], messages: [user([
    { type: 'text', text: reminder },
    { type: 'text', text: 'READ_INSTRUCTION_BUDGET_FIXTURE. Keep this original user message.' },
  ])] });
  assert.equal(readAnswer.status, 200);
  assert.deepEqual((await readAnswer.json()).content[0].input, {
    file_path: '/project with spaces/CLAUDE.md', limit: 48,
  });

  const withoutRead = await request('messages', body);
  assert.equal(withoutRead.status, 400);
  assert.match((await withoutRead.json()).error.message, /WhatsApp prompt has/);

  const oversizedUser = await request('messages', { messages: [user('ordinary user text '.repeat(200))], tools: [read] });
  assert.equal(oversizedUser.status, 400);
  assert.match((await oversizedUser.json()).error.message, /WhatsApp prompt has/);
});
