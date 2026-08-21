# quickfile-mcp

MCP server for the [Quickfile REST API v2](https://api-beta.quickfile.co.uk/api-docs/). Multi-account, secret-isolated.

## Features

- **45 tools** -- one per API `operationId`, generated from the embedded `spec.json`.
- **Multi-account** -- configure multiple Quickfile accounts; each tool takes an `account` param.
- **Both auth modes** -- static Personal Bearer Tokens and OAuth 2.0 (auto-refresh + rotating refresh-token persistence).
- **Secret isolation** -- tokens live in `accounts.json` (gitignored), never exposed to the AI agent. Tool schemas expose only an `account` selector + endpoint params.

## Setup

### Option A: Claude Desktop Extension (.mcpb) — one-click install

1. Build and pack: `npm install && npm run build && npm install -g @anthropic-ai/mcpb && mcpb pack mcpb-build`
2. Open the resulting `mcpb-build.mcpb` file with Claude Desktop.
3. Claude prompts for **Accounts (JSON)** — paste your accounts config:
   ```json
   {"defaultAccount":"importair","accounts":[{"id":"importair","label":"Import Air","type":"static","token":"YOUR_TOKEN"}]}
   ```
   Stored in the OS keychain. Never written to disk, never exposed to the agent.
4. Click Install. Done.

### Option B: Manual (dev / non-Claude clients)

1. `npm install`
2. `cp accounts.example.json accounts.json` and fill in account credentials.
3. `npm run build`
4. Configure your MCP client (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "quickfile": {
      "command": "node",
      "args": ["path/to/quickfile-mcp/dist/index.js"],
      "cwd": "path/to/quickfile-mcp"
    }
  }
}
```

The server reads accounts from `QF_ACCOUNTS_CONFIG` env var (JSON string — used by the `.mcpb` path) if set, otherwise from `accounts.json` in the working directory (or `QF_ACCOUNTS_FILE` for a custom path). OAuth token material (`accessToken`, `refreshToken`, `expiresAt`) lives in a separate internal `tokens.json` (or `QF_TOKENS_FILE`) that the server manages — you never edit it by hand.

## Authentication

### Static token (own account)

Generate a Personal Bearer Token in QuickFile: **Account Settings -> Third Party Integration -> API**. In `accounts.json`, set `"type": "static"` and `"token": "<your token>"`.

### OAuth (partner app)

1. Register an app in QuickFile to get `clientId` / `clientSecret`. Put these in `accounts.json` with `"type": "oauth"`.
2. Complete the OAuth authorise + token-exchange flow out-of-band (a small CLI or manual paste) to obtain the first `accessToken`, `refreshToken`, and `expiresAt`.
3. Seed `tokens.json` once:
   ```json
   { "beta": { "accessToken": "...", "refreshToken": "...", "expiresAt": 0 } }
   ```
   After this, you never touch `tokens.json` — the server auto-refreshes expiring access tokens and persists the rotated refresh token back into it.

## Account selection

Every tool accepts an optional `account` parameter (enum of configured labels). Omit to use `defaultAccount` from `accounts.json`.

## API reference

Full endpoint schemas: `src/spec.json` (Swagger 2.0, 45 paths). Source: [Quickfile API docs](https://api-beta.quickfile.co.uk/api-docs/).
