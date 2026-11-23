import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const syncFlags = ['sync', '--follow', '--presence-mode', 'quiet'];
const legacyFlags = ['--events', ...syncFlags];
const currentFlags = (lockWait) => ['--events', '--lock-wait', lockWait, ...syncFlags];

const messages = {
  busy: 'Another process is using this WhatsApp connection.',
  link: 'The WhatsApp link needs to be renewed.',
  network: 'The WhatsApp connector could not reach WhatsApp. Check your network connection.',
  socket: 'WhatsApp connected, but the local send socket could not start. Check the state folder path and permissions.',
  storage: 'The WhatsApp connector could not read or write its local data. Check disk space and access to the state folder.',
  readonly: 'The WhatsApp connector is in read-only mode. Unset WACLI_READONLY to enable sync.',
  missing: 'The WhatsApp connector is missing. Run the installer again.',
  unknown: 'The WhatsApp connector stopped unexpectedly.',
};

export class WhatsAppIssue extends Error {
  constructor(kind, pid) {
    super(pid ? `${messages[kind]} Process ID ${pid}.` : messages[kind]);
    this.kind = kind;
    this.pid = pid;
  }
}

export function outcome(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function describeSyncError(text) {
  if (typeof text !== 'string') return;
  if (text.includes('store is locked (another wacli is running?):')) {
    const pid = Number(text.match(/\bpid=(\d+)/)?.[1]);
    return new WhatsAppIssue('busy', Number.isSafeInteger(pid) && pid > 1 ? pid : undefined);
  }
  if (/not authenticated|session (?:was )?revoked|logged out|unauthorized/i.test(text)) return new WhatsAppIssue('link');
  if (/read-only mode: command/i.test(text)) return new WhatsAppIssue('readonly');
  if (/\.send\.sock|unix .*bind|sockaddr_un/i.test(text)) return new WhatsAppIssue('socket');
  if (/permission denied|read.only database|disk.*(?:full|i\/o)|database .*malformed|unable to open database|database is locked/i.test(text)) return new WhatsAppIssue('storage');
  if (/websocket|dial tcp|network .*unreachable|no such host|context deadline exceeded|connection (?:refused|reset)|TLS/i.test(text)) return new WhatsAppIssue('network');
}

async function paired({ bin, store }, signal) {
  try {
    const { stdout } = await exec(bin, ['--store', store, '--read-only', '--json', 'auth', 'status'], { signal, timeout: 10_000 });
    const result = JSON.parse(stdout);
    if (result.success === true) return result.data.authenticated === true;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new WhatsAppIssue('missing');
    throw describeSyncError(error.stderr) || new WhatsAppIssue('storage');
  }
  throw new WhatsAppIssue('storage');
}

async function pair(session, signal) {
  console.log('On your phone, open WhatsApp → Linked devices → Link a device. Scan the QR below.');
  const { bin, store } = session;
  const auth = spawn(bin, ['--store', store, '--lock-wait', '1s', 'auth',
    '--history-days', '1', '--history-max-per-chat', '1', '--idle-exit', '5s'], { stdio: 'inherit', signal });
  const result = await outcome(auth);
  signal?.throwIfAborted();
  if (result.error?.code === 'ENOENT') throw new WhatsAppIssue('missing');
  if (result.code !== 0 || !await paired(session, signal)) {
    throw new Error('WhatsApp pairing did not complete. Run repair again to get a new QR.');
  }
}

function socketAcceptsConnections(path, signal) {
  return new Promise((resolve) => {
    const socket = createConnection({ path, signal });
    socket.once('error', () => resolve(false));
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startSync({ bin, store }, signal, lockWait = '1s') {
  signal?.throwIfAborted();
  const child = spawn(bin, ['--store', store, ...currentFlags(lockWait)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = createInterface({ input: child.stderr });
  let connected = false;
  let issue;
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'connected') connected = true;
      else if (event.event === 'logged_out') issue = new WhatsAppIssue('link');
      else if (event.event === 'error') issue = describeSyncError(event.data?.message) || issue;
      else if (event.success === false) issue = describeSyncError(event.error) || issue;
    } catch {
      // wacli can also print human diagnostics. Report only recognized reasons.
      issue = describeSyncError(line) || issue;
    }
  });

  const ended = outcome(child).then(({ error }) => {
    lines.close();
    return issue || new WhatsAppIssue(error?.code === 'ENOENT' ? 'missing' : 'unknown');
  });

  const stop = async () => {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      await ended;
    } finally {
      clearTimeout(force);
    }
  };

  const timeout = AbortSignal.timeout(20_000);
  const check = new AbortController();
  const startup = AbortSignal.any([timeout, check.signal, ...(signal ? [signal] : [])]);
  try {
    await Promise.race([
      (async () => {
        while (!connected || !await socketAcceptsConnections(join(store, '.send.sock'), startup)) {
          await delay(75, undefined, { signal: startup });
        }
        startup.throwIfAborted();
      })(),
      ended.then((failure) => { throw failure; }),
    ]);
    return { ended, stop };
  } catch (error) {
    await stop();
    signal?.throwIfAborted();
    if (error instanceof WhatsAppIssue) throw error;
    if (timeout.aborted) throw new WhatsAppIssue(connected ? 'socket' : 'network');
    throw error;
  } finally {
    check.abort();
  }
}

async function orphanedSync({ bin, store }, pid, signal) {
  if (!pid) return false;
  try {
    const { stdout } = await exec(bin, ['--store', store, '--read-only', '--json', 'doctor'], { signal, timeout: 3000 });
    const report = JSON.parse(stdout);
    if (!report.success || !report.data.lock_held || report.data.lock_owner_pid !== pid) return false;
    const processInfo = await exec('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command='], { signal, timeout: 3000 });
    const command = processInfo.stdout.match(/^\s*1\s+(.+?)\s*$/)?.[1];
    if (!command) return false;
    for (const flags of [currentFlags('1s'), currentFlags('10s'), legacyFlags]) {
      const suffix = ` --store ${store} ${flags.join(' ')}`;
      if (command.endsWith(suffix)) {
        const binary = command.slice(0, -suffix.length);
        return await realpath(binary) === await realpath(bin);
      }
    }
  } catch {
    signal?.throwIfAborted();
  }
  return false;
}

