import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, concurrentBuilds, rule } from "./concurrent-index-builds";

test("finds concurrent index builds with their lines, unique ones too", () => {
  const source = [
    "await sql`CREATE INDEX IF NOT EXISTS plain ON a.b(c)`;",
    "db.unsafe(`CREATE UNIQUE INDEX",
    "  CONCURRENTLY x ON a.b(c)`);",
    "// CREATE INDEX CONCURRENTLY in prose",
  ].join("\n");
  expect(concurrentBuilds(source)).toEqual([2, 4]);
});

test("reports builds outside the helper and stale allowlist entries, and ignores the helper and tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrent-index-builds-"));
  try {
    for (const dir of ["packages/cloud/src/services", "packages/notes/src"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "packages/cloud/src/services/concurrent-index.ts"), "`CREATE INDEX CONCURRENTLY ${name}`\n");
    await writeFile(join(root, "packages/notes/src/migrate.ts"), "\nawait sql`CREATE INDEX CONCURRENTLY notes_idx ON notes.items(id)`;\n");
    await writeFile(join(root, "packages/notes/src/migrate.test.ts"), "await sql`CREATE INDEX CONCURRENTLY t ON notes.items(id)`;\n");
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.filter((finding) => finding.line).map((finding) => [finding.file, finding.line])).toEqual([
      ["packages/notes/src/migrate.ts", 2],
    ]);
    // None of the allowed files exists here, so each one is stale.
    expect(findings.filter((finding) => !finding.line).map((finding) => finding.file)).toEqual(Object.keys(ALLOWED));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
