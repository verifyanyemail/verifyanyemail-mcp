#!/usr/bin/env node
/**
 * VerifyAnyEmail MCP server.
 *
 * Exposes real-time email verification and deliverability diagnostics as
 * Model Context Protocol tools, so any MCP client (Claude Desktop, Claude Code,
 * Cursor, ChatGPT, or a custom agent) can verify addresses through the
 * VerifyAnyEmail API.
 *
 * Auth: set VERIFYANYEMAIL_API_KEY to your `vae_...` key.
 * Optional: VERIFYANYEMAIL_BASE_URL (defaults to https://api.verifyany.email),
 *           VERIFYANYEMAIL_TIMEOUT_MS (defaults to 30000).
 *
 * This is a thin, read-through client of the public API — it holds no state and
 * never modifies anything server-side beyond the verifications you request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  VerifyAnyEmail,
  VerifyAnyEmailError,
  type VerificationResult,
} from "verifyanyemail";

const PKG_VERSION = "1.0.0";
const DEFAULT_BASE_URL = "https://api.verifyany.email";

// ---------------------------------------------------------------------------
// API client (verify/batch via the SDK; diagnostics via GET /v1/tools/*)
// ---------------------------------------------------------------------------

interface Config {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

function loadConfig(): Config | null {
  const apiKey = process.env.VERIFYANYEMAIL_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.VERIFYANYEMAIL_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(process.env.VERIFYANYEMAIL_TIMEOUT_MS) || 30_000;
  return { apiKey, baseUrl, timeoutMs };
}

class ApiKeyMissingError extends Error {
  constructor() {
    super(
      "VERIFYANYEMAIL_API_KEY is not set. Add your vae_... API key to the MCP server's environment. " +
        "Create one in the VerifyAnyEmail dashboard → API Keys.",
    );
    this.name = "ApiKeyMissingError";
  }
}

class VaeClient {
  readonly sdk: VerifyAnyEmail;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.sdk = new VerifyAnyEmail(cfg.apiKey, { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
  }

  /** GET a diagnostic tool endpoint (/v1/tools/*). Does not spend verification credits. */
  async diagnostic(path: string, query: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: "application/json",
          "User-Agent": `verifyanyemail-mcp/${PKG_VERSION}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Request timed out after ${this.cfg.timeoutMs}ms.`);
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

