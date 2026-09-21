import { existsSync } from "node:fs";
import { join } from "node:path";
import { capture, type Rule } from "./rule";

/** Formatting, lint, and import order for the whole repository through `biome ci`. */
export const rule: Rule = {
  name: "biome",
  description: "Biome formatter, linter, and import organizer (--fix writes safe fixes)",
  run: async ({ workspaceRoot, fix }) => {
    const bin = join(workspaceRoot, "node_modules", ".bin", "biome");
    if (!existsSync(bin)) return [{ message: "Missing node_modules/.bin/biome. Run 'bun install --frozen-lockfile' first." }];
    const args = fix ? ["check", "--write", "--colors=off", "."] : ["ci", "--colors=off", "."];
    const { code, output } = await capture([bin, ...args], { cwd: workspaceRoot });
    return code === 0 ? [] : [{ message: output }];
  },
};
