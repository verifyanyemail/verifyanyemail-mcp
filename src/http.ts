/**
 * VerifyAnyEmail MCP server — hosted (Streamable HTTP) entry point, with OAuth 2.1.
 *
 * Auth: either a raw `vae_...` API key or an OAuth 2.1 access token (see oauth.ts)
 * in the `Authorization: Bearer ...` header. Unauthenticated MCP requests get a
 * 401 + WWW-Authenticate challenge pointing at the protected-resource metadata,
 * which triggers OAuth discovery in ChatGPT / Claude.
 *
 * Env: PORT (4803), HOST (127.0.0.1), VERIFYANYEMAIL_BASE_URL,
 *      MCP_ISSUER (default https://mcp.verifyany.email),
 *      OAUTH_STORE (default /opt/verifyanyemail-mcp/data/oauth.json),
 *      MAX_BODY_BYTES (4194304).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, VaeClient, ApiKeyMissingError, PKG_VERSION, DEFAULT_BASE_URL } from "./core.js";
import { OAuthServer } from "./oauth.js";

const PORT = Number(process.env.PORT) || 4803;
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = process.env.VERIFYANYEMAIL_BASE_URL?.trim() || DEFAULT_BASE_URL;
const ISSUER = (process.env.MCP_ISSUER?.trim() || "https://mcp.verifyany.email").replace(/\/+$/, "");
const OAUTH_STORE = process.env.OAUTH_STORE?.trim() || "/opt/verifyanyemail-mcp/data/oauth.json";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 4 * 1024 * 1024;

const oauth = new OAuthServer(ISSUER, BASE_URL, OAUTH_STORE);

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-VAE-Api-Key, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
}

function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const xk = req.headers["x-vae-api-key"];
  if (typeof xk === "string" && xk.trim()) return xk.trim();
  return null;
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("payload_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

const httpServer = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const method = req.method || "GET";

  try {
    // Health (GET/HEAD on / or /healthz).
    if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/healthz")) {
      if (method === "HEAD") { res.writeHead(200); return res.end(); }
      return json(res, 200, { ok: true, service: "verifyanyemail-mcp", version: PKG_VERSION, transport: "streamable-http" });
    }

    // OAuth metadata (RFC 8414 / RFC 9728).
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, oauth.authServerMetadata());
    }
    if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      return json(res, 200, oauth.protectedResourceMetadata());
    }

    // Dynamic client registration (RFC 7591).
    if (method === "POST" && path === "/register") {
      let body: unknown;
      try { const raw = await readRawBody(req); body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: "invalid_request" }); }
      const r = oauth.register(body);
      return json(res, r.status, r.json);
    }

    // Authorization endpoint.
    if (path === "/authorize" && method === "GET") {
      const r = oauth.authorizePage(url.searchParams);
      if (r.redirect) return redirect(res, r.redirect);
      return html(res, r.status, r.html || "");
    }
    if (path === "/authorize" && method === "POST") {
      let form: URLSearchParams;
      try { form = new URLSearchParams(await readRawBody(req)); } catch { return html(res, 400, "Bad request"); }
      const r = await oauth.authorizeSubmit(form);
      if (r.redirect) return redirect(res, r.redirect);
      return html(res, r.status, r.html || "");
    }

    // Token endpoint.
    if (path === "/token" && method === "POST") {
      let form: URLSearchParams;
      try { form = new URLSearchParams(await readRawBody(req)); } catch { return json(res, 400, { error: "invalid_request" }); }
      const r = oauth.token(form);
      return json(res, r.status, r.json, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    // MCP endpoint (POST at /mcp or /).
    const isMcpPath = path === "/mcp" || path === "/";
    if (isMcpPath && method === "POST") {
      const apiKey = oauth.resolveBearer(extractBearer(req));
      if (!apiKey) {
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`);
        return json(res, 401, { error: "unauthorized", error_description: "Authenticate with OAuth or a VerifyAnyEmail API key." });
      }

      let body: unknown;
      try {
        const raw = await readRawBody(req);
        body = raw ? JSON.parse(raw) : undefined;
      } catch (err) {
        return json(res, (err as Error).message === "payload_too_large" ? 413 : 400, { error: "invalid_json" });
      }

      const server = new McpServer({ name: "verifyanyemail", version: PKG_VERSION });
      registerTools(server, () => {
        if (!apiKey) throw new ApiKeyMissingError();
        return new VaeClient({ apiKey, baseUrl: BASE_URL });
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (path === "/mcp" && (method === "GET" || method === "DELETE")) {
      return json(res, 405, { error: "method_not_allowed", message: "POST a JSON-RPC message to this MCP endpoint." });
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    console.error("request error:", (err as Error).message);
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`verifyanyemail-mcp ${PKG_VERSION} listening on http://${HOST}:${PORT} (streamable-http + oauth, issuer ${ISSUER})`);
});
