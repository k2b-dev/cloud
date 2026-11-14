import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./service-api-contracts";

test("Cloud app facade checks use the workspace application set, excluding standalone packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-service-contracts-"));
  try {
    const ids = ["cloud", "ui", "ssr", "editor", "cloud-cli", "speedtest", "example"];
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ids.map((id) => `packages/${id}`) } }));
    for (const id of ids) await mkdir(join(root, "packages", id, "src"), { recursive: true });
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings).toEqual([{ file: join(root, "packages/example/src/index.ts"), message: "Missing app index.ts facade file." }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
