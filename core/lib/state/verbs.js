// @ts-check
import { join } from "node:path";
import { loadHouseConfig } from "../config.js";
import { fail } from "../errors.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { stateDirFor } from "./paths.js";

/** @type {import("../cli.js").Verb} */
export const statePathVerb = {
  name: "state path",
  summary: "print the per-machine state directory of the resolved house (without creating it)",
  flags: WORKSPACE_FLAGS,
  run({ env, cwd, flags }) {
    const found = resolveHouse({ env, cwd, workspace: !flags["no-workspace"] });
    if (found.root === null) throw fail("E_NO_HOUSE", "no house resolved, so there is no state directory");
    const { house } = loadHouseConfig(found.root);
    const { dir, source } = stateDirFor(found.root, house.id, env);
    return {
      data: { house: found.root, dir, db: join(dir, "house.db"), source },
      text: dir,
    };
  },
};

export const stateVerbs = [statePathVerb];
