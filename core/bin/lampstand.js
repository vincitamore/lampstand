#!/usr/bin/env node
// @ts-check
// The CLI entry. Every verb is listed once in core/lib/verbs.js; dispatch lives in core/lib/cli.js and never names
// a verb.
import { runCli } from "../lib/cli.js";
import { registry } from "../lib/verbs.js";

process.exitCode = await runCli(registry(), process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
