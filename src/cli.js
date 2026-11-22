import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as promptInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGateway } from './server.js';
import { model } from './protocol.js';
import { normalizeDirectChat, whatsappTransport } from './wacli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = resolve(process.env.INSTINCT_CODER_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'instinct-coder'));
const store = join(state, 'whatsapp');
const settingsPath = join(state, 'settings.json');
const wacli = process.env.WACLI_BIN || join(root, 'bin', 'wacli');
const opencode = process.env.OPENCODE_BIN || join(root, 'bin', 'opencode');
const exec = promisify(execFile);

async function readSettings() {
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Could not read the Instinct Coder settings.', { cause: error });
  }
  if (!normalizeDirectChat(settings?.chat) || !/^[a-f0-9]{64}$/.test(settings?.key)) {
    throw new Error('The Instinct Coder settings file is invalid.');
  }
  return settings;
}

async function paired() {
  try {
    const { stdout } = await exec(wacli, ['--store', store, '--read-only', '--json', 'auth', 'status'], { timeout: 10_000 });
    const result = JSON.parse(stdout);
    if (result.success === true) return result.data.authenticated === true;
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
  }
  throw new Error('Could not check the WhatsApp link.');
}

function outcome(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function launchGateway(settings) {
  const complete = whatsappTransport({ chat: settings.chat, bin: wacli, store, pollMs: 1500 });
  const server = createGateway({ key: settings.key, maxChars: 40_000, timeoutMs: 180_000, complete });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

async function setup(launcher) {
  const previous = await readSettings();
  let chat = normalizeDirectChat(process.env.INSTINCT_WHATSAPP_CHAT || '');
  if (!chat && process.env.INSTINCT_WHATSAPP_CHAT) throw new Error('Use an international Instinct phone number beginning with +.');
  if (!chat) {
    const input = promptInterface({ input: process.stdin, output: process.stdout });
    try {
      const hint = previous ? ' (Enter to keep the current number)' : ' (include the country code, for example +15551234567)';
      const answer = (await input.question(`Instinct’s WhatsApp number${hint}: `)).trim();
      chat = answer ? normalizeDirectChat(answer) : previous?.chat;
    } finally {
      input.close();
    }
  }
  if (!chat) throw new Error('Enter a valid international phone number or direct WhatsApp chat ID.');

  await mkdir(store, { recursive: true, mode: 0o700 });
  if (!await paired()) {
    console.log('On your phone, open WhatsApp → Linked devices → Link a device. Scan the QR below.');
    const auth = spawn(wacli, ['--store', store, 'auth', '--history-days', '1', '--history-max-per-chat', '1', '--idle-exit', '5s'], { stdio: 'inherit' });
    const result = await outcome(auth);
    if (result.error || result.code !== 0 || !await paired()) {
      throw new Error('WhatsApp pairing did not complete. Run setup again to get a new QR.');
    }
  } else {
    console.log('WhatsApp is already linked.');
  }

  const settings = { key: previous?.key || randomBytes(32).toString('hex'), chat };
  const { server, baseURL } = await launchGateway(settings);
  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${settings.key}` },
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || result.data?.[0]?.id !== model) throw new Error('The local gateway did not respond as expected.');
  } finally {
    server.closeAllConnections();
    server.close();
  }

  const staging = `${settingsPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(staging, settingsPath);
  } finally {
    await rm(staging, { force: true });
  }
  console.log(`Ready. Open a project folder and run:\n  ${launcher}`);
}

async function waitForSync(sync, ended) {
  const lines = createInterface({ input: sync.stderr });
  let timer;
  try {
    const ready = new Promise((resolve) => {
      lines.on('line', (line) => {
        try {
          if (JSON.parse(line).event === 'connected') resolve();
        } catch {
          // Keep diagnostics and message events out of the terminal.
        }
      });
    });
    const failure = ended.then(() => { throw new Error('WhatsApp sync stopped. Close any other Instinct Coder session and try again.'); });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('WhatsApp did not connect. Check your connection or run setup again.')), 20_000);
    });
    await Promise.race([ready, failure, timeout]);
  } finally {
    clearTimeout(timer);
    lines.close();
    sync.stderr.resume();
  }
}

async function start(args, launcher) {
  const settings = await readSettings();
  if (!settings) throw new Error(`Finish setup first with ${launcher} setup.`);
  if (!await paired()) throw new Error(`WhatsApp is no longer linked. Run ${launcher} setup again.`);

  const config = JSON.parse(await readFile(join(root, 'opencode.example.json'), 'utf8'));
  console.log('Connecting to WhatsApp…');
  let child;
  let server;
  let interrupted;
  const sync = spawn(wacli, ['--store', store, '--events', 'sync', '--follow', '--presence-mode', 'quiet'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const syncEnded = outcome(sync);
  const interrupt = (signal) => {
    interrupted = signal;
    child?.kill(signal);
    sync.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  try {
    await waitForSync(sync, syncEnded);
    const gateway = await launchGateway(settings);
    server = gateway.server;
    if (interrupted) return;
    config.provider.instinct.options.baseURL = gateway.baseURL;
    child = spawn(opencode, [...args, '--model', `instinct/${model}`], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PWD: process.cwd(),
        INSTINCT_BRIDGE_KEY: settings.key,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      },
    });
    const result = await Promise.race([
      outcome(child),
      syncEnded.then(() => {
        if (interrupted) return {};
        throw new Error('WhatsApp disconnected. Restart Instinct Coder to reconnect.');
      }),
    ]);
    if (result.error) throw new Error('OpenCode could not start.', { cause: result.error });
    process.exitCode = result.code ?? (result.signal ? 1 : 0);
  } finally {
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    child?.kill('SIGTERM');
    sync.kill('SIGTERM');
    server?.closeAllConnections();
    server?.close();
  }
}

const [command, ...args] = process.argv.slice(2);
const launcher = process.env.INSTINCT_CODER_COMMAND || 'instinct-coder';
try {
  if (command === 'setup') {
    await setup(launcher);
  } else if (command === '--help' || command === '-h') {
    console.log(`Usage\n  ${launcher} setup              Link WhatsApp\n  ${launcher}                    Open OpenCode in this folder\n  ${launcher} run "your prompt"  Run one OpenCode task`);
  } else {
    await start(command === 'start' || !command ? args : [command, ...args], launcher);
  }
} catch (error) {
  const message = error.code === 'ENOENT' ? 'A required tool is missing. Run the installer again.' : error.message;
  if (!process.exitCode) {
    console.error(`Instinct Coder: ${message}`);
    process.exitCode = 1;
  }
}
