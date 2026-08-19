# Quickfile MCP — Plan

> Status: **planning only, no implementation.**
> Source of truth: Quickfile REST API v2 (beta) — `https://api-beta.quickfile.co.uk/api-docs/` (Swagger 2.0) + `https://support.quickfile.co.uk/t/rest-api-overview/64912`.

## 1. Goal

MCP server exposing the Quickfile REST API v2 to AI agents.
- Multi-account / multi-company: one MCP instance serves several Quickfile accounts.
- Secrets never exposed to the agent: tokens live server-side, agent only selects an account by id/label.

## 2. API facts (verified from live docs)

| Item | Value |
|---|---|
| Base URL | `https://api-beta.quickfile.co.uk` |
| Spec | Swagger 2.0, 45 paths, `info.version: v2` |
| Auth header | `Authorization: {token}` (apiKey in header, name `Authorization`) |
| Auth mode A | **Personal Bearer Token** — static, per-account, generated in QuickFile UI (Account Settings → Third Party Integration → API). Endpoint-group scopes + optional IP allowlist. |
| Auth mode B | **OAuth 2.0** (partner apps) — `authorization_code`, JWT `access_token` (1h / 3600s), **rotating** `refresh_token`. Scopes: `invoices clients suppliers purchases reports payments banks ledgers projects documents journals`. |
| OAuth endpoints | Authorise: `GET https://www.quickfile.co.uk/oauth/authorize` · Token: `POST https://www.quickfile.co.uk/oauth/token` |
| Rate limit | 5000 req / rolling 24h per token. Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`. |
| Body | `application/json` for POST/PUT. |

### Endpoint inventory (45, by tag)

```
Account       GET /account/me
Bank          GET /bank_accounts · POST /bank_accounts · GET /bank_accounts/{id}/transactions · POST /bank_accounts/{id}/transactions
              GET /bank_accounts/{id}/balance · GET /banks
Client        GET /clients · POST /clients · GET/PUT/DELETE /clients/{id}
              GET /clients/{id}/contacts · POST /clients/{id}/contacts · PUT/DELETE /clients/{id}/contacts/{contactId}
              GET /clients/styles · POST /clients/{id}/login · POST /clients/{id}/new-direct-debit
Client pay    GET /client_payments · POST /client_payments · GET/DELETE /client_payments/{id}
Document      POST /documents/receipt · POST /documents/sales · POST /documents/general
Inventory     GET /inventory · POST /inventory · GET/DELETE /inventory/{id}
Invoice       GET /invoices · POST /invoices · GET/PUT/DELETE /invoices/{id} · GET /invoices/{id}/get-pdf · POST /invoices/send
Journal       GET /journals · POST /journals · GET/DELETE /journals/{id}
Ledger        GET /ledgers · GET /ledgers/nominals
Project       GET /projects · POST /projects · DELETE /projects
Purchase      GET /purchases · POST /purchases · GET/PUT/DELETE /purchases/{id}
Purchase ord  POST /purchase-orders · GET/PUT/DELETE /purchase-orders/{id}
Reports       GET /reports/chart-of-accounts · /balance-sheet · /ageing · /profit-and-loss · /vat-obligations · /subscriptions · /eventlog
Supplier      GET /suppliers · POST /suppliers · GET/PUT/DELETE /suppliers/{id}
              GET /suppliers/{id}/contacts · POST /suppliers/{id}/contacts · PUT/DELETE /suppliers/{id}/contacts/{contactId}
