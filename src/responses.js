import { BridgeError, model, prepareTurn } from './protocol.js';
import { chatCompletions, conversation, functionTool, identifier, invalid, openStream, sendJSON, sse, textBlocks, timestamp, toolCall } from './wire.js';

const textTypes = ['input_text', 'output_text', 'text'];

function inputMessage(item) {
  if (!item || typeof item !== 'object') invalid('Invalid Responses input item.');
  switch (item.type ?? 'message') {
    case 'message':
      return { role: item.role, content: textBlocks(item.content, textTypes) };
    case 'function_call':
    case 'custom_tool_call': {
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments;
      return { role: 'assistant', tool_calls: [toolCall(item.call_id, item.name, args)] };
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      return { role: 'tool', tool_call_id: item.call_id, content: textBlocks(item.output, textTypes) };
    case 'reasoning':
      return null;
    default:
      invalid(`Unsupported Responses input item: ${item.type}.`);
  }
}

function localTools(tools = []) {
  if (!Array.isArray(tools)) invalid('tools must be an array.');
  return tools.flatMap((tool) => {
    if (tool?.type === 'function') return [functionTool(tool.name, tool.description, tool.parameters)];
    if (tool?.type === 'custom') {
      const grammar = tool.format?.type === 'grammar' ? tool.format.definition : undefined;
      return [functionTool(tool.name, [tool.description, grammar].filter(Boolean).join('\n'), {
        type: 'object', properties: { input: { type: 'string', description: 'Raw tool input text.' } },
        required: ['input'], additionalProperties: false,
      })];
    }
    return [];
  });
}

function prepare(body) {
  const request = conversation(body);
  if (body.previous_response_id || body.conversation) invalid('Send the conversation as input items on every turn.');
  if (body.text?.format && body.text.format.type !== 'text') invalid('Only plain text responses are supported.');
  if (typeof body.instructions === 'string' && body.instructions) request.messages.push({ role: 'system', content: body.instructions });
  if (typeof body.input === 'string') request.messages.push({ role: 'user', content: body.input });
  else if (Array.isArray(body.input)) request.messages.push(...body.input.map(inputMessage).filter(Boolean));
  else invalid('Provide text or a list of Responses input items.');
  request.tools = localTools(body.tools);
  request.parallel_tool_calls = body.parallel_tool_calls;
  const choice = body.tool_choice;
  request.tool_choice = choice && typeof choice === 'object'
    ? { type: 'function', function: { name: choice.name } } : choice;
  return request;
}

function outputItem(call, custom) {
  const { name, arguments: args } = call.function;
  if (!custom.has(name)) {
    return { type: 'function_call', id: identifier('fc'), call_id: call.id, name, arguments: args, status: 'completed' };
  }
  const { input } = JSON.parse(args);
  if (typeof input !== 'string') throw new BridgeError(422, 'invalid_whatsapp_reply', 'Instinct returned invalid text for the custom tool.');
  return { type: 'custom_tool_call', id: identifier('ctc'), call_id: call.id, name, input, status: 'completed' };
}

function emitItem(emit, item, output_index) {
  const base = { item_id: item.id, output_index };
  let initial;
  if (item.type === 'message') initial = { ...item, content: [], status: 'in_progress' };
  else if (item.type === 'custom_tool_call') initial = { ...item, input: '', status: 'in_progress' };
  else initial = { ...item, arguments: '', status: 'in_progress' };
  emit('response.output_item.added', { output_index, item: initial });

  if (item.type === 'message') {
    const part = item.content[0];
    const at = { ...base, content_index: 0 };
    emit('response.content_part.added', { ...at, part: { ...part, text: '' } });
    emit('response.output_text.delta', { ...at, delta: part.text, logprobs: [] });
    emit('response.output_text.done', { ...at, text: part.text, logprobs: [] });
    emit('response.content_part.done', { ...at, part });
  } else if (item.type === 'function_call') {
    emit('response.function_call_arguments.delta', { ...base, delta: item.arguments });
    emit('response.function_call_arguments.done', { ...base, name: item.name, arguments: item.arguments });
  } else {
    emit('response.custom_tool_call_input.delta', { ...base, delta: item.input });
    emit('response.custom_tool_call_input.done', { ...base, input: item.input });
  }
  emit('response.output_item.done', { output_index, item });
}

export const responses = {
  prepareTurn: (body, maxChars) => prepareTurn(prepare(body), maxChars),
  open(response, body) {
    const custom = new Set((body.tools ?? []).filter((tool) => tool?.type === 'custom').map((tool) => tool.name));
    const initial = {
      id: identifier('resp'), object: 'response', created_at: timestamp(), status: 'in_progress',
      model, output: [], usage: null, error: null, incomplete_details: null,
      instructions: body.instructions ?? null, metadata: {}, parallel_tool_calls: body.parallel_tool_calls !== false,
      text: { format: { type: 'text' } }, tool_choice: body.tool_choice ?? 'auto', tools: body.tools ?? [],
      store: false, temperature: 1, top_p: 1, truncation: 'disabled',
    };
    let sequence = 0;
    const emit = (type, data) => sse(response, { type, sequence_number: sequence++, ...data }, type);
    const streaming = body.stream === true;
    if (streaming) {
      openStream(response);
      emit('response.created', { response: initial });
      emit('response.in_progress', { response: initial });
    }
    const complete = ({ content, tool_calls }) => {
      const output = tool_calls ? tool_calls.map((call) => outputItem(call, custom)) : [{
        type: 'message', id: identifier('msg'), status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: content, annotations: [], logprobs: [] }],
      }];
      const completed = {
        ...initial, status: 'completed', completed_at: timestamp(), output,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      };
      if (!streaming) return sendJSON(response, 200, completed);
      output.forEach((item, index) => emitItem(emit, item, index));
      emit('response.completed', { response: completed });
      response.end();
    };
    const fail = (failure) => {
      if (!streaming) return chatCompletions.error(response, failure);
      emit('response.failed', { response: { ...initial, status: 'failed',
        error: { code: failure.code, message: failure.message } } });
      response.end();
    };
    return { complete, fail };
  },
  error: chatCompletions.error,
};
