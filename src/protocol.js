import { randomUUID } from 'node:crypto';
import { fitOpenCodePrompt, splitOpenCodePrompt } from './opencode-context.js';

export const model = 'instinct-whatsapp';
export const maxImageMiB = 8;
const maxImageBytes = maxImageMiB * 1024 * 1024;
const maxImageBatchBytes = 15 * 1024 * 1024;
const maxImageCount = 4;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegSignature = Buffer.from('ffd8ff', 'hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function openCodeLimitError(prompt, messages, tools, maxChars, multipart) {
  const instructions = messages.filter(({ role }) => role === 'system' || role === 'developer');
  const setupChars = JSON.stringify(instructions).length + JSON.stringify(tools).length - 4;
  const total = prompt.length.toLocaleString('en-US');
  const setup = setupChars.toLocaleString('en-US');
  const budget = multipart ? `two ${maxChars.toLocaleString('en-US')}-character WhatsApp messages` : `one ${maxChars.toLocaleString('en-US')}-character WhatsApp message`;
  const hint = setupChars > prompt.length / 2
    ? 'Reduce OpenCode’s project instructions or disable unused skills and MCP tools.'
    : 'Compact the session or reduce the amount of text attached to the task.';
  return new BridgeError(400, 'whatsapp_context_limit', `OpenCode sent ${total} characters before trimming, including ${setup} in instructions and tool definitions. The request still exceeds the budget of ${budget}. ${hint}`);
}

function invalid(message) {
  throw new BridgeError(400, 'invalid_request', message);
}

function decodeImage(url) {
  const match = typeof url === 'string' && url.match(/^data:(image\/(png|jpeg));base64,/i);
  if (!match) throw new BridgeError(400, 'invalid_image', 'Attach a PNG or JPEG image directly.');
  const encoded = url.slice(match[0].length);
  if (encoded.length > 4 * Math.ceil(maxImageBytes / 3)) {
    throw new BridgeError(400, 'image_too_large', `Each image can be up to ${maxImageMiB} MiB. Attach a smaller PNG or JPEG.`);
  }
  const data = Buffer.from(encoded, 'base64');
  const kind = match[2].toLowerCase();
  const signature = kind === 'png' ? pngSignature : jpegSignature;
  const canonical = data.toString('base64');
  if (!data.subarray(0, signature.length).equals(signature) ||
      (encoded !== canonical && encoded !== canonical.replace(/=+$/, ''))) {
    throw new BridgeError(400, 'invalid_image', 'The attachment does not contain valid PNG or JPEG image data.');
  }
  if (data.length > maxImageBytes) {
    throw new BridgeError(400, 'image_too_large', `Each image can be up to ${maxImageMiB} MiB. Attach a smaller PNG or JPEG.`);
  }
  return { mime: `image/${kind}`, extension: kind === 'png' ? 'png' : 'jpg', data };
}

function messageContent(content, attachments, currentUserMessage) {
  if (typeof content === 'string' || content === null || content === undefined) return content;
  if (!Array.isArray(content)) invalid('Expected text or message content blocks.');
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (!attachments || part?.type !== 'image_url') invalid('Expected text or an image attachment.');

    let image;
    if (attachments.images.length < maxImageCount) {
      try {
        image = decodeImage(part.image_url?.url);
      } catch (error) {
        if (currentUserMessage || !(error instanceof BridgeError)) throw error;
      }
    }
    if (!image || attachments.bytes + image.data.length > maxImageBatchBytes) {
      if (!currentUserMessage) return '[Earlier image omitted from this WhatsApp request.]';
      throw new BridgeError(400, 'image_limit', `Attach up to ${maxImageCount} images totaling up to 15 MiB.`);
    }
    attachments.bytes += image.data.length;
    return `[WhatsApp image ${attachments.images.push(image)}]`;
  }).join('\n');
}

