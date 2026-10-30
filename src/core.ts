/**
 * Shared core for the VerifyAnyEmail MCP server — the API client, result
 * formatting, and the tool registrations. Used by both entry points:
 *   - index.ts  (stdio transport; API key from the environment)
 *   - http.ts   (Streamable HTTP transport; API key per request, multi-tenant)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  VerifyAnyEmail,
  VerifyAnyEmailError,
  type VerificationResult,
} from "verifyanyemail";

export const PKG_VERSION = "1.2.0";
export const DEFAULT_BASE_URL = "https://api.verifyany.email";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiKeyMissingError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "No VerifyAnyEmail API key available. Provide a vae_... key (via the VERIFYANYEMAIL_API_KEY " +
          "environment variable for the local server, or an 'Authorization: Bearer vae_...' header for the " +
          "hosted server). Create one in the VerifyAnyEmail dashboard → API Keys.",
    );
    this.name = "ApiKeyMissingError";
  }
}

// ---------------------------------------------------------------------------
// API client (verify/batch via the SDK; diagnostics via GET /v1/tools/*)
// ---------------------------------------------------------------------------

export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class VaeClient {
  readonly sdk: VerifyAnyEmail;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(cfg: ClientConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.sdk = new VerifyAnyEmail(this.apiKey, { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs });
  }

  /** GET a diagnostic tool endpoint (/v1/tools/*). Does not spend verification credits. */
  async diagnostic(path: string, query: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": `verifyanyemail-mcp/${PKG_VERSION}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Request timed out after ${this.timeoutMs}ms.`);
      throw new Error(`Network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const b = body as { error?: string; message?: string } | undefined;
      throw new VerifyAnyEmailError(
        b?.message || b?.error || `Request failed with status ${res.status}.`,
        res.status,
        b?.error,
        body,
      );
    }
    return body;
  }
}

/** Resolves the VaeClient for a given invocation (env-based or request-based). */
export type ClientProvider = () => VaeClient;

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turn any thrown error into a clear, model-readable message. */
export function explain(err: unknown): string {
  if (err instanceof ApiKeyMissingError) return err.message;
  if (err instanceof VerifyAnyEmailError) {
    switch (err.status) {
      case 401:
        return "Authentication failed (401): the VerifyAnyEmail API key is missing, invalid, or revoked.";
      case 402:
        return "Insufficient credits (402): this account is out of verification credits. Buy more credits or upgrade the plan.";
      case 413:
        return "Batch too large (413): reduce the number of addresses, or split into multiple batches.";
      case 429:
        return "Rate limited (429): too many requests. Wait a moment and retry.";
      default:
        return `VerifyAnyEmail API error (${err.status || "network"}): ${err.message}`;
    }
  }
  return `Unexpected error: ${(err as Error).message ?? String(err)}`;
}

/** Wrap a tool handler so thrown errors become a clean isError result. */
function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err) => fail(explain(err)));
}

/** Compact, model-friendly view of a verification result (drops verbose internals). */
function summarizeVerification(r: VerificationResult) {
  return {
    email: r.email,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    safeToSend: r.safeToSend,
    domain: r.domain,
    suggestion: r.suggestion,
    signals: {
      validSyntax: r.checks.syntax,
      hasMxRecords: r.checks.hasMxRecords,
      catchAll: r.checks.catchAll,
      roleBased: r.checks.roleBased,
      disposable: r.checks.disposable,
      freeProvider: r.checks.freeProvider,
      possibleTypo: r.checks.possibleTypo,
    },
    checkedAt: r.checkedAt,
  };
}

const TEST_HINT =
  "Tip: addresses at the test.verifyany.email domain (e.g. deliverable@test.verifyany.email, undeliverable@…, risky@…, unknown@…) return canned results and cost 0 credits.";

const domainArg = {
  domain: z.string().min(1).max(253).describe("The domain to inspect, e.g. example.com"),
};

/**
 * Register all VerifyAnyEmail tools on an McpServer. `getClient` yields the
 * API client for the current invocation (env key for stdio, request key for HTTP).
 */
export function registerTools(server: McpServer, getClient: ClientProvider): void {
  server.tool(
    "verify_email",
    "Verify whether a single email address is real and safe to send to, in real time. " +
      "Returns a deliverability verdict (deliverable | undeliverable | risky | unknown), a 0–100 confidence " +
      "score, a safeToSend flag, and signals (catch-all, disposable, role-based, free provider, likely typo). " +
      "Spends 1 verification credit per call. " + TEST_HINT,
    {
      email: z.string().min(3).max(320).describe("The email address to verify, e.g. name@example.com"),
      smtpProbe: z.boolean().optional().describe("Set false to skip the live SMTP mailbox probe (DNS-only). Default true."),
      catchAllDetection: z.boolean().optional().describe("Set false to skip catch-all detection. Default true."),
    },
    async ({ email, smtpProbe, catchAllDetection }) =>
      guard(async () => ok(summarizeVerification(await getClient().sdk.verify(email, { smtpProbe, catchAllDetection })))),
  );

  server.tool(
    "verify_batch",
    "Submit many email addresses for asynchronous bulk verification. Returns a batchId immediately; the job " +
      "runs in the background. Poll get_batch_status until status is 'completed', then call get_batch_results. " +
      "Reserves 1 credit per address. Prefer verify_email for one-off checks.",
    {
      emails: z.array(z.string().min(3).max(320)).min(1).max(50000).describe("Array of email addresses to verify."),
      name: z.string().max(200).optional().describe("Optional human-friendly label for the batch."),
      webhookUrl: z.string().url().optional().describe("Optional HTTPS URL to receive a signed batch.completed callback."),
    },
    async ({ emails, name, webhookUrl }) =>
      guard(async () => {
        const b = await getClient().sdk.verifyBatch(emails, { name, webhookUrl });
        return ok({ batchId: b.id, status: b.status, total: b.total, note: "Poll get_batch_status with this batchId." });
      }),
  );

  server.tool(
    "get_batch_status",
    "Check the progress of a bulk verification batch: lifecycle state (queued | processing | completed | failed), " +
      "addresses processed, and per-status counts once available.",
    { batchId: z.string().min(1).describe("The batchId returned by verify_batch.") },
    async ({ batchId }) => guard(async () => ok(await getClient().sdk.getBatch(batchId))),
  );

  server.tool(
    "get_batch_results",
    "Fetch a page of results for a bulk verification batch. Paginated — use page and pageSize for large batches.",
    {
      batchId: z.string().min(1).describe("The batchId returned by verify_batch."),
      page: z.number().int().min(1).optional().describe("1-based page number. Default 1."),
      pageSize: z.number().int().min(1).max(1000).optional().describe("Rows per page (1–1000). Default 100."),
    },
    async ({ batchId, page, pageSize }) => guard(async () => ok(await getClient().sdk.getBatchResults(batchId, { page, pageSize }))),
  );

  server.tool(
    "check_mx",
    "Look up a domain's MX (mail exchanger) records and whether it can receive email. Free — no verification credits.",
    domainArg,
    async ({ domain }) => guard(async () => ok(await getClient().diagnostic("/v1/tools/mx", { domain }))),
  );

  server.tool(
    "check_spf",
    "Check a domain's SPF record and flag common misconfigurations. Free — no verification credits.",
    domainArg,
    async ({ domain }) => guard(async () => ok(await getClient().diagnostic("/v1/tools/spf", { domain }))),
  );

  server.tool(
    "check_dmarc",
    "Check a domain's DMARC policy (none | quarantine | reject) and alignment. Free — no verification credits.",
    domainArg,
    async ({ domain }) => guard(async () => ok(await getClient().diagnostic("/v1/tools/dmarc", { domain }))),
  );

  server.tool(
    "check_dkim",
    "Check a domain's DKIM signing record for a given selector. Free — no verification credits.",
    { ...domainArg, selector: z.string().max(120).optional().describe("The DKIM selector, e.g. 'google' or 'mail'. Optional.") },
    async ({ domain, selector }) => guard(async () => ok(await getClient().diagnostic("/v1/tools/dkim", { domain, selector }))),
  );

  server.tool(
    "check_domain_health",
    "Run an overall email-deliverability health check for a domain — combines MX, SPF, DKIM, DMARC and related " +
      "signals into a single graded summary with actionable findings. Free — no verification credits.",
    domainArg,
    async ({ domain }) => guard(async () => ok(await getClient().diagnostic("/v1/tools/health", { domain }))),
  );
}
