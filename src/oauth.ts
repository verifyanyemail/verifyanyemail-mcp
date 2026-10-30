/**
 * Minimal, spec-compliant OAuth 2.1 Authorization Server for the hosted MCP
 * server. Implements what MCP clients (ChatGPT, Claude) and OpenAI's plugin
 * review require:
 *   - RFC 8414 authorization-server metadata  (/.well-known/oauth-authorization-server)
 *   - RFC 9728 protected-resource metadata     (/.well-known/oauth-protected-resource)
 *   - RFC 7591 Dynamic Client Registration     (/register)
 *   - Authorization Code + PKCE (S256)          (/authorize, /token)
 *   - Refresh tokens
 *
 * Resource-owner authentication at /authorize is "connect your VerifyAnyEmail
 * API key": the user pastes their vae_ key, we validate it against the API, and
 * mint OAuth tokens that map to it. The MCP resource server then resolves an
 * access token back to that key. Raw vae_ keys presented directly as Bearer
 * tokens still work (backward compatible).
 *
 * State is persisted to a JSON file so tokens survive restarts. No extra deps.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types & store
// ---------------------------------------------------------------------------

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}
interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  apiKey: string;
  expires_at: number;
}
interface Token {
  apiKey: string;
  expires_at: number;
}
interface StoreData {
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthCode>;
  access: Record<string, Token>;
  refresh: Record<string, Token>;
}

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 60; // 60 days
const CODE_TTL = 5 * 60; // 5 minutes

class Store {
  private data: StoreData = { clients: {}, codes: {}, access: {}, refresh: {} };
  constructor(private file: string) {
    try {
      this.data = { ...this.data, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      /* fresh store */
    }
  }
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      console.error("oauth store persist failed:", (e as Error).message);
    }
  }
  private gc(): void {
    const now = Date.now() / 1000;
    for (const m of [this.data.codes, this.data.access, this.data.refresh] as Record<string, { expires_at: number }>[]) {
      for (const k of Object.keys(m)) if (m[k]!.expires_at < now) delete m[k];
    }
  }
  addClient(c: OAuthClient): void { this.data.clients[c.client_id] = c; this.persist(); }
  getClient(id: string): OAuthClient | undefined { return this.data.clients[id]; }
  addCode(c: AuthCode): void { this.data.codes[c.code] = c; this.gc(); this.persist(); }
  takeCode(code: string): AuthCode | undefined {
    const c = this.data.codes[code];
    if (c) { delete this.data.codes[code]; this.persist(); }
    if (!c || c.expires_at < Date.now() / 1000) return undefined;
    return c;
  }
  addAccess(tok: string, apiKey: string): void { this.data.access[tok] = { apiKey, expires_at: Date.now() / 1000 + ACCESS_TTL }; this.gc(); this.persist(); }
  addRefresh(tok: string, apiKey: string): void { this.data.refresh[tok] = { apiKey, expires_at: Date.now() / 1000 + REFRESH_TTL }; this.persist(); }
  getAccess(tok: string): Token | undefined {
    const t = this.data.access[tok];
    if (!t || t.expires_at < Date.now() / 1000) return undefined;
    return t;
  }
  takeRefresh(tok: string): Token | undefined {
    const t = this.data.refresh[tok];
    if (t) { delete this.data.refresh[tok]; this.persist(); }
    if (!t || t.expires_at < Date.now() / 1000) return undefined;
    return t;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function token(prefix: string): string { return prefix + b64url(randomBytes(32)); }
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = b64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed), b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isValidRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    // Allow https anywhere, and http only for loopback (native/dev clients).
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) return true;
    return false;
  } catch { return false; }
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ---------------------------------------------------------------------------
// OAuth server
// ---------------------------------------------------------------------------

export class OAuthServer {
  private store: Store;
  constructor(private issuer: string, private baseApiUrl: string, storeFile: string) {
    this.store = new Store(storeFile);
  }

