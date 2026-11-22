import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Finding, Rule } from "./rule";

const workflowPath = ".github/workflows/main.yml";

export type ReleasePleasePin = { sha: string; version: string | undefined; line: number };

/**
 * Every release-please-action pin in a workflow with the release-please version its comment
 * names, as in `@<sha> # v5.0.0, release-please 17.6.0`.
 */
export const releasePleasePins = (text: string): ReleasePleasePin[] =>
  [...text.matchAll(/\buses:\s*googleapis\/release-please-action@([0-9a-f]{40})([^\n]*)/gi)].map((match) => ({
    sha: match[1] ?? "",
    version: /#.*\brelease-please (\d+\.\d+\.\d+)\b/.exec(match[2] ?? "")?.[1],
    line: text.slice(0, match.index).split("\n").length,
  }));

const manifestSchema = z.object({ devDependencies: z.record(z.string(), z.string()).default({}) });

/**
 * scripts/check-release-pr-body.ts parses with the release-please root devDependency instead
 * of the action that main.yml runs. Both must be the same release-please, or the PR-time
 * parse drifts from the one that writes the changelog (#1592).
 */
export const rule: Rule = {
  name: "release-please-version",
  description: "the release-please devDependency is the version that main.yml's release-please-action pin names",
  run: async ({ workspaceRoot }) => {
    const workflow = join(workspaceRoot, workflowPath);
    const manifest = join(workspaceRoot, "package.json");
    const pins = releasePleasePins(readFileSync(workflow, "utf8"));
    const installed = manifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8"))).devDependencies["release-please"];
    const findings: Finding[] = [];
    if (!installed)
      findings.push({ file: manifest, message: "devDependencies must pin release-please, the parser of scripts/check-release-pr-body.ts" });
    if (pins.length !== 1) findings.push({ file: workflow, message: `expected one release-please-action pin, found ${pins.length}` });
    for (const pin of pins) {
      if (!pin.version) {
        findings.push({
          file: workflow,
          line: pin.line,
          message: "name the bundled release-please version in the pin comment, as in `# v5.0.0, release-please 17.6.0`",
        });
      } else if (installed && pin.version !== installed) {
        findings.push({
          file: workflow,
          line: pin.line,
          message: `the action pin names release-please ${pin.version}, but package.json pins ${installed}; keep both on the action's version`,
        });
      }
    }
    return findings;
  },
};
