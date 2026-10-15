import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Finding, Rule } from "./rule";

const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(z.object({ run: z.string().optional() })).default([]) })),
});

/**
 * release.yml checks out the release commit, which can predate the install
 * action when an older release is finished again, so it keeps `bun ci`.
 */
const exempt = new Set(["release.yml"]);

/** Workflows install only through the cache restore and bounded install action. */
export const rule: Rule = {
  name: "ci-install",
  description: "workflow dependency installs use ./.github/actions/install",
  run: async ({ workspaceRoot }) => {
    const directory = join(workspaceRoot, ".github", "workflows");
    const findings: Finding[] = [];
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".yml") && !exempt.has(name))
      .sort()) {
      const file = join(directory, name);
      const text = readFileSync(file, "utf8");
      const parsed = workflowSchema.safeParse(Bun.YAML.parse(text));
      if (!parsed.success) {
        findings.push({ file, message: `unexpected workflow shape:\n${z.prettifyError(parsed.error)}` });
        continue;
      }
      for (const [id, job] of Object.entries(parsed.data.jobs)) {
        let cursor = Math.max(0, text.indexOf(`\n  ${id}:`));
        for (const step of job.steps) {
          if (step.run === undefined) continue;
          const runStart = /\brun:/.exec(text.slice(cursor));
          if (runStart) cursor += runStart.index + runStart[0].length;
          for (const match of step.run.matchAll(/\bbun\s+(?:ci|install)\b/g)) {
            const index = text.indexOf(match[0], cursor);
            findings.push({
              file,
              line: text.slice(0, index === -1 ? cursor : index).split("\n").length,
              message: `${match[0]} bypasses the bounded install and cache; use ./.github/actions/install`,
            });
            if (index !== -1) cursor = index + match[0].length;
          }
        }
      }
    }
    return findings;
  },
};
