import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

test('update uses the installed paths and skips a partially downloaded installer', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'instinct-update-test-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const install = join(scratch, 'custom install');
  const release = join(install, 'releases', 'existing');
  const bin = join(scratch, 'custom bin');
  const state = join(scratch, 'state');
  const log = join(scratch, 'invocation.log');
  await Promise.all([release, bin, state].map((dir) => mkdir(dir, { recursive: true })));
  await cp(path('../src'), join(release, 'src'), { recursive: true });
  await cp(path('../package.json'), join(release, 'package.json'));
  await writeFile(join(release, 'launch'), '');
  const launcher = join(bin, 'instinct-coder');
  await symlink(join(release, 'launch'), launcher);

  const settings = join(state, 'settings.json');
  const initial = '{"key":"fixture"}\n';
  await writeFile(settings, initial);
  const installer = 'printf "%s\\n" "$INSTINCT_CODER_INSTALL_DIR" "$INSTINCT_CODER_BIN_DIR" "$INSTINCT_CODER_REF" > "$FAKE_UPDATE_LOG"\n';
  await writeFile(join(bin, 'curl'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-1) !== 'https://raw.githubusercontent.com/alexechoi/instinct-coder/main/install.sh') process.exit(2);
writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(installer)});
if (process.env.FAKE_DOWNLOAD_FAIL) process.exit(22);
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    INSTINCT_CODER_COMMAND: launcher,
    INSTINCT_CODER_STATE_DIR: state,
    INSTINCT_CODER_INSTALL_DIR: join(scratch, 'unused'),
    INSTINCT_CODER_BIN_DIR: join(scratch, 'unused'),
    INSTINCT_CODER_REF: 'obsolete-branch',
    FAKE_UPDATE_LOG: log,
  };
  const update = () => run(process.execPath, [join(release, 'src', 'cli.js'), 'update'], { env, timeout: 10_000 });

  await update();
  assert.equal(await readFile(log, 'utf8'), `${install}\n${bin}\nmain\n`);
  assert.equal(await readFile(settings, 'utf8'), initial);

  await rm(log);
  env.FAKE_DOWNLOAD_FAIL = '1';
  await assert.rejects(update(), /Could not download the installer/);
  await assert.rejects(readFile(log, 'utf8'), { code: 'ENOENT' });
  assert.equal(await readlink(launcher), join(release, 'launch'));
});
