/**
 * config.ts — load accounts from accounts.json (gitignored).
 * One block per account. OAuth token material (accessToken, refreshToken,
 * expiresAt) is stored separately in tokens.json (also gitignored, internal —
 * the end user never edits it; auth.ts manages it via refresh).
 *
 * accounts.json shape:
 * {
 *   "defaultAccount": "acme",
 *   "accounts": [
 *     { "id":"acme", "label":"acme", "type":"static", "token":"xxx" },
 *     { "id":"beta", "label":"beta", "type":"oauth", "clientId":"...", "clientSecret":"..." }
 *   ]
 * }
 *
 * tokens.json shape (internal, auto-managed):
 * {
 *   "beta": { "accessToken":"...", "refreshToken":"...", "expiresAt": 0 }
 * }
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type AccountConfig =
  | { id: string; label: string; type: "static"; token: string }
  | {
      id: string;
      label: string;
      type: "oauth";
      clientId: string;
      clientSecret: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number; // epoch ms
    };

interface TokensFile {
  [label: string]: { accessToken: string; refreshToken: string; expiresAt: number };
}

function tokensFilePath(): string {
  return resolve(process.env.QF_TOKENS_FILE || "tokens.json");
}

function accountsFilePath(): string {
  return resolve(process.env.QF_ACCOUNTS_FILE || "accounts.json");
}

/** Read internal tokens.json (may not exist yet for first OAuth bootstrap). */
function loadTokens(): TokensFile {
  const p = tokensFilePath();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8")) as TokensFile;
}

export function loadAccounts(): {
  accounts: Map<string, AccountConfig>;
  defaultAccount: string;
} {
  const filePath = accountsFilePath();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${filePath}. Copy accounts.example.json to accounts.json and fill in credentials.`,
    );
  }

  const data = JSON.parse(raw) as {
    defaultAccount?: string;
    accounts: Array<Record<string, unknown>>;
  };
  if (!data.accounts || data.accounts.length === 0) {
    throw new Error("accounts.json has no accounts. See accounts.example.json.");
  }

  const tokens = loadTokens();

  const accounts = new Map<string, AccountConfig>();
  for (const a of data.accounts) {
    const type = a.type;
    if (type !== "static" && type !== "oauth") {
      throw new Error(`Account ${a.label}: type must be 'static' or 'oauth', got '${type}'`);
    }
    if (type === "static") {
      if (typeof a.token !== "string") throw new Error(`Account ${a.label}: missing token`);
      accounts.set(String(a.label), {
        id: String(a.id || a.label),
        label: String(a.label),
        type: "static",
        token: a.token,
      });
    } else {
      if (typeof a.clientId !== "string") throw new Error(`Account ${a.label}: missing clientId`);
      if (typeof a.clientSecret !== "string") throw new Error(`Account ${a.label}: missing clientSecret`);
      // Token material comes from internal tokens.json, not accounts.json.
      const t = tokens[String(a.label)];
      if (!t) {
        throw new Error(
          `Account ${a.label}: no token material in ${tokensFilePath()}. Run OAuth bootstrap first.`,
        );
      }
      accounts.set(String(a.label), {
        id: String(a.id || a.label),
        label: String(a.label),
        type: "oauth",
        clientId: a.clientId,
        clientSecret: a.clientSecret,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      });
    }
  }

  const defaultAccount = data.defaultAccount || data.accounts[0].label as string;
  if (!accounts.has(defaultAccount)) {
    throw new Error(
      `defaultAccount='${defaultAccount}' not found. Available: ${Array.from(accounts.keys()).join(", ")}`,
    );
  }

  return { accounts, defaultAccount };
}

/** Persist OAuth token material back to tokens.json (internal, gitignored). */
export function persistTokens(label: string, t: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  const p = tokensFilePath();
  let data: TokensFile = {};
  if (existsSync(p)) {
    try { data = JSON.parse(readFileSync(p, "utf-8")) as TokensFile; } catch { data = {}; }
  }
  data[label] = t;
  writeFileSyncAtomic(p, JSON.stringify(data, null, 2));
}

import { writeFileSync } from "node:fs";
function writeFileSyncAtomic(p: string, s: string): void { writeFileSync(p, s, "utf-8"); }

/** All configured account labels — used to build the `account` enum on tools. */
export function accountLabels(): string[] {
  return Array.from(loadAccounts().accounts.keys());
}