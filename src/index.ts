#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, TranscriptDockClient } from "./client.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
    return;
  }
  const client = new TranscriptDockClient(config);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

// Only run as the CLI entry point (`transcriptdock-mcp` / `tsx src/index.ts`),
// never on import (tests import createServer without a live API key).
// Compare real paths: npx runs the bin through a node_modules/.bin symlink, and
// Windows paths never match a hand built file:// string.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`transcriptdock-mcp failed to start: ${(error as Error).message}`);
    process.exit(1);
  });
}
