/**
 * tools.ts — build MCP Tool definitions from spec.json at runtime.
 * One tool per operationId. Each tool adds an `account` enum selector.
 * No tool ever exposes token/secret fields.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AccountConfig } from "./config.js";
import { request, QuickfileError } from "./client.js";

interface SwaggerParam {
    name: string;
    in: "path" | "query" | "body" | "formData" | "header";
    type?: string;
    format?: string;
    required?: boolean;
    description?: string;
    schema?: { $ref?: string; type?: string };
    items?: { type?: string };
    collectionFormat?: string;
}

interface SwaggerOp {
    operationId: string;
    summary?: string;
    description?: string;
    tags?: string[];
    parameters?: SwaggerParam[];
    responses?: Record<string, { description?: string; schema?: { $ref?: string } }>;
}

interface SwaggerSpec {
    paths: Record<string, Record<string, SwaggerOp>>;
    definitions?: Record<string, unknown>;
}

import spec from "./spec.json" with { type: "json" };

/** Every date param across the spec is documented as yyyy-MM-dd. Agents often pass ISO */
/** datetimes or DD/MM/YYYY instead — normalize so the API doesn't 400 on those. */
function isDateParamName(name: string): boolean {
    return /date/i.test(name);
}

function normalizeDateValue(raw: string): string {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // ISO datetime — take the date part.
    const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (isoMatch) return isoMatch[1];

    // DD/MM/YYYY (Quickfile is a UK product; assume UK day-first, not US month-first).
    const ukMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ukMatch) {
        const [, d, mo, y] = ukMatch;
        return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }

    // Use local getters, not toISOString() (which goes through UTC and can roll
    // date-only strings back a day depending on the server's timezone offset).
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    }

    return s; // Unrecognized — leave as-is, let the API return its own error.
}

const SWAGGER_TYPES: Record<string, "string" | "number" | "integer" | "boolean" | "array"> = {
    string: "string",
    integer: "integer",
    number: "number",
    boolean: "boolean",
    array: "array",
};

/** Convert a Swagger param to a JSON-Schema property. */
function paramToProperty(p: SwaggerParam): { schema: Record<string, unknown>; required: boolean } {
    const prop: Record<string, unknown> = {};
    if (p.description) prop.description = p.description;

    // multipart/form-data file field.
    if (p.in === "formData" && p.type === "file") {
        prop.type = "object";
        prop.description = `${p.description || "File content"}. Prefer "path" (a local file path — the server reads it directly, no transcription involved). Only use "base64" for small files (a few KB) you don't have on disk — for anything larger, retyping the encoded string risks silent corruption that Quickfile won't detect.`.trim();
        prop.properties = {
            path: { type: "string", description: "Absolute path to the file on the local filesystem the MCP server runs on. Preferred over base64 — avoids transcription errors on large files." },
            base64: { type: "string", description: "File content, base64-encoded. Only for small files without a local path — ignored if path is set." },
            filename: { type: "string", description: "Original filename, e.g. receipt.jpg. Defaults to the path's basename, or 'upload' with an inferred extension." },
            contentType: { type: "string", description: "MIME type, e.g. image/jpeg. Inferred from content if omitted." },
        };
        return { schema: prop, required: !!p.required };
    }
    if (p.in === "body" && p.schema?.$ref) {
        // Inline the referenced definition so the agent sees the body shape.
        const refName = p.schema.$ref.replace("#/definitions/", "");
        const def = (spec as SwaggerSpec).definitions?.[refName];
        if (def && typeof def === "object") {
            Object.assign(prop, def);
        } else {
            prop.type = "object";
            prop.description = `Body object (${refName}). See API docs.`;
        }
        return { schema: prop, required: !!p.required };
    }

    const swType = p.in === "body" ? p.schema?.type : p.type;
    if (p.type === "array" || swType === "array") {
        prop.type = "array";
        prop.items = { type: SWAGGER_TYPES[p.items?.type || "string"] || "string" };
    } else {
        prop.type = SWAGGER_TYPES[swType || "string"] || "string";
    }
    if (p.format === "int64") prop.description = `${prop.description || ""} (int64)`.trim();
    return { schema: prop, required: !!p.required };
}

