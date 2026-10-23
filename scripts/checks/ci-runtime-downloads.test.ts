import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../workspace";
import { rule } from "./ci-runtime-downloads";

test("current workflows use the retrying Playwright helper", async () => {
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
});

test("rejects inline server downloads in every workflow, even beside a helper call", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-runtime-rule-"));
  try {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    for (const [index, command] of [
      'docker run image npx -y "playwright@$version" run-server',
      "npm exec playwright run-server",
      ".github/start-playwright.sh\nnpx playwright@latest run-server",
    ].entries()) {
      await writeFile(
        join(root, `.github/workflows/test-${index}.yaml`),
        Bun.YAML.stringify({ jobs: { browser: { steps: [{ run: command }] } } }),
      );
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.message.includes(".github/start-playwright.sh"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
