# Instinct Coder

![Instinct Coder cover showing a terminal connected to a chat bubble](docs/cover.webp)

[![Platforms](docs/badges/platforms.svg)](#get-started)
[![OpenCode](docs/badges/opencode.svg)](https://github.com/anomalyco/opencode/releases/tag/v1.19.6)
[![Live test](docs/badges/whatsapp.svg)](examples/bill-splitter/index.html)
[![License](docs/badges/license.svg)](LICENSE)

**Use Instinct as the model in OpenCode through your WhatsApp account.**

## Get started

Open a terminal on Linux or macOS 15 or later. Have your Instinct WhatsApp number and your phone handy.

**1. Install**

```sh
curl -fsSL https://raw.githubusercontent.com/alexechoi/instinct-coder/main/install.sh | sh
```

This installs Instinct Coder, OpenCode, and the WhatsApp connector for your user account.

**2. Link WhatsApp**

```sh
~/.local/bin/instinct-coder setup
```

Enter the number you use to message Instinct. On your phone, open **WhatsApp → Linked devices → Link a device**, then scan the QR code in your terminal.

## Start coding

In any project folder, run `~/.local/bin/instinct-coder`. It starts the bridge and opens OpenCode with Instinct selected. OpenCode asks before edits or shell commands. Quit OpenCode to stop the bridge.

The [bill splitter](examples/bill-splitter/index.html) was built in a live OpenCode session using Instinct tool calls over WhatsApp.

Instinct receives your prompts, shared file contents, and tool results. Use an account authorized for automation and share files you have permission to send. [Instinct terms](https://instinct.com/terms) · [WhatsApp terms](https://www.whatsapp.com/legal/terms-of-service)

<details>
<summary>Updates and troubleshooting</summary>

- Run the install command again to update. Your WhatsApp link and settings stay in your local state directory.
- If WhatsApp disconnects, run the setup command to link it again.
- If you're asked for a number, include the country code, such as `+1`.
- Contributors can run `npm test` in a checkout.
</details>
