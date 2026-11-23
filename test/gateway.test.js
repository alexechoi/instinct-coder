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
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8ywAAAAASUVORK5CYII=', 'base64');
const image = (data) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data.toString('base64')}` } });

async function testGateway(t, { dispatch, maxChars = 2_000, timeoutMs = 500 } = {}) {
  const store = await mkdtemp(join(tmpdir(), 'instinct-coder-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const complete = dispatch ?? whatsappTransport({
    bin: fileURLToPath(new URL('./fake-wacli', import.meta.url)), chat: '+15551234567', store, pollMs: 25,
  });
  const gateway = createGateway({ key, complete, timeoutMs, maxChars });
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

test('sends inline screenshots as private temporary WhatsApp attachments before the text', async (t) => {
  const { post } = await testGateway(t, { timeoutMs: 8_000 });
  const screenshot = Buffer.concat([tinyPng, Buffer.alloc(1024 * 1024)]);
  const response = await post({ messages: [user([
    image(screenshot), { type: 'text', text: 'IMAGE_BRIDGE_FIXTURE Inspect the screenshot.' },
  ])] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Received the image attachment.');
});

test('reserves image slots for the current request and rejects excess or invalid current attachments', async (t) => {
  const { post } = await testGateway(t, { dispatch: (turn) => {
    const { messages } = JSON.parse(turn.prompt.split('\n').at(-1));
    assert.match(messages[0].content, /Earlier image omitted/);
    assert.match(messages[1].content, /\[WhatsApp image 4\]/);
    assert.equal(turn.images.length, 4);
    return { content: 'All four images accepted.', finish: 'stop' };
  } });
  const fourImages = Array.from({ length: 4 }, () => image(tinyPng));
  const accepted = await post({ messages: [user([image(tinyPng)]), user(fourImages)] });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).choices[0].message.content, 'All four images accepted.');

  const excess = await post({ messages: [user([...fourImages, image(tinyPng)])] });
  assert.equal(excess.status, 400);
  assert.equal((await excess.json()).error.code, 'image_limit');

  const invalid = await post({ messages: [user([image(Buffer.from('not image data'))])] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_image');
});

test('Codex and Claude accept several inline images, including tool images and large screenshots', async (t) => {
  const large = Buffer.concat([tinyPng, Buffer.alloc(1024 * 1024)]);
  const second = Buffer.concat([tinyPng, Buffer.from('second')]);
  const fromTool = Buffer.concat([tinyPng, Buffer.from('tool')]);
  const responsesImage = (data) => ({ type: 'input_image', image_url: image(data).image_url.url });
  const anthropicImage = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } });
  const call = { id: 'capture', name: 'screenshot' };

  const { request } = await testGateway(t, { dispatch: (turn) => {
    assert.deepEqual(turn.images.map(({ data }) => data), [large, second, fromTool]);
    assert.ok(!turn.prompt.includes('data:image'));
    const context = JSON.parse(turn.prompt.split('\n').at(-1));
    assert.equal(context.messages[0].content, '[WhatsApp image 1]\nInspect these images.\n[WhatsApp image 2]');
    assert.equal(context.messages.at(-1).role, 'tool');
    assert.equal(context.messages.at(-1).tool_call_id, call.id);
    assert.equal(context.messages.at(-1).content, '[WhatsApp image 3]');
    return { content: 'All three images received.', finish: 'stop' };
  } });

  const codex = await request('responses', { input: [
    user([responsesImage(large), { type: 'input_text', text: 'Inspect these images.' }, responsesImage(second)]),
    { type: 'function_call', call_id: call.id, name: call.name, arguments: '{}' },
    { type: 'function_call_output', call_id: call.id, output: [responsesImage(fromTool)] },
  ] });
  assert.equal(codex.status, 200);
  assert.equal((await codex.json()).output[0].content[0].text, 'All three images received.');

  const claudeBody = { messages: [
    user([anthropicImage(large), { type: 'text', text: 'Inspect these images.' }, anthropicImage(second)]),
    { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: {} }] },
    user([{ type: 'tool_result', tool_use_id: call.id, content: [anthropicImage(fromTool)] }]),
  ] };
  const auth = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const claude = await request('messages', claudeBody, auth);
  assert.equal(claude.status, 200);
  assert.equal((await claude.json()).content[0].text, 'All three images received.');

  const count = await request('messages/count_tokens', claudeBody, auth);
  assert.equal(count.status, 200);
  const { input_tokens: tokens } = await count.json();
  assert.ok(tokens >= 3 * 1024 && tokens < 4_000);
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
  const auth = { ...headers, 'x-instinct-coder-client': 'opencode' };
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
  const { error } = await tooLarge.json();
  assert.equal(error.code, 'whatsapp_context_limit');
  assert.match(error.message, /two 40,000-character WhatsApp messages/);
  assert.match(error.message, /reduce the amount of text attached to the task/);

  const single = await request('chat/completions', { messages: [oversized] }, { ...auth, 'x-instinct-coder-multipart': '0' });
  assert.equal(single.status, 400);
  assert.match((await single.json()).error.message, /one 40,000-character WhatsApp message/);
});

test('OpenCode can send a short first task when the skill catalog and tools exceed the two-message budget', async (t) => {
  const auth = { ...headers, 'x-instinct-coder-client': 'opencode' };
  const task = user('Build a simple in-browser todo app.');
  const skillList = Array.from({ length: 65 }, (_, index) => [
    '<skill>',
    `<name>workflow-${index}</name>`,
    `<description>${'Detailed workflow information. '.repeat(45)}</description>`,
    `<location>/project/skills/workflow-${index}/SKILL.md</location>`,
    '</skill>',
  ].join('\n')).join('\n');
  const system = { role: 'system', content: `Use local tools.\n<available_skills>\n${skillList}\n</available_skills>\nKeep these instructions.` };
  const skillTool = { type: 'function', function: {
    name: 'skill',
    description: 'Load a workflow by name.\n' + 'Detailed tool guidance. '.repeat(3_000) + '\nNames are case-sensitive.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  } };
  const dispatch = (turn) => {
    const chunks = (turn.promptParts ?? []).map((part) => {
      assert.ok(part.length <= 40_000);
      return part.split('<context-part>\n')[1].split('\n</context-part>')[0];
    });
    const context = JSON.parse(chunks.length ? chunks.join('') : turn.prompt.split('\n').at(-1));
    const [retained, request] = context.messages;
    assert.deepEqual(request, task);
    const [tool] = context.tools;
    assert.equal(tool.name, 'skill');
    assert.deepEqual(tool.parameters, skillTool.function.parameters);
    assert.match(tool.description, /^Load a workflow by name\.[\s\S]*excerpt shortened by Instinct Coder[\s\S]*Names are case-sensitive\.$/);
    assert.match(retained.content, /^Use local tools\./);
    assert.match(retained.content, /Keep these instructions\.$/);
    assert.equal(retained.content.match(/<name>/g).length, 65);
    assert.match(retained.content, /<location>\/project\/skills\/workflow-64\/SKILL\.md<\/location>/);
    assert.match(retained.content, /excerpt shortened by Instinct Coder/);
    assert.ok(retained.content.length < 30_000);
    return { content: 'Ready to build.', finish: 'stop' };
  };
  const { request } = await testGateway(t, { maxChars: 40_000, dispatch });
  const response = await request('chat/completions', { messages: [system, task], tools: [skillTool] }, auth);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Ready to build.');

  const impossible = { role: 'system', content: 'System policy '.repeat(7_000) };
  const rejected = await request('chat/completions', { messages: [impossible, task] }, auth);
  assert.equal(rejected.status, 400);
  const { error } = await rejected.json();
  assert.equal(error.code, 'whatsapp_context_limit');
  assert.match(error.message, /in instructions and tool definitions/);
  assert.match(error.message, /Reduce OpenCode’s project instructions/);
  assert.doesNotMatch(error.message, /System policy/);

  const beyondHTTPBudget = { messages: [user('a'.repeat(1024 * 1024))] };
  const responseBeyondHTTPBudget = await request('chat/completions', beyondHTTPBudget, auth);
  assert.equal(responseBeyondHTTPBudget.status, 400);
  assert.equal((await responseBeyondHTTPBudget.json()).error.code, 'body_too_large');
  assert.equal((await request('chat/completions', beyondHTTPBudget)).status, 413);
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
