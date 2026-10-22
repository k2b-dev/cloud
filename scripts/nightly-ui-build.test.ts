import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

const workflow = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(z.object({ run: z.string().optional() })) })),
});

test("Nightly builds UI before loading repository checks in each job", () => {
  const nightly = workflow.parse(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8")));
  let checked = 0;
  for (const [name, job] of Object.entries(nightly.jobs)) {
    const check = job.steps.findIndex((step) => /\bbun run check(?:\s|$)/.test(step.run ?? ""));
    if (check < 0) continue;
    checked++;
    const build = job.steps.findIndex((step) => step.run === "bun run --cwd packages/ui build");
    expect(build, `${name} must build the UI exports before the check runner imports its rules`).toBeGreaterThanOrEqual(0);
    expect(build, `${name} must build UI before running checks`).toBeLessThan(check);
  }
  expect(checked).toBeGreaterThan(0);
});
