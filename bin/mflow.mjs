#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

runCli(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

