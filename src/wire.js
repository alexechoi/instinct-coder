import { randomUUID } from 'node:crypto';
import { BridgeError, model, prepareTurn } from './protocol.js';

export const identifier = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const timestamp = () => Math.floor(Date.now() / 1000);

export function invalid(message) {
  throw new BridgeError(400, 'invalid_request', message);
}

export function conversation(body) {
  if (body?.model !== model) invalid(`Use the model ${model}.`);
  return { model, messages: [], tools: [] };
}

export function textBlocks(content, allowedTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) invalid('Expected text or a list of text blocks.');
  return content.map((part) => {
    if (!allowedTypes.includes(part?.type) || typeof part.text !== 'string') {
      invalid('This gateway only supports text content.');
    }
    return part.text;
  }).join('\n');
}

export function functionTool(name, description, parameters) {
  if (typeof name !== 'string' || !name) invalid('A local tool must have a name.');
  return { type: 'function', function: { name, description, parameters } };
}

export function toolCall(id, name, args) {
  if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
    invalid('Expected a tool call with a name, call ID, and arguments.');
  }
  return { id, type: 'function', function: { name, arguments: args } };
}

export function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function openStream(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
}

export function sse(response, value, event) {
  const header = event ? `event: ${event}\n` : '';
  response.write(`${header}data: ${JSON.stringify(value)}\n\n`);
}

export const chatCompletions = {
  prepareTurn(body, maxChars, headers) {
    return prepareTurn(body, maxChars, {
      fitOpenCode: headers['x-instinct-coder-client'] === 'opencode',
      multipart: headers['x-instinct-coder-multipart'] === '1',
    });
  },
  open(response, body) {
    const metadata = { id: identifier('chatcmpl'), model, created: timestamp() };
    if (body.stream !== true) {
      const complete = ({ content, finish, tool_calls }) => sendJSON(response, 200, {
        ...metadata, object: 'chat.completion', choices: [{
          index: 0, message: { role: 'assistant', content, tool_calls }, finish_reason: finish,
        }],
      });
      return { complete };
    }

    openStream(response);
    const chunk = (delta, finish_reason = null) => sse(response, {
      ...metadata, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
    });
    chunk({ role: 'assistant' });
    const complete = ({ content, finish, tool_calls }) => {
      chunk(tool_calls ? { tool_calls: tool_calls.map((call, index) => ({ ...call, index })) } : { content });
      chunk({}, finish);
      response.end('data: [DONE]\n\n');
    };
    return { complete };
  },
  error(response, failure) {
    const value = { error: { message: failure.message, type: failure.code, code: failure.code } };
    if (!response.headersSent) return sendJSON(response, failure.status, value);
    sse(response, value);
    response.end('data: [DONE]\n\n');
  },
};
