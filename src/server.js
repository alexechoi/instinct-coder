import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BridgeError, model } from './protocol.js';
import { whatsappTransport } from './wacli.js';

import { anthropicMessages } from './anthropic.js';
import { responses } from './responses.js';
import { chatCompletions, sendJSON } from './wire.js';

const maxBodyBytes = 1024 * 1024;
// Allow OpenCode's 25 MiB image history after base64 expansion so older images can be dropped before sending.
const maxImageBodyBytes = 35 * 1024 * 1024;
const routes = new Map([
  ['/v1/chat/completions', chatCompletions],
  ['/v1/responses', responses],
  ['/v1/messages', anthropicMessages],
  ['/v1/messages/count_tokens', anthropicMessages],
]);

function authorized(header, key) {
  const received = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJSON(request, allowImages) {
  const chunks = [];
  let bytes = 0;
  const limit = allowImages ? maxImageBodyBytes : maxBodyBytes;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      request.resume();
      if (allowImages) throw new BridgeError(400, 'image_request_too_large', 'The request exceeds the upload budget. Attach fewer or smaller PNG or JPEG images.');
      throw new BridgeError(413, 'body_too_large', 'Request body exceeds 1 MiB.');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError(400, 'invalid_json', 'Send a valid JSON body.');
  }
  if (bytes > maxBodyBytes && !(Array.isArray(body?.messages) && body.messages.some((message) =>
    message?.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part?.type === 'image_url')))) {
    throw new BridgeError(413, 'body_too_large', 'Request body exceeds 1 MiB.');
  }
  return body;
}

export function createGateway({ key, maxChars, timeoutMs, complete }) {
  let last = Promise.resolve();
  let queued = 0;

  function enqueue(turn, signal) {
    queued++;
    let started = false;
    const { promise: canceled, reject } = Promise.withResolvers();
    const cancelWaiting = () => { if (!started) reject(signal.reason); };
    signal.addEventListener('abort', cancelWaiting, { once: true });
    const pending = last.then(() => {
      signal.throwIfAborted();
      started = true;
      return complete(turn, signal);
    }).finally(() => {
      signal.removeEventListener('abort', cancelWaiting);
      queued--;
    });
    last = pending.catch(() => {});
    return Promise.race([pending, canceled]);
  }

  return createServer(async (request, response) => {
    const disconnect = new AbortController();
    response.once('close', () => disconnect.abort());
    const path = request.url.split('?')[0];
    const adapter = routes.get(path);
    const anthropic = adapter === anthropicMessages || Boolean(request.headers['anthropic-version']);
    const wire = adapter ?? (anthropic ? anthropicMessages : chatCompletions);
    let heartbeat;
    let exchange;
    try {
      const header = request.headers.authorization ?? (anthropic && request.headers['x-api-key']
        ? `Bearer ${request.headers['x-api-key']}` : undefined);
      if (!authorized(header, key)) {
        throw new BridgeError(401, 'unauthorized', 'Provide the local bridge key.');
      }
      if (request.method === 'GET' && (path === '/v1/models' || (anthropic && path === `/v1/models/${model}`))) {
        const entry = anthropic
          ? { id: model, type: 'model', display_name: 'Instinct via WhatsApp', created_at: '2026-11-22T00:00:00Z' }
          : { id: model, object: 'model', created: 0, owned_by: 'local' };
        const list = anthropic ? { data: [entry], first_id: model, last_id: model, has_more: false }
          : { object: 'list', data: [entry] };
        sendJSON(response, 200, path === '/v1/models' ? list : entry);
        return;
      }
      if (request.method !== 'POST' || !adapter) {
        throw new BridgeError(404, 'not_found', 'Use /v1/chat/completions, /v1/responses, or /v1/messages.');
      }

      const body = await readJSON(request, adapter === chatCompletions);
      if (path === '/v1/messages/count_tokens') {
        sendJSON(response, 200, anthropicMessages.count(body));
        return;
      }
      const turn = adapter.prepareTurn(body, maxChars, request.headers);
      if (queued >= 4) throw new BridgeError(429, 'bridge_busy', 'The WhatsApp queue is full. Try again when it has drained.');
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), disconnect.signal]);
      exchange = adapter.open(response, body, turn);
      if (body.stream === true) heartbeat = setInterval(() => response.write(': waiting for WhatsApp\n\n'), 10_000);

      const result = await enqueue(turn, signal);
      if (!response.destroyed) exchange.complete(result);
    } catch (error) {
      if (response.destroyed) return;
      const failure = error instanceof BridgeError ? error : error?.name === 'TimeoutError'
        ? new BridgeError(504, 'reply_timeout', 'The request expired while queued or waiting for a matching WhatsApp text reply. Check the chat and wacli sync.')
        : new BridgeError(500, 'bridge_error', 'The bridge could not complete the request.');
      if (exchange?.fail) exchange.fail(failure);
      else wire.error(response, failure, request.headers);
    } finally {
      clearInterval(heartbeat);
    }
  });
}

function integer(name, defaultValue, min, max) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const key = process.env.INSTINCT_BRIDGE_KEY;
    if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Set INSTINCT_BRIDGE_KEY to 64 hexadecimal characters. See .env.example.');
    const port = integer('PORT', 8787, 1, 65535);
    const complete = whatsappTransport({
      bin: process.env.WACLI_BIN || 'wacli',
      store: process.env.WACLI_STORE_DIR,
      chat: process.env.INSTINCT_WHATSAPP_CHAT || undefined,
      pollMs: integer('POLL_INTERVAL_MS', 1500, 250, 30_000),
    });
    const gateway = createGateway({
      key, complete,
      maxChars: integer('MAX_PROMPT_CHARS', 40_000, 1_000, 60_000),
      timeoutMs: integer('REPLY_TIMEOUT_MS', 180_000, 1_000, 900_000),
    });
    gateway.on('error', (error) => { console.error(`Gateway could not listen (${error.code}).`); process.exitCode = 1; });
    gateway.listen(port, '127.0.0.1', () => console.log(`Instinct Coder listening on http://127.0.0.1:${port}/v1`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
