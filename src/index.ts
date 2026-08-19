#!/usr/bin/env node
/**
 * index.ts — Quickfile MCP server (stdio transport).
 * Multi-account, secret-isolated. Agent selects account by label; never sees tokens.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadAccounts } from "./config.js";
import { buildTools, dispatchTool } from "./tools.js";

async function main(): Promise<void> {
  const { accounts, defaultAccount } = loadAccounts();
  const labels = Array.from(accounts.keys());
  const built = buildTools(labels);

  const server = new Server(
    { name: "quickfile-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: built.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await dispatchTool(built, name, args || {}, accounts, defaultAccount);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});