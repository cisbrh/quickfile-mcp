/**
 * auth.ts — resolve credential per account. Static tokens pass through;
 * OAuth tokens auto-refresh when stale and the rotated refresh token is
 * persisted back to tokens.json (internal, gitignored) so subsequent calls
 * use the new value.
 *
 * Secrets stay here. Only the final Authorization header value is returned.
 */
import type { AccountConfig } from "./config.js";
import { persistTokens } from "./config.js";

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh if <5min left
const TOKEN_ENDPOINT = "https://www.quickfile.co.uk/oauth/token";

/** Persist updated OAuth token material to tokens.json (internal). */
function persistOAuth(acc: AccountConfig & { type: "oauth" }): void {
  persistTokens(acc.label, {
    accessToken: acc.accessToken,
    refreshToken: acc.refreshToken,
    expiresAt: acc.expiresAt,
  });
}

async function refreshOAuth(acc: AccountConfig & { type: "oauth" }): Promise<void> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: acc.clientId,
    refresh_token: acc.refreshToken,
  });
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!resp.ok) {
    const body = await resp.text();
    // ponytail: no retry; agent can retry the tool call. ceiling: transient oauth errors.
    throw new Error(`OAuth refresh failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  acc.accessToken = data.access_token;
  acc.refreshToken = data.refresh_token; // rotated — must persist
  acc.expiresAt = Date.now() + data.expires_in * 1000;
  persistOAuth(acc);
}

/**
 * Returns the Authorization header value (token only, no "Bearer " prefix —
 * Quickfile expects the raw token in the Authorization header per the spec).
 */
export async function resolveAuth(acc: AccountConfig): Promise<string> {
  if (acc.type === "static") {
    return acc.token;
  }
  // oauth
  if (acc.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    await refreshOAuth(acc);
  }
  return acc.accessToken;
}