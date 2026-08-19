/**
 * client.ts — fetch wrapper. Injects Authorization, surfaces rate-limit info,
 * redacts the token from any error output.
 */
import type { AccountConfig } from "./config.js";
import { resolveAuth } from "./auth.js";

const BASE_URL = "https://api-beta.quickfile.co.uk";

export interface RequestOptions {
  method: string;
  path: string; // e.g. "/invoices" or "/invoices/{id}" with {id} already substituted
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
}

export class QuickfileError extends Error {
  status: number;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  constructor(
    message: string,
    status: number,
    rateLimitLimit?: number,
    rateLimitRemaining?: number,
  ) {
    super(message);
    this.name = "QuickfileError";
    this.status = status;
    this.rateLimitLimit = rateLimitLimit;
    this.rateLimitRemaining = rateLimitRemaining;
  }
}

export async function request(
  acc: AccountConfig,
  opts: RequestOptions,
): Promise<unknown> {
  const token = await resolveAuth(acc);
  const url = new URL(BASE_URL + opts.path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: token,
    Accept: "application/json",
  };
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  const resp = await fetch(url, {
    method: opts.method,
    headers,
    body: bodyStr,
  });

  const limit = resp.headers.get("X-RateLimit-Limit");
  const remaining = resp.headers.get("X-RateLimit-Remaining");

  if (!resp.ok) {
    const text = await resp.text();
    // Redact any accidental token leakage from error bodies.
    const safe = text.replace(new RegExp(token, "g"), "[REDACTED]").slice(0, 500);
    throw new QuickfileError(
      `Quickfile API ${resp.status}: ${safe}`,
      resp.status,
      limit ? Number(limit) : undefined,
      remaining ? Number(remaining) : undefined,
    );
  }

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return resp.json();
  }
  // Non-JSON (e.g. PDF URL responses) — return as text.
  return resp.text();
}