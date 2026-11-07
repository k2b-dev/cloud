import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./ci-image-builds";

const build = (file?: string) =>
  `      - uses: docker/build-push-action@0000000000000000000000000000000000000000\n        with:\n          context: .\n${file ? `          file: ${file}\n` : ""}`;

const messages = async (steps: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-check-ci-image-builds-"));
  try {
    const directory = join(root, ".github", "workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "ci.yml"), `jobs:\n  images:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => finding.message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const all = ["Dockerfile", "docs-site/Dockerfile", "pwas/pwa-auth/Dockerfile", "pwas/notes/Dockerfile", "packages/runner/Dockerfile"];

test("accepts a gate that builds every release Dockerfile", async () => {
  expect(await messages(all.map(build).join(""))).toEqual([]);
});

test("a step without file builds the root Dockerfile", async () => {
  expect(await messages([build(), ...all.slice(1).map(build)].join(""))).toEqual([]);
});

test("flags the website Dockerfile when no job builds it", async () => {
  expect(
    await messages(
      all
        .filter((file) => file !== "docs-site/Dockerfile")
        .map(build)
        .join(""),
    ),
  ).toEqual(["docs-site/Dockerfile builds a release image but no ci.yml job builds it; add a docker/build-push-action step"]);
});
