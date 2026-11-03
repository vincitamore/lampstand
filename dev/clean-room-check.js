#!/usr/bin/env node
// @ts-check
// Hosts walk up from the working tree and load the instruction files they find, so a build run beneath someone's
// house picks up rules this package must not depend on. Exits 1 when any ancestor of the repository root holds a
// file a host loads as context: AGENTS.md, CLAUDE.md, house.toml, .claude/CLAUDE.md, or a non-empty .omp/ (which
// also ends OMP's walk-up). Settings-only directories and the user's own home-level host config are not context a
// walk-up loads, so they are not markers.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["AGENTS.md", "CLAUDE.md", "house.toml", join(".claude", "CLAUDE.md")];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(homedir());

const found = [];
for (let dir = root; dirname(dir) !== dir; ) {
  dir = dirname(dir);
  for (const file of FILES) {
    const path = join(dir, file);
    if (existsSync(path) && statSync(path).isFile()) found.push(path);
  }
  const omp = join(dir, ".omp");
  if (dir !== home && existsSync(omp) && statSync(omp).isDirectory() && readdirSync(omp).length > 0) found.push(omp);
}

if (found.length === 0) {
  process.stdout.write(`clean-room: no house markers above ${root}\n`);
  process.exit(0);
}
process.stderr.write(
  `clean-room: ${root} sits beneath agent instructions:\n${found.map((path) => `  ${path}`).join("\n")}\n`,
);
process.exit(1);
