# Instinct Coder

![Instinct Coder. Use your Instinct for inference.](docs/cover.webp)

[![Platforms](docs/badges/platforms.svg)](#get-started)
[![OpenCode](docs/badges/opencode.svg)](https://github.com/anomalyco/opencode/releases/tag/v1.19.6)
[![Live test](docs/badges/whatsapp.svg)](examples/bill-splitter/index.html)
[![License](docs/badges/license.svg)](LICENSE)

**Use Instinct as the model in OpenCode through your WhatsApp account.**

## Get started

Open a terminal on Linux or macOS 15 or later and have your phone handy.

**1. Install**

```sh
curl -fsSL https://raw.githubusercontent.com/alexechoi/instinct-coder/main/install.sh | sh
```

This installs Instinct Coder, OpenCode, and the WhatsApp connector. The interactive installer adds a shortcut for zsh and Bash. Open a new terminal to use it. The full command works in any shell at `~/.local/bin/instinct-coder`.

**2. Link WhatsApp**

We recommend linking a dedicated WhatsApp account and keeping your primary account separate. Before pairing, confirm the dedicated account can exchange messages with **@textinstinct**.

```sh
instinct-coder setup
```

On the phone signed in to that account, open **WhatsApp → Linked devices → Link a device**, then scan the QR code in your terminal.

## Start coding

### OpenCode

From your project folder, launch OpenCode with Instinct selected.

```sh
instinct-coder
```

The launcher starts the WhatsApp bridge. OpenCode asks before edits or shell commands. Quit OpenCode to stop the bridge.

Paste or attach a PNG or JPEG screenshot in OpenCode to show Instinct what you’re working on. Images are sent as WhatsApp attachments. You can attach up to four images, each up to 8 MiB and up to 15 MiB total.

### Codex CLI and Claude Code

Install the client you want to use, then run one of these commands from your project folder.

```sh
instinct-coder codex
instinct-coder claude
```

Both use the same linked WhatsApp account for text and local tool calls. Claude Code support is experimental. For oversized project instruction reminders, Claude can read the linked files in sections. Short sessions work best.

The [bill splitter](examples/bill-splitter/index.html) was built in a live OpenCode session using Instinct tool calls over WhatsApp.

## Disclaimer

Instinct Coder is provided as is, without warranties. To the extent permitted by applicable law, its contributors disclaim liability for losses, damages, and account restrictions arising from its use. [Apache 2.0 license](LICENSE)

Instinct receives your prompts, attached images, shared file contents, and tool results. Use an account authorized for automation and share files you have permission to send. [Instinct terms](https://instinct.com/terms) · [WhatsApp terms](https://www.whatsapp.com/legal/terms-of-service)

<details>
<summary>Updates and troubleshooting</summary>

- Run `instinct-coder update` to update. Your WhatsApp link and settings carry over. If your version predates `update`, rerun the install command once.
- If WhatsApp stops connecting, run `instinct-coder repair` for guided help. Setup also checks live sync before it reports that you're ready.
- If the bundled OpenCode finds an incompatible session database, Instinct Coder automatically opens a separate one.
- OpenCode automatically uses up to two WhatsApp messages of 40,000 characters each for large requests. The bridge can excerpt tool history and skill descriptions, and point OpenCode to large instruction files it can read in sections. Run `INSTINCT_CODER_MULTIPART=0 instinct-coder` to use one message per request.
- Contributors can run `npm test` in a checkout.
</details>
