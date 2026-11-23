import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const existingCommand = /^\s*(?:alias\s+["']?instinct-coder["']?\s*=|function\s+instinct-coder(?=\s|\()|instinct-coder\s*\(\))/m;

async function readProfile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

export async function addShellShortcut(launcher, {
  shell = process.env.SHELL || '',
  home = homedir(),
  zshDirectory = process.env.ZDOTDIR || home,
} = {}) {
  if (!isAbsolute(launcher) || basename(launcher) !== 'instinct-coder') return [];
  let profiles;
  switch (basename(shell)) {
    case 'zsh':
      profiles = [join(zshDirectory, '.zshrc')];
      break;
    case 'bash': {
      const candidates = ['.bash_profile', '.bash_login', '.profile'].map((file) => join(home, file));
      const existing = await Promise.all(candidates.map(readProfile));
      const login = candidates.find((_, index) => existing[index] !== undefined) ?? candidates[0];
      profiles = [join(home, '.bashrc'), login];
      break;
    }
    default:
      return [];
  }

  const shortcut = [
    '',
    '# Instinct Coder shortcut',
    'if ! command -v instinct-coder >/dev/null 2>&1; then',
    `  alias instinct-coder=${quote(quote(launcher))}`,
    'fi',
    '',
  ].join('\n');
  const updated = [];
  for (const profile of profiles) {
    const content = await readProfile(profile);
    if (existingCommand.test(content ?? '')) continue;
    await appendFile(profile, shortcut, { mode: 0o600 });
    updated.push(profile);
  }
  return updated;
}

export async function configureShellShortcut(launcher) {
  if (!process.stdout.isTTY) return;
  try {
    if ((await addShellShortcut(launcher)).length) {
      console.log('Open a new terminal to use the instinct-coder shortcut.');
    }
  } catch (error) {
    console.error(`Could not add the shell shortcut (${error.code ?? 'unknown error'}). Use the installed path below.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  await configureShellShortcut(process.argv[2]);
}
