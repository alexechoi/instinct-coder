import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BridgeError, model, prepareTurn } from './protocol.js';
import { whatsappTransport } from './wacli.js';

const maxBodyBytes = 1024 * 1024;
const created = () => Math.floor(Date.now() / 1000);
const sse = (response, value) => response.write(`data: ${JSON.stringify(value)}\n\n`);

function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function authorized(header, key) {
  const received = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJSON(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      request.resume();
      throw new BridgeError(413, 'body_too_large', 'Request body exceeds 1 MiB.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError(400, 'invalid_json', 'Send a valid JSON body.');
  }
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
    let heartbeat;
    try {
      if (!authorized(request.headers.authorization, key)) {
        throw new BridgeError(401, 'unauthorized', 'Provide the bridge API key as a bearer token.');
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        sendJSON(response, 200, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'local' }] });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        throw new BridgeError(404, 'not_found', 'Use POST /v1/chat/completions or GET /v1/models.');
      }

      const body = await readJSON(request);
      const turn = prepareTurn(body, maxChars);
      if (queued >= 4) throw new BridgeError(429, 'bridge_busy', 'The WhatsApp queue is full. Try again when it has drained.');
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), disconnect.signal]);
      const id = `chatcmpl-${randomUUID()}`;
      const metadata = { id, model, created: created() };
      const chunk = (delta, finish_reason = null) => sse(response, {
        ...metadata, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
      });
      if (body.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        chunk({ role: 'assistant' });
        heartbeat = setInterval(() => response.write(': waiting for WhatsApp\n\n'), 10_000);
      }

      const { content, finish, tool_calls } = await enqueue(turn, signal);
      if (response.destroyed) return;
      if (body.stream === true) {
        chunk(tool_calls ? { tool_calls: tool_calls.map((call, index) => ({ ...call, index })) } : { content });
        chunk({}, finish);
        response.end('data: [DONE]\n\n');
      } else {
        sendJSON(response, 200, {
          ...metadata, object: 'chat.completion', choices: [{
            index: 0, message: { role: 'assistant', content, tool_calls }, finish_reason: finish,
          }],
        });
      }
    } catch (error) {
      if (response.destroyed) return;
      const failure = error instanceof BridgeError ? error : error?.name === 'TimeoutError'
        ? new BridgeError(504, 'reply_timeout', 'The request expired while queued or waiting for a matching WhatsApp text reply. Check the chat and wacli sync.')
        : new BridgeError(500, 'bridge_error', 'The bridge could not complete the request.');
      const value = { error: { message: failure.message, type: failure.code, code: failure.code } };
      if (response.headersSent) {
        sse(response, value);
        response.end('data: [DONE]\n\n');
      } else {
        sendJSON(response, failure.status, value);
      }
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
      chat: process.env.INSTINCT_WHATSAPP_CHAT ?? '',
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