  /** RFC 8414 — authorization server metadata. */
  authServerMetadata(): object {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["email.verify"],
    };
  }

  /** RFC 9728 — protected resource metadata. */
  protectedResourceMetadata(): object {
    return {
      resource: `${this.issuer}/mcp`,
      authorization_servers: [this.issuer],
      scopes_supported: ["email.verify"],
      bearer_methods_supported: ["header"],
    };
  }

  /** RFC 7591 — dynamic client registration. */
  register(body: unknown): { status: number; json: object } {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(b.redirect_uris) ? (b.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || !uris.every(isValidRedirect)) {
      return { status: 400, json: { error: "invalid_redirect_uri", error_description: "One or more redirect_uris are missing or invalid." } };
    }
    const client: OAuthClient = {
      client_id: token("vaec_"),
      client_name: typeof b.client_name === "string" ? b.client_name.slice(0, 200) : undefined,
      redirect_uris: uris,
      created_at: Date.now(),
    };
    this.store.addClient(client);
    return {
      status: 201,
      json: {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    };
  }

  /** GET /authorize — render the connect page. Returns HTML or a redirect error. */
  authorizePage(params: URLSearchParams): { status: number; html?: string; redirect?: string } {
    const client_id = params.get("client_id") || "";
    const redirect_uri = params.get("redirect_uri") || "";
    const state = params.get("state") || "";
    const code_challenge = params.get("code_challenge") || "";
    const method = params.get("code_challenge_method") || "";
    const response_type = params.get("response_type") || "";

    const client = this.store.getClient(client_id);
    // redirect_uri validation errors must NOT redirect (anti open-redirect).
    if (!client || !client.redirect_uris.includes(redirect_uri)) {
      return { status: 400, html: this.errorPage("Unknown client or redirect URI.") };
    }
    const bad = (err: string, desc: string) => {
      const u = new URL(redirect_uri);
      u.searchParams.set("error", err);
      u.searchParams.set("error_description", desc);
      if (state) u.searchParams.set("state", state);
      return { status: 302, redirect: u.toString() };
    };
    if (response_type !== "code") return bad("unsupported_response_type", "Only response_type=code is supported.");
    if (method !== "S256" || !code_challenge) return bad("invalid_request", "PKCE with S256 is required.");

    // Render the consent/connect form. All OAuth params are carried as hidden fields.
    const hidden = { client_id, redirect_uri, state, code_challenge, code_challenge_method: method, response_type };
    return { status: 200, html: this.connectPage(hidden) };
  }

  /** POST /authorize — validate the API key, mint a code, redirect back. */
  async authorizeSubmit(form: URLSearchParams): Promise<{ status: number; html?: string; redirect?: string }> {
    const client_id = form.get("client_id") || "";
    const redirect_uri = form.get("redirect_uri") || "";
    const state = form.get("state") || "";
    const code_challenge = form.get("code_challenge") || "";
    const apiKey = (form.get("api_key") || "").trim();

    const client = this.store.getClient(client_id);
    if (!client || !client.redirect_uris.includes(redirect_uri)) {
      return { status: 400, html: this.errorPage("Unknown client or redirect URI.") };
    }
    if (!apiKey) {
      return { status: 200, html: this.connectPage({ client_id, redirect_uri, state, code_challenge, code_challenge_method: "S256", response_type: "code" }, "Please enter your API key.") };
    }
    const valid = await this.validateApiKey(apiKey);
    if (!valid) {
      return { status: 200, html: this.connectPage({ client_id, redirect_uri, state, code_challenge, code_challenge_method: "S256", response_type: "code" }, "That API key was not accepted. Check it and try again.") };
    }
    const code = token("vaecode_");
    this.store.addCode({ code, client_id, redirect_uri, code_challenge, apiKey, expires_at: Date.now() / 1000 + CODE_TTL });
    const u = new URL(redirect_uri);
    u.searchParams.set("code", code);
    if (state) u.searchParams.set("state", state);
    return { status: 302, redirect: u.toString() };
  }

  /** POST /token — authorization_code or refresh_token grant. */
  token(form: URLSearchParams): { status: number; json: object } {
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") || "";
      const verifier = form.get("code_verifier") || "";
      const redirect_uri = form.get("redirect_uri") || "";
      const client_id = form.get("client_id") || "";
      const c = this.store.takeCode(code);
      if (!c) return { status: 400, json: { error: "invalid_grant", error_description: "Authorization code is invalid or expired." } };
      if (c.client_id !== client_id || c.redirect_uri !== redirect_uri) return { status: 400, json: { error: "invalid_grant", error_description: "Client or redirect URI mismatch." } };
      if (!verifier || !pkceMatches(verifier, c.code_challenge)) return { status: 400, json: { error: "invalid_grant", error_description: "PKCE verification failed." } };
      return { status: 200, json: this.issue(c.apiKey) };
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") || "";
      const t = this.store.takeRefresh(rt);
      if (!t) return { status: 400, json: { error: "invalid_grant", error_description: "Refresh token is invalid or expired." } };
      return { status: 200, json: this.issue(t.apiKey) };
    }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  }

  private issue(apiKey: string): object {
    const access = token("vaeat_");
    const refresh = token("vaert_");
    this.store.addAccess(access, apiKey);
    this.store.addRefresh(refresh, apiKey);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "email.verify" };
  }

  /** Resolve a Bearer token to an API key. Accepts OAuth access tokens and raw vae_ keys. */
  resolveBearer(bearer: string | null): string | null {
    if (!bearer) return null;
    if (bearer.startsWith("vae_")) return bearer; // raw API key (backward compatible)
    const t = this.store.getAccess(bearer);
    return t ? t.apiKey : null;
  }

  /** Validate an API key against the API using a free diagnostic endpoint (0 credits). */
  private async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseApiUrl}/v1/tools/mx?domain=verifyany.email`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  // --- HTML ---------------------------------------------------------------

  private connectPage(hidden: Record<string, string>, error?: string): string {
    const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n");
    const errHtml = error ? `<p style="color:#b91c1c;font-size:14px;margin:0 0 12px">${esc(error)}</p>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect VerifyAnyEmail</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;color:#0f172a}
.card{max-width:420px;margin:8vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 26px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#64748b;font-size:14px;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px}
button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.muted{color:#94a3b8;font-size:12px;margin-top:14px}a{color:#4f46e5}
</style></head><body><div class="card">
<h1>Connect VerifyAnyEmail</h1>
<p class="sub">Authorize this app to verify emails using your VerifyAnyEmail account.</p>
${errHtml}
<form method="post" action="/authorize">
${fields}
<label for="api_key">Your API key</label>
<input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="vae_..." autofocus>
<button type="submit">Authorize</button>
</form>
<p class="muted">Find or create your key in the <a href="https://verifyany.email/dashboard/keys" target="_blank" rel="noopener">VerifyAnyEmail dashboard</a>. Your key is sent only to VerifyAnyEmail over HTTPS.</p>
</div></body></html>`;
  }

  private errorPage(message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a">
<div style="max-width:420px;margin:10vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
<h1 style="font-size:18px">Authorization error</h1><p style="color:#64748b">${esc(message)}</p></div></body></html>`;
  }
}
