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

test('setup links WhatsApp once, and launch runs the gateway until OpenCode exits', async (t) => {
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
  const cli = (...args) => run(process.execPath, [path('../src/cli.js'), ...args], { env, timeout: 10_000 });
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