export function prepareTurn(body, maxChars, { fitOpenCode = false, multipart = false } = {}) {
  if (!record(body) || body.model !== model) invalid(`Use the model ${model}.`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) invalid('Provide at least one message.');
  if (body.n !== undefined && body.n !== 1) invalid('The bridge supports one completion per request.');
  if (body.response_format && body.response_format.type !== 'text') invalid('Structured response_format is unsupported.');
  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid('tools must be an array.');

  for (const message of body.messages) {
    if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      invalid('Unsupported message role.');
    }
  }
  // Reserve attachment slots for the newest user task before considering tool output or earlier messages.
  const attachments = { images: [], bytes: 0 };
  const lastUser = body.messages.findLastIndex((message) => message.role === 'user');
  const currentContent = lastUser === -1 ? undefined : messageContent(body.messages[lastUser].content, attachments, true);
  const messages = body.messages.toReversed().map((message, index) => {
    const imageContent = ['user', 'tool'].includes(message.role);
    return {
      role: message.role,
      content: index === body.messages.length - 1 - lastUser ? currentContent :
        messageContent(message.content, imageContent ? attachments : undefined, false),
      name: message.name,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    };
  }).reverse();

  let tools = (body.tools ?? []).map((tool) => {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') invalid('Only function tools are supported.');
    return tool.function;
  });
  const choice = body.tool_choice ?? 'auto';
  if (choice === 'none') tools = [];
  if (record(choice)) {
    if (choice.type !== 'function') invalid('Unsupported tool_choice.');
    tools = tools.filter((tool) => tool.name === choice.function?.name);
  } else if (!['none', 'auto', 'required'].includes(choice)) {
    invalid('Unsupported tool_choice.');
  }
  const requireTool = choice === 'required' || record(choice);
  if (requireTool && tools.length === 0) invalid('tool_choice requires a declared function.');

  const marker = `OPENCODE ${randomUUID()}`;
  const replyShapes = [];
  if (!requireTool) replyShapes.push('{"text":"your complete answer"}');
  if (tools.length) replyShapes.push('{"tool_calls":[{"name":"tool_name","arguments":{"parameter":"value"}}]}');
  const replyInstructions = [
    'Complete one turn as the language model for a local coding agent.',
    'Use only this request for this turn. Do not take actions in any connected service or execute tools yourself. The local coding agent executes requested tools and sends their results in a later turn.',
    attachments.images.length && 'Placeholders such as [WhatsApp image 1] refer to the labeled WhatsApp image attachments sent immediately before this request. Inspect the actual images when relevant.',
    'Reply in one WhatsApp text message. Put this exact line first:',
    marker,
    `After that line, send exactly one JSON object matching one of these shapes: ${replyShapes.join(' or ')}. Use valid JSON string escapes for line breaks and quotes.`,
    body.parallel_tool_calls === false ? 'Request at most one tool per turn.' : '',
  ].filter(Boolean).join('\n');
  const render = (context, note) => [
    replyInstructions,
    note,
    'The following JSON contains the conversation and available tools:',
    context,
  ].filter(Boolean).join('\n');

  const fits = (prompt) => prompt.length <= maxChars && Buffer.byteLength(prompt) <= 120_000;
  const context = JSON.stringify({ tools, messages });
  const turn = { marker, tools: new Set(tools.map((tool) => tool.name)), requireTool,
    parallel: body.parallel_tool_calls !== false, images: attachments.images };
  const pack = (context, note) => {
    const prompt = render(context, note);
    if (fits(prompt)) return { prompt };
    if (!multipart) return;
    const instructions = note ? `${replyInstructions}\n${note}` : replyInstructions;
    const promptParts = splitOpenCodePrompt(instructions, context, marker, maxChars, fits);
    if (promptParts) return { prompt, promptParts };
  };
  const packed = pack(context);
  if (packed) return { ...turn, ...packed };
  const prompt = render(context);
  if (fitOpenCode) {
    const fitted = fitOpenCodePrompt(messages, tools, maxChars, pack);
    if (fitted) return { ...turn, ...fitted };
    // OpenCode automatically compacts on HTTP 413 and retries with the same system instructions and tools.
    throw openCodeLimitError(prompt, messages, tools, maxChars, multipart);
  }
  if (prompt.length > maxChars) {
    throw new BridgeError(413, 'prompt_too_large', `WhatsApp prompt has ${prompt.length} characters. The configured limit is ${maxChars}. Start a shorter session or reduce tool output.`);
  }
  throw new BridgeError(413, 'prompt_too_large', 'The UTF-8 prompt exceeds the 120 kB limit for passing a message to wacli.');
}

export function parseReply(turn, message) {
  const reply = message.trim().replaceAll('\r\n', '\n');
  if (!reply.startsWith(`${turn.marker}\n`)) return null;
  const payload = reply.slice(turn.marker.length + 1).trim();
  const fenced = payload.match(/^```(?:json)?[ \t]*\n([\s\S]+)\n```$/i);
  let result;
  try {
    result = JSON.parse(fenced?.[1] ?? payload);
  } catch {
    return null;
  }
  if (!record(result)) return null;
  if (!turn.requireTool && typeof result.text === 'string' && result.text.trim() && result.tool_calls === undefined) {
    return { content: result.text, finish: 'stop' };
  }
  const calls = result.tool_calls;
  if (result.text !== undefined || !Array.isArray(calls) || !calls.length || (!turn.parallel && calls.length > 1)) return null;
  if (!calls.every((call) => turn.tools.has(call?.name) && record(call.arguments))) return null;

  return {
    content: null,
    finish: 'tool_calls',
    tool_calls: calls.map(({ name, arguments: args }) => {
      if (name === 'read' && turn.instructionFiles?.has(args.filePath) && (args.limit === undefined || args.limit > 48)) {
        args.limit = 48;
      }
      return {
        id: `call_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      };
    }),
  };
}
