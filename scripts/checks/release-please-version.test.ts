import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { releasePleasePins, rule } from "./release-please-version";

const sha = "45996ed1f6d02564a971a2fa1b5860e934307cf7";

const findings = async (comment: string, devDependencies: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-check-release-please-version-"));
  try {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".github", "workflows", "main.yml"),
      `jobs:\n  release:\n    steps:\n      - uses: googleapis/release-please-action@${sha}${comment}\n`,
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies }));
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? ""} ${finding.message}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts the version the pin comment names", async () => {
  expect(await findings(" # v5.0.0, release-please 17.6.0", { "release-please": "17.6.0" })).toEqual([]);
});

test("rejects a devDependency that drifted from the pin", async () => {
  expect(await findings(" # v5.0.0, release-please 17.6.0", { "release-please": "17.7.0" })).toEqual([
    ".github/workflows/main.yml:4 the action pin names release-please 17.6.0, but package.json pins 17.7.0; keep both on the action's version",
  ]);
});

test("rejects a pin comment without the release-please version and a missing devDependency", async () => {
  expect(await findings(" # v5.0.0", {})).toEqual([
    "package.json: devDependencies must pin release-please, the parser of scripts/check-release-pr-body.ts",
    ".github/workflows/main.yml:4 name the bundled release-please version in the pin comment, as in `# v5.0.0, release-please 17.6.0`",
  ]);
});

test("reads the pin of the repository's main.yml", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../.github/workflows/main.yml")).text();
  expect(releasePleasePins(text).map((pin) => pin.version)).toEqual(["17.6.0"]);
});
