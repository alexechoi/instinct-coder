import { randomUUID } from 'node:crypto';

export const model = 'instinct-whatsapp';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalid(message) {
  throw new BridgeError(400, 'invalid_request', message);
}

function textContent(content) {
  if (typeof content === 'string' || content === null || content === undefined) return content;
  if (!Array.isArray(content) || !content.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
    invalid('All message content must be text.');
  }
  return content.map((part) => part.text).join('\n');
}

export function prepareTurn(body, maxChars) {
  if (!record(body) || body.model !== model) invalid(`Use the model ${model}.`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) invalid('Provide at least one message.');
  if (body.n !== undefined && body.n !== 1) invalid('The bridge supports one completion per request.');
  if (body.response_format && body.response_format.type !== 'text') invalid('Structured response_format is unsupported.');
  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid('tools must be an array.');

  const messages = body.messages.map((message) => {
    if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      invalid('Unsupported message role.');
    }
    return {
      role: message.role,
      content: textContent(message.content),
      name: message.name,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    };
  });

  let tools = (body.tools ?? []).map((tool) => {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') invalid('Only function tools are supported.');
    return tool.function;
  });
  const choice = body.tool_choice ?? 'auto';
  if (choice === 'none') tools = [];
  if (record(choice)) {
    if (choice.type !== 'function') invalid('Unsupported tool_choice.');
    tools = tools.filter((tool) => tool.name === choice.function?.name);
  } else if (!['none', 'auto', 'required'].includes(choice)) {
    invalid('Unsupported tool_choice.');
  }
  const requireTool = choice === 'required' || record(choice);
  if (requireTool && tools.length === 0) invalid('tool_choice requires a declared function.');

  const marker = `OPENCODE ${randomUUID()}`;
  const replyShapes = [];
  if (!requireTool) replyShapes.push('{"text":"your complete answer"}');
  if (tools.length) replyShapes.push('{"tool_calls":[{"name":"tool_name","arguments":{"parameter":"value"}}]}');
  const prompt = [
    'Complete one turn as the language model for a local OpenCode coding session.',
    'Use only the request below for this turn. Do not take actions in any connected service or execute tools yourself. OpenCode executes the requested local tools and sends their results in a later turn.',
    'Send one WhatsApp text message. Put this exact line first:',
    marker,
    `After that line, send exactly one JSON object matching one of these shapes: ${replyShapes.join(' or ')}. Use valid JSON string escapes for line breaks and quotes.`,
    body.parallel_tool_calls === false ? 'Request at most one tool per turn.' : '',
    'The following JSON contains the conversation and available tools:',
    JSON.stringify({ tools, messages }),
  ].filter(Boolean).join('\n');

  if (prompt.length > maxChars) {
    throw new BridgeError(413, 'prompt_too_large', `WhatsApp prompt has ${prompt.length} characters. The configured limit is ${maxChars}. Start a shorter OpenCode session or reduce tool output.`);
  }
  if (Buffer.byteLength(prompt) > 120_000) {
    throw new BridgeError(413, 'prompt_too_large', 'The UTF-8 prompt exceeds the 120 kB limit for passing a message to wacli.');
  }
  return { marker, prompt, tools: new Set(tools.map((tool) => tool.name)), requireTool, parallel: body.parallel_tool_calls !== false };
}

export function parseReply(turn, message) {
  const reply = message.trim().replaceAll('\r\n', '\n');
  if (!reply.startsWith(`${turn.marker}\n`)) return null;
  const payload = reply.slice(turn.marker.length + 1).trim();
  const fenced = payload.match(/^```(?:json)?[ \t]*\n([\s\S]+)\n```$/i);
  let result;
  try {
    result = JSON.parse(fenced?.[1] ?? payload);
  } catch {
    return null;
  }
  if (!record(result)) return null;
  if (!turn.requireTool && typeof result.text === 'string' && result.text.trim() && result.tool_calls === undefined) {
    return { content: result.text, finish: 'stop' };
  }
  const calls = result.tool_calls;
  if (result.text !== undefined || !Array.isArray(calls) || !calls.length || (!turn.parallel && calls.length > 1)) return null;
  if (!calls.every((call) => turn.tools.has(call?.name) && record(call.arguments))) return null;

  return {
    content: null,
    finish: 'tool_calls',
    tool_calls: calls.map(({ name, arguments: args }) => ({
      id: `call_${randomUUID().replaceAll('-', '')}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
  };
}
