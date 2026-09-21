import { existsSync } from "node:fs";
import { join } from "node:path";
import { capture, type Rule } from "./rule";

/** Generated configuration reference pages match the current env definitions. */
export const rule: Rule = {
  name: "config-docs",
  description: "Generated configuration documentation is current (scripts/generate-config-docs.ts --check)",
  run: async ({ workspaceRoot }) => {
    const script = join(workspaceRoot, "scripts", "generate-config-docs.ts");
    if (!existsSync(script)) return [{ file: script, message: "missing generator; configuration documentation cannot be verified" }];
    const { code, output } = await capture(["bun", script, "--check"], { cwd: workspaceRoot });
    return code === 0 ? [] : [{ message: output || `generate-config-docs.ts --check exited with ${code}` }];
  },
};
