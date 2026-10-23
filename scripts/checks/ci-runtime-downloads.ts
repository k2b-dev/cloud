import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowSchema } from "./ci-gate";
import type { Finding, Rule } from "./rule";

/** Keep server installation, retries and readiness in one reviewed helper. */
export const rule: Rule = {
  name: "ci-runtime-downloads",
  description: "workflows start Playwright through the retrying, catalog-pinned helper",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const path of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync(workspaceRoot)) {
      const file = join(workspaceRoot, path);
      const workflow = workflowSchema.parse(Bun.YAML.parse(readFileSync(file, "utf8")));
      for (const [job, { steps }] of Object.entries(workflow.jobs)) {
        for (const step of steps) {
          const command = (step.run ?? "").replace(/^\s*#.*$/gm, "");
          if (/\brun-server\b/.test(command)) {
            findings.push({ file, message: `${job}: start Playwright with .github/start-playwright.sh instead of inline run-server` });
          }
        }
      }
    }
    return findings;
  },
};
