# VerifyAnyEmail MCP Server

Official [Model Context Protocol](https://modelcontextprotocol.io) server for **VerifyAnyEmail** — give any AI
agent real-time email verification and deliverability diagnostics.

Works with **Claude Desktop, Claude Code, Cursor, Windsurf, ChatGPT (MCP connectors)**, and any other MCP client.

## What it does

| Tool | Description | Credits |
|------|-------------|---------|
| `verify_email` | Verify one address — verdict (`deliverable`/`undeliverable`/`risky`/`unknown`), 0–100 score, `safeToSend`, and signals (catch-all, disposable, role-based, typo). | 1 per call |
| `verify_batch` | Submit many addresses for async bulk verification; returns a `batchId`. | 1 per address |
| `get_batch_status` | Poll a batch's progress and per-status counts. | free |
| `get_batch_results` | Fetch a paginated page of batch results. | free |
| `check_mx` | Domain MX records / can it receive mail. | free |
| `check_spf` | SPF record + misconfiguration flags. | free |
| `check_dmarc` | DMARC policy and alignment. | free |
| `check_dkim` | DKIM record for a selector. | free |
| `check_domain_health` | Combined MX/SPF/DKIM/DMARC health grade with findings. | free |

The diagnostics are free (no verification credits). Verification spends credits — except **test addresses**
at `test.verifyany.email` (`deliverable@`, `undeliverable@`, `risky@`, `unknown@`), which return canned results
and cost **0 credits**, perfect for trying it out.

## Setup

You need a VerifyAnyEmail API key (`vae_…`) — create one in the [dashboard](https://verifyany.email) → **API Keys**.

The server is distributed on npm and runs with `npx` (no install needed).

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "verifyanyemail": {
      "command": "npx",
      "args": ["-y", "verifyanyemail-mcp"],
      "env": { "VERIFYANYEMAIL_API_KEY": "vae_your_key_here" }
    }
  }
}
```

Restart Claude Desktop. You'll see the VerifyAnyEmail tools available.

### Claude Code

```bash
claude mcp add verifyanyemail -e VERIFYANYEMAIL_API_KEY=vae_your_key_here -- npx -y verifyanyemail-mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "verifyanyemail": {
      "command": "npx",
      "args": ["-y", "verifyanyemail-mcp"],
      "env": { "VERIFYANYEMAIL_API_KEY": "vae_your_key_here" }
    }
  }
}
```

### Any other MCP client

Run the binary over stdio with the API key in the environment:

```bash
VERIFYANYEMAIL_API_KEY=vae_your_key_here npx -y verifyanyemail-mcp
```

## Configuration

| Env var | Required | Default | Purpose |
|---------|----------|---------|---------|
| `VERIFYANYEMAIL_API_KEY` | ✅ | — | Your `vae_…` API key. |
| `VERIFYANYEMAIL_BASE_URL` | — | `https://api.verifyany.email` | Override the API base URL. |
| `VERIFYANYEMAIL_TIMEOUT_MS` | — | `30000` | Per-request timeout in milliseconds. |

## Example prompts

- "Is `jane.doe@acme.com` a real, safe-to-send address?"
- "Verify these 500 signups and tell me which are risky." (uses `verify_batch`)
- "Check the email deliverability health of `example.com`."
- "Does `example.com` have a valid SPF and DMARC setup?"

## Security

- Your API key is read **only** from the server's environment and sent **only** to the VerifyAnyEmail API over
  HTTPS. It is never logged (logs go to stderr; the stdout stream is reserved for the MCP protocol).
- Keep the key server-side — treat the MCP config file like any other secret.

## Links

- Website & dashboard: <https://verifyany.email>
- API docs: <https://verifyany.email/docs>
- Issues: <https://github.com/verifyanyemail/verifyanyemail-mcp/issues>

MIT © VerifyAnyEmail
