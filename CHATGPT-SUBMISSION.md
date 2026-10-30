# ChatGPT Plugin (OpenAI) — Public Submission Pack

Portal: **platform.openai.com/plugins → "Upload new or existing plugin"** → remote server ("With MCP").

> ChatGPT's public submission is heavier than Claude's: a ZIP package + domain verification +
> 5 positive / 3 negative test cases + a demo video + identity verification.

---

## Prerequisites — YOU must do these
- **Role:** Organization **Owner**, or a member with the **Apps Management Write** role.
- **Identity verification:** complete **individual or business** verification in OpenAI org settings. The directory shows your verified name. (Start this early — it can take time.)
- **Project data residency:** submit from a project set to **global** data residency (EU-residency projects can't submit).
- **Demo video:** a short screen recording of connecting the plugin in ChatGPT and running a couple of tools; host it at a reviewer-accessible URL (`demo_recording_url`).

## Server — DONE (me)
- ✅ Public HTTPS MCP server: `https://mcp.verifyany.email/mcp`
- ✅ **OAuth 2.0** with Dynamic Client Registration (ChatGPT supports OAuth; API keys/bearer headers are NOT allowed for public submission — we use OAuth, and the `mcp.json` must declare **no static headers**).
- ✅ **Domain-verification endpoint** live at `/.well-known/openai-apps-challenge` — when OpenAI shows you the challenge token, send it to me and I'll serve it instantly (no restart).

## Listing fields (note OpenAI's tight limits)
- **displayName** (≤30): `VerifyAnyEmail`
- **shortDescription** (≤30): `Real-time email verification`
- **developerName** (≤80): `VerifyAnyEmail`
- **category:** Developer Tools (or Productivity)
- **websiteURL:** `https://verifyany.email`
- **supportURL:** `https://verifyany.email/contact`
- **privacyPolicyURL:** `https://verifyany.email/privacy`
- **termsOfServiceURL:** `https://verifyany.email/terms`
- **icon (logo):** `https://verifyany.email/icon-512.png` (square, PNG)
- **longDescription** (≤4000):
  > VerifyAnyEmail checks whether an email address is real and safe to send to, in real time — returning a clear verdict (deliverable, undeliverable, risky, or unknown), a 0–100 confidence score, and signals like catch-all, disposable, role-based, and likely typos. Verify a single address instantly, or submit many for asynchronous bulk verification and retrieve graded results.
  >
  > It also audits a domain's email deliverability setup — MX, SPF, DKIM and DMARC — with a combined health grade and actionable findings, so you can diagnose why mail bounces or lands in spam.
  >
  > Use it to clean a list before a campaign, block fake or disposable signups, validate addresses an agent collected, or troubleshoot a domain's email authentication. Verification spends credits from your VerifyAnyEmail account; deliverability checks are free. Sign in with your VerifyAnyEmail account (OAuth) to connect.
- **defaultPrompt** (optional, up to 3):
  - `Is jane.doe@stripe.com a valid, safe-to-send email address?`
  - `Verify this list and flag the bad ones: alice@acme.com, bob@mailinator.com`
  - `Check the email deliverability health of example.com`

## Review materials — 5 POSITIVE test cases
Each: description · prompt · tools_triggered · expected_behavior. (All use 0-credit `test.verifyany.email` addresses or free domain checks.)

1. **Verify a valid address**
   - prompt: `Is deliverable@test.verifyany.email a real, safe-to-send email address?`
   - tools_triggered: `verify_email`
   - expected_behavior: Calls verify_email; reports **deliverable**, high score, safeToSend true.
2. **Detect an undeliverable address**
   - prompt: `Can undeliverable@test.verifyany.email receive mail?`
   - tools_triggered: `verify_email`
   - expected_behavior: Reports **undeliverable** (mailbox not found).
3. **Flag a risky catch-all**
   - prompt: `Is risky@test.verifyany.email safe to send to?`
   - tools_triggered: `verify_email`
   - expected_behavior: Reports **risky** (catch-all); advises caution.
4. **Bulk-verify and summarize**
   - prompt: `Bulk-verify these and tell me which are bad: deliverable@test.verifyany.email, undeliverable@test.verifyany.email, risky@test.verifyany.email`
   - tools_triggered: `verify_batch`, `get_batch_status`, `get_batch_results`
   - expected_behavior: Submits a batch, polls status to completed, fetches results, summarizes each verdict.
5. **Audit a domain's deliverability**
   - prompt: `Check the email deliverability health of example.com and tell me what's misconfigured.`
   - tools_triggered: `check_domain_health`
   - expected_behavior: Returns a graded MX/SPF/DKIM/DMARC summary with findings.

## Review materials — 3 NEGATIVE test cases
Each: description · prompt · expected (no action / refusal / fallback).

1. **Unrelated request**
   - prompt: `What's the weather in Paris today?`
   - expected: Does **not** call any VerifyAnyEmail tool; answers normally or notes it only handles email verification.
2. **Out-of-scope action (sending email)**
   - prompt: `Send a marketing email to john@example.com for me.`
   - expected: Declines; explains the plugin **verifies** addresses and deliverability but **cannot send** email.
3. **Capability it doesn't offer (email finding)**
   - prompt: `Find the email address of the CEO of Acme Corp.`
   - expected: Does **not** fabricate or call a tool to "find" an address; explains it verifies given addresses but does not discover unknown ones.

## Reviewer credentials (enter in "Review details", NOT in the package)
> Connect `https://mcp.verifyany.email/mcp` and sign in via OAuth. On the "Connect VerifyAnyEmail" page, paste this API key: `vae_REVIEWER_KEY_HERE` (dedicated test account with credits). Then run the positive prompts above — the test.verifyany.email addresses cost 0 credits. Works without MFA/SMS/VPN.

## Release notes
`Initial release — real-time single & bulk email verification plus MX/SPF/DKIM/DMARC deliverability diagnostics (9 tools), OAuth 2.0 sign-in.`

## Compliance attestations (all true for us)
First-party API ✅ · no money/crypto transfers ✅ · no AI media generation ✅ · clean tool descriptions ✅ · no excess data collection ✅ · public docs live ✅.

---

### Still to assemble
- The **ZIP package** (manifest `plugin.json` + `mcp.json` with one remote server entry + icon). The portal validates it and shows errors; you can also start from your existing private plugin. (I can help build/validate this once you're at that step — ping me.)
- The **demo video** (you record).
- A **dedicated reviewer `vae_` key** (not your personal key).
