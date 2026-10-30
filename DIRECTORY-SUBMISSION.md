# Claude Connectors Directory — Submission Pack

Portal: https://claude.ai/directory/manage → **Submit new** → **MCP connector**.
(Most fields below also map 1:1 to OpenAI's ChatGPT plugin submission.)

---

## 1. Connection
- **Server URL:** `https://mcp.verifyany.email/mcp`
- Single URL (not per-customer). Leave "Users connect to different URLs" unchecked.

## 2. Tools
- Sync automatically from the server. All 9 carry `title` + `readOnlyHint` — no flags expected.

## 3. Listing
- **Name:** `VerifyAnyEmail`
- **One-liner (≤200):**
  `Real-time email verification and deliverability checks — confirm an address is real and safe to send to, and audit MX, SPF, DKIM and DMARC.`
- **Description (≤2,000):**
  > VerifyAnyEmail lets Claude check whether an email address is real and safe to send to, in real time — returning a clear verdict (deliverable, undeliverable, risky, or unknown), a 0–100 confidence score, and signals like catch-all, disposable, role-based, and likely typos. Verify a single address instantly, or submit thousands for asynchronous bulk verification and poll for results.
  >
  > It also audits a domain's email deliverability setup: MX records, SPF, DKIM and DMARC, plus a combined domain-health grade with actionable findings — so you can diagnose why mail bounces or lands in spam.
  >
  > Typical uses: clean a list before a campaign, block fake or disposable signups, validate addresses captured by an agent, or troubleshoot a domain's email authentication.
  >
  > Verification spends credits from your VerifyAnyEmail account; deliverability checks are free. Test addresses at `test.verifyany.email` (e.g. `deliverable@test.verifyany.email`) return canned results at zero cost. Sign in with your VerifyAnyEmail account to connect.
- **Categories (pick 1–5 from the portal):** Developer Tools · Marketing · Productivity · Sales (choose the closest offered)
- **Documentation URL:** `https://verifyany.email/mcp`
- **Privacy policy URL:** `https://verifyany.email/privacy`
- **Support contact:** `support@verifyany.email`
- **Icon:** square PNG of the VerifyAnyEmail logo (≥512×512 recommended) — *you provide*
- **URL slug (permanent):** `verifyanyemail`

## 4. Use cases
- **Primary use cases:** pre-campaign list cleaning; blocking fake/disposable signups; validating addresses an agent collected; auditing a domain's SPF/DKIM/DMARC/deliverability.
- **What users need before connecting:** a VerifyAnyEmail account and an API key (free tier available at https://verifyany.email).
- **Reads or writes:** primarily **reads** (verification + diagnostics). `verify_email`/`verify_batch` consume credits but do not modify or delete user data.

## 5. Company
- **Company:** VerifyAnyEmail
- **Website:** `https://verifyany.email`
- **Review contact:** `support@verifyany.email` (or your email)

## 6. Authentication
- **Requirement:** Sign in **required**.
- **Method:** **OAuth 2.0**.
- **OAuth client:** leave Anthropic-held client ID/secret **blank** — the server supports Dynamic Client Registration, so Claude registers itself automatically. (Metadata: `https://mcp.verifyany.email/.well-known/oauth-authorization-server`.)

## 7. Data handling
- Underlying API is **your own** (first-party). Not proxied, not third-party.
- **No** personal health data. **No** sponsored content.

## 8. Test & launch (reviewer instructions)
Paste something like this, and create a dedicated reviewer account + key first:

> 1. Add the connector `https://mcp.verifyany.email/mcp` in Claude → Settings → Connectors → Add custom connector.
> 2. When prompted to sign in, paste this VerifyAnyEmail API key on the consent page: `vae_REVIEWER_KEY_HERE` (test account: reviewer@yourdomain, pre-loaded with credits).
> 3. Try: "Verify deliverable@test.verifyany.email" → returns status **deliverable** (0 credits).
>    Try: "Verify undeliverable@test.verifyany.email" and "risky@test.verifyany.email" → return undeliverable / risky (0 credits).
>    Try: "Check the email health of example.com" → returns an MX/SPF/DKIM/DMARC summary (free).
> 4. All tools run without any destructive action; verification against real addresses spends 1 credit each.

- Confirm you've run every tool yourself (MCP Inspector or as a custom connector).

## 9. Compliance
Tick all 7 acknowledgments (directory guidelines, first-party API, financial transactions, AI media, prompt injection, conversation data, public docs).

## 10. Review & submit
Resolve any quality warnings, then submit. It's auto-scanned and typically listed as a **Community** connector; some get human review. Track status at claude.ai/directory/manage. Escalations: `mcp-review@anthropic.com`.

---

### You still need to provide
- A square **PNG icon**.
- A **reviewer test account** + a dedicated `vae_` API key (don't reuse your personal key).
- A **paid Claude plan** to submit.
