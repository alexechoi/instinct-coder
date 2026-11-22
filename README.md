# Instinct Coder

Use Instinct as an OpenCode model over WhatsApp.

```text
OpenCode ⇄ local gateway ⇄ wacli ⇄ WhatsApp ⇄ Instinct
```

## Quick start

Requires Node.js 22.9+, [OpenCode 1.x](https://opencode.ai/docs/), and [wacli 0.26.1](https://github.com/openclaw/wacli/releases/tag/v0.26.1).

1. Copy `.env.example` to `.env`. Use `openssl rand -hex 32` to generate `INSTINCT_BRIDGE_KEY`, and set `INSTINCT_WHATSAPP_CHAT` to the contact's international number or direct chat ID.
2. Run `wacli --store ./.wacli auth` and scan the QR under **WhatsApp → Settings → Linked devices**.
3. Leave `wacli --store ./.wacli sync --follow` running. Start the gateway with `npm start` in a second terminal.
4. In a third terminal, run these commands from this checkout.

   ```sh
   set -a
   . ./.env
   set +a
   export OPENCODE_CONFIG="$PWD/opencode.example.json"
   cd /path/to/your/project
   opencode -m instinct/instinct-whatsapp
   ```

## Test status

Run `npm test` for simulated replies, tool calls, and timeouts. In a live test, OpenCode 1.19.6 built this [bill splitter](examples/bill-splitter/index.html) using a tool call from Instinct over WhatsApp.

The bridge handles text and forwards OpenCode context, including file contents and tool results, to the selected chat. Use an account authorized for automation. [Instinct terms](https://instinct.com/terms) · [WhatsApp terms](https://www.whatsapp.com/legal/terms-of-service)
