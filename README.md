# Instinct Coder

Instinct Coder is a local model provider for OpenCode. It translates OpenAI-compatible chat completions into WhatsApp messages through `wacli`. Each turn includes the OpenCode conversation and its available tool definitions. A matching WhatsApp reply becomes either assistant text or a tool request that OpenCode processes under its local permissions. Tool results return on the next turn.

```text
OpenCode ↔ local chat-completions gateway ↔ wacli ↔ WhatsApp ↔ Instinct
```

Instinct offers access without charge under its current terms, which restrict bot use. Use the live transport only if you have permission from Instinct to automate the account and your use of the linked-device bridge is permitted by WhatsApp. You can test the full gateway locally with the included simulated contact. [Instinct Terms of Service](https://instinct.com/terms), [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service)

## Run the local tests

On Linux or macOS with Node.js 22.9 or newer, run `npm test` from this directory. There are no npm dependencies to install. The tests simulate the `wacli` command interface and cover text replies, a tool call and its result, concurrent requests, stale replies, and timeouts.

An authorized live smoke test with OpenCode 1.19.6 and `wacli` 0.26.1 sent a prompt to Instinct on WhatsApp and returned the expected text to OpenCode. Tool calls and their results were exercised with the simulated contact.

## Connect a permitted WhatsApp account

Install OpenCode and `wacli` v0.26.1 for your platform. Before configuring the bridge, confirm that your Instinct contact replies to an ordinary message in WhatsApp. [OpenCode installation](https://opencode.ai/docs/), [wacli releases](https://github.com/openclaw/wacli/releases/tag/v0.26.1)

1. Copy `.env.example` to `.env`. Set `INSTINCT_BRIDGE_KEY` to the output of `openssl rand -hex 32`. Set `INSTINCT_WHATSAPP_CHAT` to your Instinct contact's international phone number, including `+`, or its direct WhatsApp JID. Leave `WACLI_STORE_DIR=./.wacli` for the commands below.
2. From this directory, pair `wacli` via **Settings → Linked devices** in WhatsApp. Leave `sync --follow` running after pairing completes. [wacli authentication](https://github.com/openclaw/wacli/blob/v0.26.1/docs/auth.md)

   ```sh
   wacli --store ./.wacli auth
   wacli --store ./.wacli sync --follow
   ```

3. In a second terminal, start the gateway from this directory.

   ```sh
   npm start
   ```

4. In a third terminal, start from this directory, load the bridge key and provider config, and launch OpenCode inside the folder you want to work on.

   ```sh
   set -a
   . ./.env
   set +a
   export OPENCODE_CONFIG="$PWD/opencode.example.json"
   cd /path/to/your/project
   opencode -m instinct/instinct-whatsapp
   ```

The example uses the OpenCode 1.x custom provider format and was exercised with OpenCode 1.19.6. It uses the bridge for both the main and small models. If you already manage OpenCode settings, merge the provider into your config and keep the tool permissions you want. The example allows project reads and asks before edits or shell commands. [OpenCode 1.x custom-provider documentation](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/providers.mdx)

## How the bridge handles replies

- The gateway listens on `127.0.0.1:8787` and requires a local bearer key. OpenCode uses `POST /v1/chat/completions`. The gateway supports regular JSON and streamed responses. In streaming mode, the completion arrives after the full WhatsApp reply is available.
- Each prompt asks for one WhatsApp text reply with an exact request marker on the first line and one JSON object below it. Only a matching incoming reply from the configured direct chat can complete the request. Tool names must match the set sent by OpenCode. One WhatsApp request runs at a time, including requests from OpenCode's small model.
- When a reply times out, check WhatsApp and the `wacli sync --follow` terminal. Verify that the contact sent the exact marker and JSON in a single message. Delivery and response formatting are the main things to verify on a live account.
- The bridge sends text only and caps the rendered prompt at 40,000 characters by default. Large conversations, tool definitions, and tool results can exceed that budget. Change `MAX_PROMPT_CHARS` or `REPLY_TIMEOUT_MS` in `.env` as needed. If you change `PORT`, update the provider's `baseURL` too.
- OpenCode can include file contents and tool output in requests. These travel through WhatsApp to the configured contact and may remain in the WhatsApp chat and local `wacli` store. Keep the pairing store private and use material you are allowed to share. [Instinct Privacy Policy](https://instinct.com/privacy-policy)

The original repository supplies the Apache 2.0 license retained here. [alexechoi/instinct-coder](https://github.com/alexechoi/instinct-coder)
