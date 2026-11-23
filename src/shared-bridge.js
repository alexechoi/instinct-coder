import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createGateway } from './server.js';
import { whatsappTransport } from './wacli.js';
import { openWhatsApp, outcome, WhatsAppIssue } from './whatsapp-session.js';

const workerScript = fileURLToPath(import.meta.url);
const socketPath = (state) => join(state, '.bridge.sock');

export async function launchGateway({ key, whatsapp }) {
  const complete = whatsappTransport({ ...whatsapp, pollMs: 1500 });
  const server = createGateway({ key, maxChars: 40_000, timeoutMs: 180_000, complete });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return { server, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

export async function connectBridge(state, signal) {
  signal.throwIfAborted();
  const socket = createConnection({ path: socketPath(state), signal });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const timeout = setTimeout(() => socket.destroy(), 1000);
  const { promise, resolve, reject } = Promise.withResolvers();
  let data = '';
  socket.setEncoding('utf8');
  socket.on('error', (error) => {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) reject(error);
  });
  socket.once('close', () => resolve(undefined));
  function receive(chunk) {
    data += chunk;
    if (data.length > 128) {
      socket.destroy();
      return;
    }
    if (!data.includes('\n')) return;
    try {
      const { port } = JSON.parse(data);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid shared bridge port.');
      socket.off('data', receive);
      resolve({ baseURL: `http://127.0.0.1:${port}/v1`, closed, release: () => socket.destroy() });
    } catch {
      socket.destroy();
    }
  }
  socket.on('data', receive);
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
    signal.throwIfAborted();
  }
}

async function startWorker(state, bin, key, signal) {
  const worker = fork(workerScript, [state, bin], {
    detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const startup = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
  const report = once(worker, 'message', { signal: startup }).then(([value]) => value);
  const ended = outcome(worker).then(({ error }) => { throw error ?? new Error('The shared WhatsApp bridge could not start.'); });
  try {
    worker.send(key);
    const result = await Promise.race([report, ended]);
    if (result.kind) throw new WhatsAppIssue(result.kind, result.pid);
    if (result.error) throw new Error(result.error);
  } finally {
    if (worker.connected) worker.disconnect();
    worker.unref();
  }
}

function running(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function openBridge({ state, bin, key, signal }) {
  const existing = await connectBridge(state, signal);
  if (existing) return existing;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await startWorker(state, bin, key, signal);
    } catch (error) {
      if (!(error instanceof WhatsAppIssue) || error.kind !== 'busy') throw error;
      // A concurrent launch may own wacli while WhatsApp is still connecting.
      const deadline = Date.now() + 22_000;
      do {
        const shared = await connectBridge(state, signal);
        if (shared) return shared;
        if (!running(error.pid)) break;
        await delay(100, undefined, { signal });
      } while (Date.now() < deadline);
      if (attempt || running(error.pid)) throw error;
      continue;
    }
    const shared = await connectBridge(state, signal);
    if (shared) return shared;
  }
  throw new Error('The shared WhatsApp bridge stopped during startup.');
}

async function serve(state, bin, key) {
  // Restrict the rendezvous socket to this account from the moment it is created.
  process.umask(0o077);
  const controller = new AbortController();
  const { signal } = controller;
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const stopped = once(signal, 'abort');
  const leases = new Set();
  let idle;
  let gateway;
  let control;
  let sync;
  try {
    const whatsapp = { bin, store: join(state, 'whatsapp') };
    sync = await openWhatsApp(whatsapp, { signal });
    // Holding wacli's store lock makes this worker the only bridge allowed to replace a stale socket.
    const path = socketPath(state);
    const stale = await lstat(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stale) {
      if (!stale.isSocket()) throw new Error('The shared WhatsApp bridge path is occupied by a file.');
      const previous = await connectBridge(state, signal);
      if (previous) {
        previous.release();
        throw new Error('The previous WhatsApp bridge is shutting down. Try again.');
      }
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    gateway = await launchGateway({ key, whatsapp });
    const armIdle = (ms = 1200) => { idle = setTimeout(shutdown, ms); };
    control = createServer((socket) => {
      if (signal.aborted) {
        socket.destroy();
        return;
      }
      clearTimeout(idle);
      leases.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        leases.delete(socket);
        if (!leases.size && !signal.aborted) armIdle();
      });
      socket.write(`${JSON.stringify({ port: gateway.server.address().port })}\n`);
    });
    const listening = once(control, 'listening');
    control.listen(path);
    await listening;
    armIdle(5000);
    report({ ready: true });
    await Promise.race([stopped, sync.ended]);
  } finally {
    shutdown();
    clearTimeout(idle);
    gateway?.server.closeAllConnections();
    gateway?.server.close();
    for (const socket of leases) socket.destroy();
    if (control?.listening) await new Promise((resolve) => control.close(resolve));
    await sync?.stop();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}

function report(result) {
  if (process.connected) process.send(result, () => {
    if (process.connected) process.disconnect();
  });
}

if (process.argv[1] === workerScript && process.send) {
  const [key] = await once(process, 'message');
  try {
    await serve(process.argv[2], process.argv[3], key);
  } catch (error) {
    report(error instanceof WhatsAppIssue ? { kind: error.kind, pid: error.pid } : { error: error.message });
    process.exitCode = 1;
  }
}
