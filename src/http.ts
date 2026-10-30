/**
 * VerifyAnyEmail MCP server — hosted (Streamable HTTP) entry point.
 *
 * Multi-tenant: each request carries the caller's own `vae_...` API key in the
 * `Authorization: Bearer ...` header (or `X-VAE-Api-Key`). The server holds no
 * key of its own — it forwards the caller's key to the VerifyAnyEmail API.
 *
 * Stateless Streamable HTTP: a fresh MCP server + transport per POST, bound to
 * that request's key. Listens on loopback; put a TLS reverse proxy in front.
 *
 * Env: PORT (default 4803), HOST (default 127.0.0.1),
 *      VERIFYANYEMAIL_BASE_URL (default https://api.verifyany.email),
 *      MAX_BODY_BYTES (default 4194304).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, VaeClient, ApiKeyMissingError, PKG_VERSION, DEFAULT_BASE_URL } from "./core.js";

const PORT = Number(process.env.PORT) || 4803;
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = process.env.VERIFYANYEMAIL_BASE_URL?.trim() || DEFAULT_BASE_URL;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 4 * 1024 * 1024;

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-VAE-Api-Key, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function extractKey(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const xk = req.headers["x-vae-api-key"];
  if (typeof xk === "string" && xk.trim()) return xk.trim();
  return null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const httpServer = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // Health check for the reverse proxy / monitoring.
  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
    return json(res, 200, { ok: true, service: "verifyanyemail-mcp", version: PKG_VERSION, transport: "streamable-http" });
  }

  if (url.pathname !== "/mcp") {
    return json(res, 404, { error: "not_found" });
  }

  // Stateless Streamable HTTP: all JSON-RPC rides on POST.
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed", message: "Use POST for the stateless MCP endpoint." });
  }

  const apiKey = extractKey(req);

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (err) {
    const msg = (err as Error).message;
    return json(res, msg === "payload_too_large" ? 413 : 400, { error: msg });
  }

  const server = new McpServer({ name: "verifyanyemail", version: PKG_VERSION });
  registerTools(server, () => {
    if (!apiKey) {
      throw new ApiKeyMissingError(
        "Missing API key. Configure this connector with an 'Authorization: Bearer vae_...' header (your VerifyAnyEmail API key).",
      );
    }
    return new VaeClient({ apiKey, baseUrl: BASE_URL });
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    console.error("request error:", (err as Error).message);
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`verifyanyemail-mcp ${PKG_VERSION} listening on http://${HOST}:${PORT} (streamable-http, stateless)`);
});
