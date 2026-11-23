import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { model } from './protocol.js';
import { connectBridge, launchGateway, openBridge } from './shared-bridge.js';
import { configureShellShortcut } from './shortcut.js';
import { openWhatsApp, outcome, repairWhatsApp, WhatsAppIssue } from './whatsapp-session.js';

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

const whatsapp = { bin: wacli, store };

function watchInterrupts(onInterrupt) {
  const controller = new AbortController();
  const interrupt = (signal) => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort();
    onInterrupt?.(signal);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  return {
    signal: controller.signal,
    restore() {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    },
  };
}

async function update(launcher) {
  const installed = resolve(launcher);
  const releases = resolve(root, '..');
  const target = await realpath(installed).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (basename(installed) !== 'instinct-coder' || basename(releases) !== 'releases' || target !== join(root, 'launch')) {
    throw new Error('Run the install command from the README to install Instinct Coder before updating.');
  }

  const staging = await mkdtemp(join(tmpdir(), 'instinct-coder-update-'));
  const { signal, restore } = watchInterrupts();
  try {
    const installer = join(staging, 'install.sh');
    console.log('Downloading the latest Instinct Coder installer…');
    try {
      await exec('curl', ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10',
        '--max-time', '30', '--output', installer, 'https://raw.githubusercontent.com/alexechoi/instinct-coder/main/install.sh'], { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (error.code === 'ENOENT') throw new Error('Install curl and run update again.');
      throw new Error('Could not download the installer. Check your connection and try again.');
    }
    signal.throwIfAborted();
    const child = spawn('sh', [installer], {
      stdio: 'inherit', signal,
      env: { ...process.env, INSTINCT_CODER_INSTALL_DIR: dirname(releases),
        INSTINCT_CODER_BIN_DIR: dirname(installed), INSTINCT_CODER_REF: 'main' },
    });
    const result = await outcome(child);
    signal.throwIfAborted();
    if (result.error) throw new Error('Could not start the installer.', { cause: result.error });
    process.exitCode = result.code ?? 1;
  } finally {
    try {
      await rm(staging, { recursive: true, force: true });
    } finally {
      restore();
    }
  }
}

async function setup(launcher, repairing = false) {
  const { signal, restore } = watchInterrupts();
  try {
    const previous = await readSettings();
    await mkdir(store, { recursive: true, mode: 0o700 });
    console.log('Checking WhatsApp sync…');
    const settings = { key: previous?.key || randomBytes(32).toString('hex') };
    const shared = previous && await connectBridge(state, signal);
    let gateway;
    try {
      if (shared) {
        if (!repairing) console.log('WhatsApp is already linked.');
      } else {
        const sync = await openWhatsApp(whatsapp, { signal, setup: !repairing });
        await sync.stop();
        signal.throwIfAborted();
        gateway = await launchGateway({ ...settings, whatsapp });
      }
      console.log('WhatsApp sync is working.');
      const response = await fetch(`${(shared ?? gateway).baseURL}/models`, {
        headers: { Authorization: `Bearer ${settings.key}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      const result = await response.json();
      if (!response.ok || result.data?.[0]?.id !== model) throw new Error('The local gateway did not respond as expected.');
    } finally {
      shared?.release();
      gateway?.server.closeAllConnections();
      gateway?.server.close();
    }

    const staging = `${settingsPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(staging, settingsPath);
    } finally {
      await rm(staging, { force: true });
    }
    if (!repairing) await configureShellShortcut(launcher);
    console.log(`Ready. Open a project folder and run:\n  ${launcher}`);
  } finally {
    restore();
  }
}

async function configureOpenCodeDatabase(env) {
  if (env.OPENCODE_DB) return;
  const fallback = join(state, 'opencode-v1.db');
  try {
    await access(fallback);
    env.OPENCODE_DB = fallback;
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await exec(opencode, ['--print-logs', 'db', 'path'], {
      env: { ...env, OPENCODE_DISABLE_MODELS_FETCH: '1' }, timeout: 5000,
    });
  } catch (error) {
    if (![error.stderr, error.stdout].some((output) => output?.includes('Database is not empty and has no session table'))) return;
    env.OPENCODE_DB = fallback;
    console.log('OpenCode’s default database is incompatible. Using a separate session database for Instinct Coder.');
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
  if (env.INSTINCT_CODER_MULTIPART === '0') config.provider.instinct.options.headers['x-instinct-coder-multipart'] = '0';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  await configureOpenCodeDatabase(env);
  return { bin: opencode, args: [...args, '--model', `instinct/${model}`], env };
}

async function start(client, args, launcher) {
  const settings = await readSettings();
  if (!settings) throw new Error(`Finish setup first with ${launcher} setup.`);

  console.log('Connecting to WhatsApp…');
  let child;
  let gateway;
  const { signal, restore } = watchInterrupts((signal) => child?.kill(signal));

  try {
    const options = { ...settings, state, bin: wacli, signal };
    try {
      gateway = await openBridge(options);
    } catch (error) {
      if (!(error instanceof WhatsAppIssue) || !process.stdin.isTTY || !process.stdout.isTTY) throw error;
      const sync = await repairWhatsApp(whatsapp, error, signal);
      await sync.stop();
      gateway = await openBridge(options);
    }
    signal.throwIfAborted();
    const command = await clientCommand(client, args, gateway.baseURL, settings.key);
    signal.throwIfAborted();
    child = spawn(command.bin, command.args, { stdio: 'inherit', env: command.env });
    const result = await Promise.race([
      outcome(child),
      gateway.closed.then(() => {
        signal.throwIfAborted();
        throw new Error(`The shared WhatsApp bridge stopped. Run ${launcher} repair if it happens again.`);
      }),
    ]);
    if (result.error) throw new Error(`Could not start ${client}. Check that it is installed.`, { cause: result.error });
    if (!signal.aborted) process.exitCode = result.code ?? (result.signal ? 1 : 0);
  } finally {
    try {
      child?.kill('SIGTERM');
      gateway?.release();
    } finally {
      restore();
    }
  }
}

const [command, ...args] = process.argv.slice(2);
const launcher = process.env.INSTINCT_CODER_COMMAND || 'instinct-coder';
try {
  if (command === 'setup') {
    await setup(launcher);
  } else if (command === 'repair') {
    await setup(launcher, true);
  } else if (command === 'update') {
    await update(launcher);
  } else if (command === '--help' || command === '-h') {
    console.log(`Usage\n  ${launcher} setup              Link WhatsApp\n  ${launcher} repair             Check and repair the WhatsApp connection\n  ${launcher} update             Install the latest version\n  ${launcher}                    Open OpenCode in this folder\n  ${launcher} run "your prompt"  Run one OpenCode task\n  ${launcher} codex [args]     Open Codex CLI\n  ${launcher} claude [args]    Open Claude Code (experimental)`);
  } else if (command === 'codex' || command === 'claude') {
    await start(command, args, launcher);
  } else {
    await start('opencode', command === 'start' || !command ? args : [command, ...args], launcher);
  }
} catch (error) {
  const message = error.code === 'ENOENT' ? 'A required tool is missing. Run the installer again.' : error.message;
  if (!process.exitCode) {
    console.error(`Instinct Coder: ${message}`);
    if (error instanceof WhatsAppIssue && command !== 'repair') {
      console.error(`Open a terminal and run ${launcher} repair for help reconnecting.`);
    }
    process.exitCode = 1;
  }
}