Supplier pay  GET /supplier_payments · POST /supplier_payments · GET/DELETE /supplier_payments/{id}
```

Full param/response schemas live in the embedded `spec.json` (source of truth — do not hand-transcribe).

## 3. Multi-account design

- Config maps **account id** → credentials.
  - Static token accounts: `{ id, label, token }`.
  - OAuth accounts: `{ id, label, clientId, clientSecret, accessToken, refreshToken, expiresAt }`.
- Every tool takes an optional `account` param (enum of configured labels). Missing → `defaultAccount`.
- The agent never receives or sends the token. The server resolves `account` → credentials and injects `Authorization`.
- OAuth refresh: server auto-refreshes when `expiresAt` < now+5min; persists the **rotated** refresh token back to config (file or secret store). Refresh is transparent to the agent.

## 4. Secret isolation (hard requirement)

- Tool `inputSchema` exposes **only** `account` selector + endpoint params. No token/secret fields.
- Credentials resolved from env or a secrets file outside git:
  - Config values support `${ENV_VAR}` interpolation → actual secrets never written to the committed config.
  - `accounts.example.json` committed as a template (placeholders only).
- HTTP client redacts `Authorization` from any error/log output.
- No tool returns token material. Response bodies from Quickfile are passed through unchanged (they don't contain tokens).

## 5. Tool surface

One MCP tool per `operationId` (45 tools). Generated from `spec.json`, not hand-written — keeps drift risk at zero.

Naming: `{tag}_{verb}` lowercased, e.g. `invoice_search`, `bank_search`, `client_get`, `reports_profit_and_loss`.

Each tool:
```jsonc
{
  "name": "invoice_search",
  "description": "<spec.summary>",
  "inputSchema": {
    "type": "object",
    "properties": {
      "account": { "enum": ["acme", "beta"], "default": "acme" },
      // ...path/query/body params lifted from spec.parameters
    },
    "required": [/* path params only */]
  }
}
```
Responses: return raw JSON body. Optional later: trim large arrays + include pagination hints. (YAGNI for v1.)

## 6. Architecture

```
src/
  index.ts     # MCP server, stdio transport, register tools
  config.ts    # load accounts.json, ${ENV} interpolation, validate
  auth.ts      # resolve credential per account; OAuth refresh+rotate
  client.ts    # fetch wrapper: base URL, inject Authorization, rate-limit headers, redact on error
  tools.ts     # build Tool[] from spec.json; dispatch call → client.request
  spec.json    # embedded Quickfile Swagger 2.0 spec (fetched once, committed)
accounts.example.json
package.json
tsconfig.json
README.md
```

Stack: TypeScript, `@modelcontextprotocol/sdk`, Node 18+ `fetch`. No DB, no web UI, no extra deps unless OAuth refresh needs a JWT decode (it doesn't — trust `expires_in`).

## 7. Out of scope (YAGNI)

- No OAuth callback server inside MCP. Token bootstrap (authorise → code → exchange) happens out-of-band via a small separate CLI or manual paste; MCP only **consumes** stored tokens + refreshes.
- No retries beyond respecting `X-RateLimit-Remaining` (429 → error to agent; agent can retry).
- No response shaping/sorting beyond what the API returns.
- No caching.

## 8. Decisions (locked)

1. **Auth modes:** **both** — static Personal Bearer Token **and** OAuth 2.0 (with refresh + rotating refresh-token persistence). `auth.ts` resolves either per account.
2. **Secret storage:** **`.env`** (dotenv). One row per account/token. No secrets in git. `.env.example` committed as template.
3. **Account selection:** **explicit `account` param** on every tool, with a configured `defaultAccount` fallback. Enum of configured labels.
4. **Tool granularity:** **per-endpoint** — 45 tools, one per `operationId`.
5. **Spec source:** **commit `spec.json`** (fetched once from `api-beta`, embedded). No runtime fetch of the spec.

## 9. Risks

- API is **beta** ("may not be available to all users"). Spec may change → embedding `spec.json` + regenerating tools is the mitigation.
- OAuth refresh-token rotation: must persist the new refresh token or the account falls out of sync. One-shot write back to config file.
- Rate limit is per-token, not per-install: multi-account naturally spreads load, but a single busy account can hit 5000/24h.

## 10. Tests

None. Private project — no test suite.