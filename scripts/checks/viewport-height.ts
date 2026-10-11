import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

export const rule: Rule = {
  name: "viewport-height",
  description: "Full-height surfaces use the visible dynamic viewport instead of the large viewport",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const name of packageIds(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.tsx$/)) {
        if (isTestFile(file)) continue;
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?<![\w-])(?:min-)?h-screen(?![\w-])/g)) {
          findings.push({
            file,
            line: source.slice(0, match.index).split("\n").length,
            message: `${match[0]} follows the large viewport; use ${match[0].replace("screen", "dvh")} to fit the visible window.`,
          });
        }
      }
    }
    return findings;
  },
};