async function ask(question, signal) {
  const input = createPrompt({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([
      input.question(question, { signal }),
      new Promise((resolve) => input.once('close', () => resolve('q'))),
    ]);
    return answer.trim().toLowerCase();
  } finally {
    input.close();
  }
}

export async function repairWhatsApp(session, issue, signal) {
  console.log(`\nWhatsApp repair\n${issue.message}`);
  let lockWait;
  if (issue.kind === 'link') {
    const answer = await ask('Link WhatsApp by scanning a new QR code? [Y/n] ', signal);
    if (!['', 'y', 'yes'].includes(answer)) throw issue;
    await pair(session, signal);
  } else if (issue.kind === 'busy' && await orphanedSync(session, issue.pid, signal)) {
    const answer = await ask('Stop the orphaned Instinct Coder connector and retry? [y/N] ', signal);
    if (!['y', 'yes'].includes(answer) || !await orphanedSync(session, issue.pid, signal)) throw issue;
    try {
      process.kill(issue.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    lockWait = '10s';
  } else if (['busy', 'network', 'unknown'].includes(issue.kind)) {
    const prompt = issue.kind === 'busy'
      ? 'Close the other session, then press Enter to retry or type q to quit. '
      : 'Press Enter to retry or type q to quit. ';
    if (await ask(prompt, signal) !== '') throw issue;
  } else {
    throw issue;
  }

  console.log('Checking WhatsApp again…');
  return startSync(session, signal, lockWait);
}

export async function openWhatsApp(session, { signal, setup = false } = {}) {
  try {
    if (!await paired(session, signal)) {
      if (!setup) throw new WhatsAppIssue('link');
      await pair(session, signal);
    } else if (setup) {
      console.log('WhatsApp is already linked.');
    }
    return await startSync(session, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WhatsAppIssue && process.stdin.isTTY && process.stdout.isTTY) {
      return repairWhatsApp(session, error, signal);
    }
    throw error;
  }
}
