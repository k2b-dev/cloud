import { existsSync } from "node:fs";
import { join } from "node:path";
import { capture, type Rule } from "./rule";

/** Generated app deployments and development identities match their sources. */
export const rule: Rule = {
  name: "app-deployments",
  description: "Generated app deployments are current (scripts/generate-app-deployments.ts --check)",
  run: async ({ workspaceRoot }) => {
    const script = join(workspaceRoot, "scripts", "generate-app-deployments.ts");
    if (!existsSync(script)) return [{ file: script, message: "missing generator; app deployments cannot be verified" }];
    const { code, output } = await capture(["bun", script, "--check"], { cwd: workspaceRoot });
    return code === 0 ? [] : [{ message: output || `generate-app-deployments.ts --check exited with ${code}` }];
  },
};
