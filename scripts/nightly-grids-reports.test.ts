import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

const step = z.object({
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.string()).optional(),
});
const workflow = z.object({ jobs: z.object({ grids: z.object({ steps: z.array(step) }) }) });

test("Nightly preserves the failed Grids certification process logs and JUnit reports", () => {
  const nightly = workflow.parse(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8")));
  const steps = nightly.jobs.grids.steps;
  const verify = steps.findIndex((step) => step.run === "bun run --cwd packages/grids test:all");
  expect(verify).toBeGreaterThanOrEqual(0);
  const reports = steps[verify]?.env?.GRIDS_VERIFY_REPORTS_DIR;
  expect(reports).toBe("${{ runner.temp }}/grids-certification");
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload).toBeGreaterThan(verify);
  expect(steps[upload]?.if).toBe("failure()");
  expect(steps[upload]?.with?.path).toBe(reports);
  expect(steps[upload]?.with?.name).toContain("${{ github.run_id }}");
  expect(steps[upload]?.with?.name).toContain("${{ github.run_attempt }}");
  const cleanup = steps.findIndex((step) => step.run?.includes("docker rm --force grids-postgres grids-nats"));
  expect(cleanup).toBeGreaterThan(upload);
  expect(steps[cleanup]?.if).toBe("always()");
});

test("Nightly installs Chromium before Grids certification starts its browser suites", () => {
  const nightly = workflow.parse(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8")));
  const steps = nightly.jobs.grids.steps;
  const install = steps.findIndex((step) => step.run === "./packages/grids/node_modules/.bin/playwright install chromium");
  const verify = steps.findIndex((step) => step.run === "bun run --cwd packages/grids test:all");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(install);
});
