import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

async function testLauncher(t) {
  const state = await mkdtemp(join(tmpdir(), 'instinct-setup-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = {
    ...process.env,
    INSTINCT_CODER_STATE_DIR: state,
    FAKE_WACLI_CHAT: '+16508702892',
    WACLI_BIN: path('./fake-wacli-setup'),
    OPENCODE_BIN: path('./fake-opencode'),
  };
  delete env.INSTINCT_WHATSAPP_CHAT;
  delete env.OPENCODE_DB;
  const cli = (...args) => run(process.execPath, [path('../src/cli.js'), ...args], { env, timeout: 10_000 });
  return { state, env, cli };
}

test('setup links WhatsApp once, and launch runs the gateway until OpenCode exits', async (t) => {
  const { state, env, cli } = await testLauncher(t);
  await assert.rejects(cli('run', 'Hello'), /Finish setup first/);
  const first = await cli('setup');
  assert.match(first.stdout, /Scan the QR/);
  assert.match(first.stdout, /Test QR/);
  assert.match(first.stdout, /Ready/);

  const settings = join(state, 'settings.json');
  const initial = await readFile(settings, 'utf8');
  const { key } = JSON.parse(initial);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(initial), { key });
  assert.equal((await stat(settings)).mode & 0o777, 0o600);

  env.INSTINCT_WHATSAPP_CHAT = '+1 (555) 123-4567';
  await writeFile(settings, JSON.stringify({ key, chat: '+15551234567' }));
  assert.match((await cli('run', 'Hello')).stdout, /Hello through the bridge\./);
  assert.match((await cli('setup')).stdout, /already linked/);
  assert.equal(await readFile(settings, 'utf8'), initial);

  const syncPid = Number(await readFile(join(state, 'whatsapp', 'sync.pid'), 'utf8'));
  assert.throws(() => process.kill(syncPid, 0), { code: 'ESRCH' });
});

test('OpenCode uses a separate database for an incompatible default and keeps using it', async (t) => {
  const { state, env, cli } = await testLauncher(t);
  await cli('setup');

  const probeLog = join(state, 'probe.log');
  env.FAKE_OPENCODE_PROBE_LOG = probeLog;
  env.FAKE_OPENCODE_DB_ERROR = 'Database is locked';
  assert.match((await cli('run', 'Hello')).stdout, /Hello through the bridge\./);

  const fallback = join(state, 'opencode-v1.db');
  env.FAKE_OPENCODE_DB_ERROR = 'Database is not empty and has no session table';
  env.FAKE_OPENCODE_EXPECT_DB = fallback;
  const first = await cli('run', 'Hello');
  assert.match(first.stdout, /Using a separate session database/);
  assert.match(first.stdout, /Hello through the bridge\./);

  await writeFile(fallback, 'Existing Instinct Coder session database fixture.');
  delete env.FAKE_OPENCODE_DB_ERROR;
  assert.match((await cli('run', 'Hello')).stdout, /Hello through the bridge\./);

  env.OPENCODE_DB = join(state, 'custom.db');
  env.FAKE_OPENCODE_EXPECT_DB = env.OPENCODE_DB;
  assert.match((await cli('run', 'Hello')).stdout, /Hello through the bridge\./);
  assert.equal(await readFile(probeLog, 'utf8'), 'probe\nprobe\n');
});

test('setup and launch identify sync failures even when local authentication succeeds', async (t) => {
  const { state, env, cli } = await testLauncher(t);
  await cli('setup');
  const settings = await readFile(join(state, 'settings.json'), 'utf8');
  env.FAKE_WACLI_SYNC_ERROR = 'store is locked (another wacli is running?): store locked (pid=4321\nacquired_at=2026-11-23T00:00:00Z)';

  for (const args of [['setup'], ['run', 'Hello'], ['codex'], ['repair']]) {
    await assert.rejects(cli(...args), (error) => {
      assert.match(error.stderr, /Another process is using this WhatsApp connection\. Process ID 4321\./);
      assert.doesNotMatch(error.stdout, /Ready|sync is working/);
      if (args[0] !== 'repair') assert.match(error.stderr, /instinct-coder repair/);
      return true;
    });
  }

  env.FAKE_WACLI_SYNC_ERROR = 'dial unix /example/.send.sock: bind: invalid argument';
  await assert.rejects(cli('setup'), /local send socket could not start/);
  assert.equal(await readFile(join(state, 'settings.json'), 'utf8'), settings);
});
