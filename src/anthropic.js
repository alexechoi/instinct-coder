import { BridgeError, model, prepareTurn } from './protocol.js';
import { conversation, functionTool, identifier, invalid, openStream, sendJSON, sse, textBlocks, toolCall } from './wire.js';

const instructionReadLines = 48;

function instructionReferences(text, deferred) {
  if (!deferred || text.length <= deferred.maxChars / 4 ||
      !text.startsWith('<system-reminder>\nCodebase and user instructions are shown below.') ||
      !text.trimEnd().endsWith('</system-reminder>')) return text;

  const paths = [...text.matchAll(/^Contents of (\/[\S ]+?|[A-Za-z]:[\\/][\S ]+?) \([^\r\n]+\):$/gm)]
    .map(([, path]) => path);
  if (!paths.length) return text;
  for (const path of paths) deferred.files.add(path);
  return [
    'Project and user instruction files supplied by Claude Code:',
    ...new Set(paths),
    `Before doing project work, consult the applicable files using the local Read tool in small sections, up to ${instructionReadLines} lines per call. Follow those instructions.`,
  ].join('\n');
}

function messages(input, deferred) {
  if (input?.role === 'system') return [{ role: 'system', content: textBlocks(input.content, ['text']) }];
  if (!input || !['user', 'assistant'].includes(input.role)) invalid('Expected a user or assistant message.');
  if (typeof input.content === 'string') return [{ role: input.role, content: input.content }];
  if (!Array.isArray(input.content)) invalid('Expected a list of message content blocks.');
  const result = [];
  let current = { role: input.role };
  for (const block of input.content) {
    switch (block?.type) {
      case 'text': {
        if (typeof block.text !== 'string') invalid('Expected a text block.');
        const text = input.role === 'user' ? instructionReferences(block.text, deferred) : block.text;
        current.content = current.content === undefined ? text : `${current.content}\n${text}`;
        break;
      }
      case 'tool_use': {
        if (input.role !== 'assistant') invalid('Tool calls belong to assistant messages.');
        current.tool_calls ??= [];
        current.tool_calls.push(toolCall(block.id, block.name, JSON.stringify(block.input)));
        break;
      }
      case 'tool_result':
        if (input.role !== 'user' || typeof block.tool_use_id !== 'string') invalid('Tool results require a tool-use ID.');
        if (current.content !== undefined) result.push(current);
        result.push({ role: 'tool', tool_call_id: block.tool_use_id,
          content: textBlocks(block.content ?? '', ['text']) });
        current = { role: input.role };
        break;
      case 'thinking':
      case 'redacted_thinking':
        break;
      default:
        invalid(`Unsupported Anthropic content block: ${block?.type}.`);
    }
  }
  if (current.content !== undefined || current.tool_calls) result.push(current);
  return result;
}

function prepare(body, deferred) {
  const request = conversation(body);
  if (!Array.isArray(body.messages)) invalid('messages must be an array.');
  if (body.output_config?.format || body.output_format) invalid('Only plain text responses are supported.');
  if (body.system) request.messages.push({ role: 'system', content: textBlocks(body.system, ['text']) });
  request.messages.push(...body.messages.flatMap((message) => messages(message, deferred)));
  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid('tools must be an array.');
  request.tools = (body.tools ?? []).filter((tool) => tool?.input_schema).map((tool) =>
    functionTool(tool.name, tool.description, tool.input_schema));

  const choice = body.tool_choice;
  switch (choice?.type) {
    case undefined:
    case 'auto':
    case 'none':
      request.tool_choice = choice?.type;
      break;
    case 'any':
      request.tool_choice = 'required';
      break;
    case 'tool':
      request.tool_choice = { type: 'function', function: { name: choice.name } };
      break;
    default:
      invalid('Unsupported Anthropic tool choice.');
  }
  request.parallel_tool_calls = choice?.disable_parallel_tool_use !== true;
  return request;
}

function tokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
}

export const anthropicMessages = {
  prepareTurn(body, maxChars) {
    const request = prepare(body);
    try {
      return prepareTurn(request, maxChars);
    } catch (error) {
      const choice = request.tool_choice;
      const canRead = choice !== 'none' && (typeof choice !== 'object' || choice.function.name === 'Read')
        && request.tools.some((tool) => tool.function.name === 'Read');
      if (!(error instanceof BridgeError) || error.code !== 'prompt_too_large' || !canRead) throw error;
      const deferred = { maxChars, files: new Set() };
      const turn = prepareTurn(prepare(body, deferred), maxChars);
      return { ...turn, instructionFiles: deferred.files };
    }
  },
  open(response, body, turn) {
    const initial = {
      id: identifier('msg'), type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const emit = (type, data = {}) => sse(response, { type, ...data }, type);
    const streaming = body.stream === true;
    if (streaming) {
      openStream(response);
      emit('message_start', { message: initial });
    }
    const complete = ({ content, tool_calls }) => {
      const blocks = tool_calls ? tool_calls.map((call) => {
        const { name } = call.function;
        const input = JSON.parse(call.function.arguments);
        if (name === 'Read' && turn.instructionFiles?.has(input.file_path) &&
            (input.limit === undefined || input.limit > instructionReadLines)) input.limit = instructionReadLines;
        return { type: 'tool_use', id: call.id, name, input };
      }) : [{ type: 'text', text: content }];
      const stop_reason = tool_calls ? 'tool_use' : 'end_turn';
      if (!streaming) {
        return sendJSON(response, 200, { ...initial, content: blocks, stop_reason });
      }
      for (const [index, block] of blocks.entries()) {
        const isText = block.type === 'text';
        const content_block = isText ? { ...block, text: '' } : { ...block, input: {} };
        const delta = isText ? { type: 'text_delta', text: block.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
        emit('content_block_start', { index, content_block });
        emit('content_block_delta', { index, delta });
        emit('content_block_stop', { index });
      }
      emit('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } });
      emit('message_stop');
      response.end();
    };
    return { complete };
  },
  count(body) {
    const request = prepare(body);
    return { input_tokens: tokens({ messages: request.messages, tools: request.tools }) };
  },
  error(response, failure) {
    // Claude Code interprets HTTP 413 as an image upload error.
    const status = failure.code === 'prompt_too_large' ? 400 : failure.status;
    const type = { 401: 'authentication_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' }[status]
      ?? (status < 500 ? 'invalid_request_error' : 'api_error');
    const value = { type: 'error', error: { type, message: failure.message } };
    if (!response.headersSent) return sendJSON(response, status, value);
    sse(response, value, 'error');
    response.end();
  },
};
