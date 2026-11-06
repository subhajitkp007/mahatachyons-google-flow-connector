#!/usr/bin/env node
import { startMcpServer } from "../src/mcp.mjs";

startMcpServer().catch((err) => {
  console.error(`MCP Server Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