let cachedClient: VaeClient | null = null;
function getClient(): VaeClient {
  const cfg = loadConfig();
  if (!cfg) throw new ApiKeyMissingError();
  if (!cachedClient) cachedClient = new VaeClient(cfg);
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

type ToolResult = {
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
function explain(err: unknown): string {
  if (err instanceof ApiKeyMissingError) return err.message;
  if (err instanceof VerifyAnyEmailError) {
    switch (err.status) {
      case 401:
        return "Authentication failed (401): the VerifyAnyEmail API key is missing, invalid, or revoked. Check VERIFYANYEMAIL_API_KEY.";
      case 402:
        return "Insufficient credits (402): this account is out of verification credits. Buy more credits or upgrade the plan in the VerifyAnyEmail dashboard.";
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
function tool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
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

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "verifyanyemail", version: PKG_VERSION });

const TEST_HINT =
  "Tip: addresses at the test.verifyany.email domain (e.g. deliverable@test.verifyany.email, undeliverable@…, risky@…, unknown@…) return canned results and cost 0 credits.";

server.tool(
  "verify_email",
  "Verify whether a single email address is real and safe to send to, in real time. " +
    "Returns a deliverability verdict (deliverable | undeliverable | risky | unknown), a 0–100 confidence " +
    "score, a safeToSend flag, and signals (catch-all, disposable, role-based, free provider, likely typo). " +
    "Spends 1 verification credit per call. " + TEST_HINT,
  {
    email: z.string().min(3).max(320).describe("The email address to verify, e.g. name@example.com"),
    smtpProbe: z
      .boolean()
      .optional()
      .describe("Set false to skip the live SMTP mailbox probe (DNS-only, faster, less certain). Default true."),
    catchAllDetection: z
      .boolean()
      .optional()
      .describe("Set false to skip catch-all domain detection. Default true."),
  },
  async ({ email, smtpProbe, catchAllDetection }) =>
    tool(async () => {
      const r = await getClient().sdk.verify(email, { smtpProbe, catchAllDetection });
      return ok(summarizeVerification(r));
    }),
);

server.tool(
  "verify_batch",
  "Submit many email addresses for asynchronous bulk verification. Returns a batchId immediately; the job " +
    "runs in the background. Poll get_batch_status until status is 'completed', then call get_batch_results. " +
    "Reserves 1 credit per address. Prefer verify_email for one-off checks.",
  {
    emails: z.array(z.string().min(3).max(320)).min(1).max(100000).describe("Array of email addresses to verify."),
    name: z.string().max(200).optional().describe("Optional human-friendly label for the batch."),
    webhookUrl: z
      .string()
      .url()
      .optional()
      .describe("Optional HTTPS URL to receive a signed batch.completed callback when the job finishes."),
  },
  async ({ emails, name, webhookUrl }) =>
    tool(async () => {
      const b = await getClient().sdk.verifyBatch(emails, { name, webhookUrl });
      return ok({ batchId: b.id, status: b.status, total: b.total, note: "Poll get_batch_status with this batchId." });
    }),
);

server.tool(
  "get_batch_status",
  "Check the progress of a bulk verification batch: lifecycle state (queued | processing | completed | failed), " +
    "how many addresses have been processed, and per-status counts once available.",
  {
    batchId: z.string().min(1).describe("The batchId returned by verify_batch."),
  },
  async ({ batchId }) =>
    tool(async () => {
      const b = await getClient().sdk.getBatch(batchId);
      return ok(b);
    }),
);

server.tool(
  "get_batch_results",
  "Fetch a page of results for a completed (or in-progress) bulk verification batch. Paginated — use page and " +
    "pageSize to walk large batches.",
  {
    batchId: z.string().min(1).describe("The batchId returned by verify_batch."),
    page: z.number().int().min(1).optional().describe("1-based page number. Default 1."),
    pageSize: z.number().int().min(1).max(1000).optional().describe("Rows per page (1–1000). Default 100."),
  },
  async ({ batchId, page, pageSize }) =>
    tool(async () => {
      const r = await getClient().sdk.getBatchResults(batchId, { page, pageSize });
      return ok(r);
    }),
);

// --- Deliverability diagnostics (do NOT spend verification credits) ---------

const domainArg = {
  domain: z.string().min(1).max(253).describe("The domain to inspect, e.g. example.com"),
};

server.tool(
  "check_mx",
  "Look up a domain's MX (mail exchanger) records and report whether it can receive email. Free — does not spend verification credits.",
  domainArg,
  async ({ domain }) => tool(async () => ok(await getClient().diagnostic("/v1/tools/mx", { domain }))),
);

server.tool(
  "check_spf",
  "Check a domain's SPF (Sender Policy Framework) record and flag common misconfigurations. Free — does not spend verification credits.",
  domainArg,
  async ({ domain }) => tool(async () => ok(await getClient().diagnostic("/v1/tools/spf", { domain }))),
);

server.tool(
  "check_dmarc",
  "Check a domain's DMARC policy (none | quarantine | reject) and alignment configuration. Free — does not spend verification credits.",
  domainArg,
  async ({ domain }) => tool(async () => ok(await getClient().diagnostic("/v1/tools/dmarc", { domain }))),
);

server.tool(
  "check_dkim",
  "Check a domain's DKIM signing record for a given selector. Free — does not spend verification credits.",
  {
    ...domainArg,
    selector: z.string().max(120).optional().describe("The DKIM selector to check, e.g. 'google' or 'mail'. Optional."),
  },
  async ({ domain, selector }) =>
    tool(async () => ok(await getClient().diagnostic("/v1/tools/dkim", { domain, selector }))),
);

server.tool(
  "check_domain_health",
  "Run an overall email-deliverability health check for a domain — combines MX, SPF, DKIM, DMARC and related " +
    "signals into a single graded summary with actionable findings. Free — does not spend verification credits.",
  domainArg,
  async ({ domain }) => tool(async () => ok(await getClient().diagnostic("/v1/tools/health", { domain }))),
);

// ---------------------------------------------------------------------------
// Start (stdio transport)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol stream.
  console.error(`verifyanyemail-mcp ${PKG_VERSION} ready (stdio).`);
  if (!loadConfig()) {
    console.error("WARNING: VERIFYANYEMAIL_API_KEY is not set — tools will return an auth error until it is.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
