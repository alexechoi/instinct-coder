import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BridgeError, parseReply } from './protocol.js';

const exec = promisify(execFile);
const instinctChat = '+16508702892';
const directChat = /^(?:\+[1-9]\d{4,14}|\d+@(?:s\.whatsapp\.net|lid))$/;

function normalizeDirectChat(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('+') ? trimmed.replace(/[\s().-]/g, '') : trimmed;
  return directChat.test(normalized) ? normalized : null;
}

function lockedBeforeSend(stderr) {
  try {
    const lastLine = stderr?.trim().split('\n').at(-1);
    return JSON.parse(lastLine).error?.startsWith('store is locked (another wacli is running?):');
  } catch {
    return false;
  }
}

export function whatsappTransport({ chat = instinctChat, bin, store, pollMs }) {
  const target = normalizeDirectChat(chat);
  if (!target) throw new Error('Set INSTINCT_WHATSAPP_CHAT to an international number (+...) or direct WhatsApp JID.');

  async function run(args, operation, signal) {
    const storeArgs = store ? ['--store', store] : [];
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout } = await exec(bin, ['--json', ...storeArgs, ...args], {
          signal,
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const result = JSON.parse(stdout);
        if (result.success === true) return result.data;
        break;
      } catch (error) {
        signal.throwIfAborted();
        if (error.code === 'ENOENT') {
          throw new BridgeError(503, 'wacli_missing', 'Could not find wacli. Install it or set WACLI_BIN.');
        }
        // wacli reports this lock before dispatch when sync's send socket is still starting.
        if (args[0] !== 'send' || attempt >= 20 || !lockedBeforeSend(error.stderr)) break;
        await delay(200, undefined, { signal }).catch(() => signal.throwIfAborted());
      }
    }
    throw new BridgeError(502, 'wacli_error', `wacli could not ${operation}. Check the configured store and whether wacli sync --follow is running.`);
  }

  return async (turn, signal) => {
    signal.throwIfAborted();
    const after = new Date(Date.now() - 30_000).toISOString();
    const sent = await run(['send', 'text', '--to', target, '--no-preview', '--message', turn.prompt], 'send the WhatsApp prompt', signal);
    if (sent?.sent !== true || typeof sent.id !== 'string') {
      throw new BridgeError(502, 'unconfirmed_send', 'wacli did not confirm the send. Check WhatsApp before retrying.');
    }
    const recipient = normalizeDirectChat(sent.to) ?? target;
    let invalidReply = false;
    try {
      while (true) {
        const page = await run(['messages', 'list', '--chat', recipient, '--from-them', '--after', after, '--limit', '100'], 'read WhatsApp replies', signal);
        const messages = page?.messages;
        if (messages !== null && !Array.isArray(messages)) {
          throw new BridgeError(502, 'wacli_error', 'wacli returned an unexpected messages list. Use wacli v0.26.1.');
        }
        for (const message of messages ?? []) {
          if (message.FromMe !== false || typeof message.Text !== 'string') continue;
          if (message.Text.trim().split(/\r?\n/, 1)[0] !== turn.marker) continue;
          const reply = parseReply(turn, message.Text);
          if (reply) return reply;
          invalidReply = true;
        }
        await delay(pollMs, undefined, { signal });
      }
    } catch (error) {
      if (invalidReply && signal.reason?.name === 'TimeoutError') {
        throw new BridgeError(422, 'invalid_whatsapp_reply', 'A correlated WhatsApp reply arrived, but its JSON or requested tool was invalid.');
      }
      signal.throwIfAborted();
      throw error;
    }
  };
}
