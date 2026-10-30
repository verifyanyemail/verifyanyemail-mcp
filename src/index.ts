#!/usr/bin/env node
/**
 * VerifyAnyEmail MCP server — local (stdio) entry point.
 *
 * Exposes real-time email verification and deliverability diagnostics as MCP
 * tools for any local MCP client (Claude Desktop, Claude Code, Cursor, …).
 *
 * Auth: set VERIFYANYEMAIL_API_KEY to your `vae_...` key.
 * Optional: VERIFYANYEMAIL_BASE_URL (default https://api.verifyany.email),
 *           VERIFYANYEMAIL_TIMEOUT_MS (default 30000).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, VaeClient, ApiKeyMissingError, PKG_VERSION, DEFAULT_BASE_URL } from "./core.js";

function envClient(): VaeClient {
  const apiKey = process.env.VERIFYANYEMAIL_API_KEY?.trim();
  if (!apiKey) throw new ApiKeyMissingError();
  const baseUrl = process.env.VERIFYANYEMAIL_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const timeoutMs = Number(process.env.VERIFYANYEMAIL_TIMEOUT_MS) || 30_000;
  return new VaeClient({ apiKey, baseUrl, timeoutMs });
}

const server = new McpServer({ name: "verifyanyemail", version: PKG_VERSION });
let cached: VaeClient | null = null;
registerTools(server, () => (cached ??= envClient()));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`verifyanyemail-mcp ${PKG_VERSION} ready (stdio).`);
  if (!process.env.VERIFYANYEMAIL_API_KEY?.trim()) {
    console.error("WARNING: VERIFYANYEMAIL_API_KEY is not set — tools will return an auth error until it is.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
