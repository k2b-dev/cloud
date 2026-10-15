import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { rule } from "./ci-install";

const findings = async (steps: string, file = "ci.yml") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-check-ci-install-"));
  try {
    const directory = join(root, ".github", "workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file), `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}\n`);
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line} ${finding.message}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("flags a bare bun ci with its workflow and line", async () => {
  expect(await findings("      - run: bun ci")).toEqual([
    ".github/workflows/ci.yml:5 bun ci bypasses the bounded install and cache; use ./.github/actions/install",
  ]);
});

test("flags bun install inside a multi-line run", async () => {
  expect(await findings("      - run: |\n          echo installing\n          bun install --frozen-lockfile")).toEqual([
    ".github/workflows/ci.yml:7 bun install bypasses the bounded install and cache; use ./.github/actions/install",
  ]);
});

test("accepts the install action", async () => {
  expect(await findings("      - uses: ./.github/actions/install")).toEqual([]);
});

test("does not flag bun run or bunx", async () => {
  expect(await findings("      - run: |\n          bun run test\n          bunx biome ci .")).toEqual([]);
});

test("leaves release.yml alone, which installs from an older release commit", async () => {
  expect(await findings("      - run: bun ci", "release.yml")).toEqual([]);
});