export interface BuiltTool {
    tool: Tool;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Build all tools. Called once at server startup with the account labels. */
export function buildTools(accountLabels: string[]): BuiltTool[] {
    const s = spec as SwaggerSpec;
    const tools: BuiltTool[] = [];

    for (const [pathStr, ops] of Object.entries(s.paths)) {
        for (const [method, op] of Object.entries(ops)) {
            if (!op.operationId) continue;

            const properties: Record<string, object> = {};
            const required: string[] = [];

            // account selector — always first, never required (default applied in handler)
            properties.account = {
                type: "string",
                enum: accountLabels,
                description: "Quickfile account to use. Omit for default.",
            };

            const pathParams: SwaggerParam[] = [];
            const queryParams: SwaggerParam[] = [];
            let bodyParam: SwaggerParam | undefined;
            const formDataParams: SwaggerParam[] = [];

            for (const p of op.parameters || []) {
                const { schema, required: req } = paramToProperty(p);
                properties[p.name] = schema;
                if (req) required.push(p.name);
                if (p.in === "path") pathParams.push(p);
                else if (p.in === "query") queryParams.push(p);
                else if (p.in === "body") bodyParam = p;
                else if (p.in === "formData") formDataParams.push(p);
            }

            const toolName = op.operationId.toLowerCase();

            const tool: Tool = {
                name: toolName,
                description: op.summary || op.operationId,
                inputSchema: {
                    type: "object",
                    properties,
                    required: required.length > 0 ? required : undefined,
                },
            };

            // Capture loop vars for handler closure.
            const capturedMethod = method.toUpperCase();
            const capturedPath = pathStr;
            const capturedPathParams = pathParams;
            const capturedQueryParams = queryParams;
            const capturedBodyParam = bodyParam;
            const capturedFormDataParams = formDataParams;

            const handler = async (args: Record<string, unknown>): Promise<unknown> => {
                // Substitute path params.
                let path = capturedPath;
                for (const pp of capturedPathParams) {
                    const val = args[pp.name];
                    if (val === undefined) {
                        throw new Error(`Missing required path param: ${pp.name}`);
                    }
                    path = path.replace(`{${pp.name}}`, encodeURIComponent(String(val)));
                }

                // Build query params.
                const query: Record<string, string | number | boolean | string[] | undefined> = {};
                for (const qp of capturedQueryParams) {
                    let val = args[qp.name];
                    if (val === undefined) continue;
                    if (typeof val === "string" && isDateParamName(qp.name)) val = normalizeDateValue(val);
                    query[qp.name] = val as string | number | boolean | string[] | undefined;
                }

                // Body.
                const body = capturedBodyParam ? args[capturedBodyParam.name] : undefined;

                // Form data (multipart/form-data).
                const form: Record<string, unknown> = {};
                for (const fp of capturedFormDataParams) {
                    let val = args[fp.name];
                    if (val === undefined) continue;
                    if (typeof val === "string" && isDateParamName(fp.name)) val = normalizeDateValue(val);
                    form[fp.name] = val;
                }
                const formFileFields = capturedFormDataParams.filter((p) => p.type === "file").map((p) => p.name);

                // Account resolution happens in index.ts dispatch — handler receives account label.
                // The dispatch wrapper injects the AccountConfig. See tools.ts callTool.
                return {
                    _method: capturedMethod,
                    _path: path,
                    _query: query,
                    _body: body,
                    _formData: form,
                    _formFileFields: formFileFields,
                };
            };

            tools.push({ tool, handler });
        }
    }

    return tools;
}

/** Resolve account + call the API. Used by the server's CallToolRequest handler. */
export async function dispatchTool(
    built: BuiltTool[],
    toolName: string,
    args: Record<string, unknown>,
    accounts: Map<string, AccountConfig>,
    defaultAccount: string,
): Promise<unknown> {
    const found = built.find((t) => t.tool.name === toolName);
    if (!found) throw new Error(`Unknown tool: ${toolName}`);

    const label = (args.account as string) || defaultAccount;
    // Resolve by label or id.
    let acc = accounts.get(label);
    if (!acc) {
        const byId = Array.from(accounts.values()).find((a) => a.id === label);
        acc = byId;
    }
    if (!acc) throw new Error(`Unknown account: ${label}. Available: ${Array.from(accounts.values()).map((a) => `${a.id} (${a.label})`).join(", ")}`);

    const plan = (await found.handler(args)) as {
        _method: string;
        _path: string;
        _query: Record<string, unknown>;
        _body: unknown;
        _formData: Record<string, unknown>;
        _formFileFields: string[];
    };

    try {
        return await request(acc, {
            method: plan._method,
            path: plan._path,
            query: plan._query as Record<string, string | number | boolean | string[] | undefined>,
            body: plan._body,
            formData: plan._formData,
            formFileFields: plan._formFileFields,
        });
    } catch (e) {
        if (e instanceof QuickfileError) {
            // Surface rate-limit info; token already redacted by client.
            const rl = e.rateLimitRemaining !== undefined ? ` (remaining: ${e.rateLimitRemaining}/${e.rateLimitLimit})` : "";
            throw new Error(`${e.message}${rl}`);
        }
        throw e;
    }
}