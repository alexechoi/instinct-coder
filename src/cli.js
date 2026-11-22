import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGateway } from './server.js';
import { model } from './protocol.js';
import { whatsappTransport } from './wacli.js';

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
  if (!/^[a-f0-9]{64}$/.test(settings?.key)) {
    throw new Error('The Instinct Coder settings file is invalid.');
  }
  return { key: settings.key };
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
  const complete = whatsappTransport({ bin: wacli, store, pollMs: 1500 });
  const server = createGateway({ key: settings.key, maxChars: 40_000, timeoutMs: 180_000, complete });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

async function setup(launcher) {
  const previous = await readSettings();
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

  const settings = { key: previous?.key || randomBytes(32).toString('hex') };
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

async function clientCommand(client, args, baseURL, key) {
  const env = { ...process.env, PWD: process.cwd(), INSTINCT_BRIDGE_KEY: key };

  if (client === 'codex') {
    const provider = 'model_providers.instinct';
    const flags = [
      '--model', model, '-c', 'model_provider="instinct"',
      '-c', `model_catalog_json=${JSON.stringify(join(root, 'codex.models.json'))}`,
      '-c', `${provider}.name="Instinct via WhatsApp"`,
      '-c', `${provider}.base_url=${JSON.stringify(baseURL)}`,
      '-c', `${provider}.env_key="INSTINCT_BRIDGE_KEY"`,
      '-c', `${provider}.wire_api="responses"`,
      '-c', `${provider}.supports_websockets=false`,
      '-c', `${provider}.request_max_retries=0`,
      '-c', `${provider}.stream_max_retries=0`,
      '-c', 'web_search="disabled"',
    ];
    return { bin: process.env.CODEX_BIN || 'codex', args: [...flags, ...args], env };
  }

  if (client === 'claude') {
    delete env.ANTHROPIC_API_KEY;
    Object.assign(env, {
      ANTHROPIC_BASE_URL: new URL(baseURL).origin,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || '10000',
      // Let the bridge shorten inline project files before applying its character limit.
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT || '1',
      ENABLE_TOOL_SEARCH: 'false',
    });
    const tools = args.some((arg) => arg === '--tools' || arg.startsWith('--tools='))
      ? [] : ['--tools', 'Read,Write,Edit,Glob,Grep,Bash'];
    return { bin: process.env.CLAUDE_BIN || 'claude', args: [...tools, ...args, '--model', model], env };
  }

  const config = JSON.parse(await readFile(join(root, 'opencode.example.json'), 'utf8'));
  config.provider.instinct.options.baseURL = baseURL;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  return { bin: opencode, args: [...args, '--model', `instinct/${model}`], env };
}

async function start(client, args, launcher) {
  const settings = await readSettings();
  if (!settings) throw new Error(`Finish setup first with ${launcher} setup.`);
  if (!await paired()) throw new Error(`WhatsApp is no longer linked. Run ${launcher} setup again.`);

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
    const command = await clientCommand(client, args, gateway.baseURL, settings.key);
    child = spawn(command.bin, command.args, { stdio: 'inherit', env: command.env });
    const result = await Promise.race([
      outcome(child),
      syncEnded.then(() => {
        if (interrupted) return {};
        throw new Error('WhatsApp disconnected. Restart Instinct Coder to reconnect.');
      }),
    ]);
    if (result.error) throw new Error(`Could not start ${client}. Check that it is installed.`, { cause: result.error });
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
    console.log(`Usage\n  ${launcher} setup              Link WhatsApp\n  ${launcher}                    Open OpenCode in this folder\n  ${launcher} run "your prompt"  Run one OpenCode task\n  ${launcher} codex [args]     Open Codex CLI\n  ${launcher} claude [args]    Open Claude Code (experimental)`);
  } else if (command === 'codex' || command === 'claude') {
    await start(command, args, launcher);
  } else {
    await start('opencode', command === 'start' || !command ? args : [command, ...args], launcher);
  }
} catch (error) {
  const message = error.code === 'ENOENT' ? 'A required tool is missing. Run the installer again.' : error.message;
  if (!process.exitCode) {
    console.error(`Instinct Coder: ${message}`);
    process.exitCode = 1;
  }
}
