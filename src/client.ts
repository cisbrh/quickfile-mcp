/**
 * client.ts — fetch wrapper. Injects Authorization, surfaces rate-limit info,
 * redacts the token from any error output.
 */
import type { AccountConfig } from "./config.js";
import { resolveAuth } from "./auth.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const BASE_URL = "https://api-beta.quickfile.co.uk";

/** Sniff a MIME type from magic bytes (images + PDF + common types). */
function sniffMime(bytes: Uint8Array): string {
    if (bytes.length < 4) return "application/octet-stream";
    const b = bytes;
    // JPEG: FF D8 FF
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    // GIF: 47 49 46 38
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
    // WebP: RIFF....WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
    // PDF: 25 50 44 46
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
    // BMP: 42 4D
    if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
    // TIFF: 49 49 2A 00 or 4D 4D 00 2A
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return "image/tiff";
    // HEIC: ....ftypheic/heix
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/heic";
    return "application/octet-stream";
}

/**
 * Check for a missing end-of-file marker, catching uploads truncated in transit
 * (e.g. a base64 blob cut off mid-paste) — Quickfile accepts malformed files
 * without complaint, so this has to be caught client-side.
 */
function looksTruncated(mime: string, bytes: Uint8Array): boolean {
    switch (mime) {
        case "application/pdf": {
            const tail = bytes.subarray(Math.max(0, bytes.length - 32));
            return !Buffer.from(tail).toString("latin1").includes("%%EOF");
        }
        case "image/jpeg":
            return bytes.length < 2 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9;
        case "image/png": {
            // A well-formed PNG's last 8 bytes are the IEND chunk (length=0 + "IEND" + CRC).
            if (bytes.length < 8) return true;
            return Buffer.from(bytes.subarray(bytes.length - 8, bytes.length - 4)).toString("latin1") !== "IEND";
        }
        default:
            return false; // No reliable end-of-file marker to check for this type.
    }
}

/** Map a MIME type to a file extension for the default upload filename. */
function mimeExt(mime: string): string {
    switch (mime) {
        case "image/jpeg": return ".jpg";
        case "image/png": return ".png";
        case "image/gif": return ".gif";
        case "image/webp": return ".webp";
        case "image/bmp": return ".bmp";
        case "image/tiff": return ".tiff";
        case "image/heic": return ".heic";
        case "application/pdf": return ".pdf";
        default: return "";
    }
}

export interface RequestOptions {
    method: string;
    path: string; // e.g. "/invoices" or "/invoices/{id}" with {id} already substituted
    query?: Record<string, string | number | boolean | string[] | undefined>;
    body?: unknown;
    // multipart/form-data — base64-encoded fields in `formFileFields` become Blob parts.
    formData?: Record<string, unknown>;
    formFileFields?: string[];
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
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
    let bodyStr: string | undefined;
    let formData: FormData | undefined;
    if (opts.formData && Object.keys(opts.formData).length > 0) {
        // multipart/form-data — fetch sets the Content-Type boundary automatically.
        formData = new FormData();
        for (const [k, v] of Object.entries(opts.formData)) {
            if (v === undefined) continue;
            if (opts.formFileFields?.includes(k) && (typeof v === "object" || typeof v === "string")) {
                // File field: agent passes { path } (read straight off local disk — no
                // base64 transcription, so no risk of a large string getting corrupted
                // in the model's own output), or { base64, filename?, contentType? },
                // or a raw base64 string.
                const fileObj = typeof v === "string" ? { base64: v } : v as { base64?: string; path?: string; filename?: string; contentType?: string };
                let bytes: Uint8Array<ArrayBuffer>;
                if (fileObj.path) {
                    try {
                        bytes = new Uint8Array(readFileSync(fileObj.path));
                    } catch (err) {
                        throw new Error(`File field "${k}": couldn't read local path "${fileObj.path}": ${(err as Error).message}`);
                    }
                } else if (fileObj.base64) {
                    // Strip an accidental data: URI prefix — Buffer.from silently skips the
                    // non-base64 characters in it, producing a truncated/corrupt file instead
                    // of an error, which the API then chokes on.
                    const dataUriMatch = fileObj.base64.match(/^data:[^;]*;base64,(.*)$/s);
                    const rawBase64 = dataUriMatch ? dataUriMatch[1] : fileObj.base64;
                    bytes = Uint8Array.from(Buffer.from(rawBase64, "base64"));
                } else {
                    throw new Error(`File field "${k}": provide either "path" (a local file path — preferred, avoids transcription errors) or "base64" (base64-encoded content).`);
                }
                if (bytes.length === 0) {
                    throw new Error(`File field "${k}" is empty — check the path or base64 content provided.`);
                }
                // Infer MIME from magic bytes if not supplied.
                const sniffed = sniffMime(bytes);
                const mime = fileObj.contentType || sniffed;
                // A declared type that disagrees with the actual bytes means the base64
                // was corrupted or mismatched in transit — Quickfile won't catch this itself.
                if (fileObj.contentType && sniffed !== "application/octet-stream" && fileObj.contentType !== sniffed) {
                    throw new Error(`File field "${k}": declared contentType "${fileObj.contentType}" doesn't match the file's actual content (looks like "${sniffed}"). The base64 data is likely corrupted or truncated — re-encode and resend.`);
                }
                if (looksTruncated(mime, bytes)) {
                    throw new Error(`File field "${k}": the decoded ${mime} data is missing its end-of-file marker, which means it's truncated or corrupted — likely cut off when the base64 was pasted or generated. Re-encode the full file and resend rather than uploading it.`);
                }
                const filename = fileObj.filename || (fileObj.path ? basename(fileObj.path) : `upload${mimeExt(mime)}`);
                formData.append(k, new Blob([bytes], { type: mime }), filename);
            } else {
                formData.append(k, String(v));
            }
        }
    } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        bodyStr = JSON.stringify(opts.body);
    }

    const resp = await fetch(url, {
        method: opts.method,
        headers,
        body: bodyStr ?? formData,
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