import { isAbsolute } from 'node:path';

const omission = '\n[... excerpt shortened by Instinct Coder ...]\n';
// OpenCode combines its built-in prompt, instruction files, MCP instructions, and skills in one system message.
const instructionSection = /^Instructions from: ([^\r\n]+)\r?\n|^<mcp_instructions>[ \t]*$|^Skills provide specialized instructions and workflows for specific tasks\.$/gm;

export function splitOpenCodePrompt(instructions, context, marker, maxChars, fits) {
  if (context.length + instructions.length >= maxChars * 2) return;
  const id = marker.slice('OPENCODE '.length);
  const firstHeader = `Instinct Coder request ${id} — part 1 of 2. Keep this context for part 2 with the same request ID. Wait for part 2 to answer.\n<context-part>\n`;
  const finalHeader = `Instinct Coder request ${id} — part 2 of 2 (final). Use both context-part blocks with this request ID in order as one JSON request. Follow the reply instructions below.\n<context-part>\n`;
  const end = '\n</context-part>';

  // Find the largest prefix that fits both the character and UTF-8 byte limits.
  let low = 0;
  let high = Math.min(context.length - 1, maxChars - firstHeader.length - end.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(firstHeader + context.slice(0, middle) + end)) low = middle;
    else high = middle - 1;
  }
  for (let split of [Math.min(low, Math.ceil(context.length / 2)), low]) {
    if (/^[\uDC00-\uDFFF]$/.test(context[split])) split--;
    if (split <= 0) return;
    const first = firstHeader + context.slice(0, split) + end;
    const final = finalHeader + context.slice(split) + end + '\n\n' + instructions;
    if (fits(first) && fits(final)) return [first, final];
  }
}

function excerpt(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  const retained = limit - omission.length;
  const head = Math.ceil(retained / 2);
  return text.slice(0, head) + omission + text.slice(head - retained);
}

function deferInstructions(content, limit, files) {
  if (typeof content !== 'string' || content.length <= limit) return content;
  const sections = [...content.matchAll(instructionSection)];
  let result = content.slice(0, sections[0]?.index ?? content.length);
  for (const [index, section] of sections.entries()) {
    const [heading, path] = section;
    const end = sections[index + 1]?.index ?? content.length;
    const body = content.slice(section.index + heading.length, end);
    if (path && isAbsolute(path) && body.length > limit) {
      files.add(path);
      result += heading + excerpt(body.trimEnd(), limit) +
        '\nRead the omitted instructions from this file using the local read tool with offset and limit.\n\n';
    } else {
      result += heading + body;
    }
  }
  return result;
}

function shortenArguments(args, limit) {
  if (typeof args !== 'string' || args.length <= limit) return args;
  try {
    return JSON.stringify(JSON.parse(args), (_, value) => excerpt(value, limit));
  } catch {
    return args;
  }
}

export function fitOpenCodePrompt(messages, tools, maxChars, render, fits) {
  const completedCalls = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  const canRead = tools.some((tool) => tool.name === 'read');
  for (const cap of [6_000, 2_000, 800]) {
    const limit = Math.max(250, Math.min(cap, Math.floor(maxChars / 5)));
    const instructionFiles = new Set();
    const context = messages.map((message) => {
      if (message.role === 'system' && canRead) {
        return { ...message, content: deferInstructions(message.content, limit, instructionFiles) };
      }
      if (message.role === 'tool') return { ...message, content: excerpt(message.content, limit) };
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const tool_calls = message.tool_calls.map((call) => {
          if (!call?.id || !completedCalls.has(call.id) || !call.function) return call;
          return { ...call, function: { ...call.function, arguments: shortenArguments(call.function.arguments, limit) } };
        });
        return { ...message, tool_calls };
      }
      return message;
    });
    const note = 'Earlier tool arguments and results may be excerpts. Inspect local files and run focused commands when you need more detail.';
    const prompt = render(JSON.stringify({ tools, messages: context }), note);
    if (fits(prompt)) return { prompt, instructionFiles };
  }
}
