// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { envelope, lampstand } from "../u2/helpers.js";
import { makeHouse } from "./helpers.js";

test("--body - reads the body from stdin: backticks and quotes arrive as typed, without the final newline", (t) => {
  const house = makeHouse(t);
  const markdown = 'Run `unify` with "quotes" and $HOME.\n\n```sh\nlampstand lint\n```';
  const result = lampstand(["task", "new", "Pipe it", "--body", "-", "--json"], { cwd: house.root, env: house.env, input: `${markdown}\n` });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = readFileSync(join(house.root, envelope(result.stdout).path), "utf8");
  assert.ok(text.includes(`# Pipe it\n\n${markdown}\n\n`), JSON.stringify(text));

  const captured = lampstand(["capture", "-", "--json"], { cwd: house.root, env: house.env, input: "first line\r\nsecond `line`\r\n" });
  assert.equal(captured.status, 0, captured.stdout + captured.stderr);
  assert.ok(readFileSync(join(house.root, envelope(captured.stdout).path), "utf8").includes("second `line`"));
});
