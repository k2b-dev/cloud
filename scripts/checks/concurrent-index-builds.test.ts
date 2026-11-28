import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, concurrentBuilds, rule } from "./concurrent-index-builds";

test("finds every concurrent index statement with its line, in any case and spelling", () => {
  const source = [
    "await sql`CREATE INDEX IF NOT EXISTS plain ON a.b(c)`;",
    "db.unsafe(`CREATE UNIQUE INDEX",
    "  CONCURRENTLY x ON a.b(c)`);",
    "await sql`create index concurrently y on a.b(c)`;",
    "db.unsafe(`CREATE ${unique}INDEX CONCURRENTLY z ON a.b(c)`);",
    "await sql`REINDEX INDEX CONCURRENTLY a.x`;",
    "await sql`DROP INDEX CONCURRENTLY IF EXISTS a.x`;",
    "await sql`DROP INDEX IF EXISTS a.x`;",
  ].join("\n");
  expect(concurrentBuilds(source)).toEqual([2, 4, 5, 6, 7]);
});

test("reports statements outside the helper, in packages and scripts, and stale allowlist entries; ignores the helper and tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrent-index-builds-"));
  try {
    for (const dir of ["packages/cloud/src/services", "packages/notes/src", "scripts/fixtures"])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "packages/cloud/src/services/concurrent-index.ts"), "`CREATE INDEX CONCURRENTLY ${name}`\n");
    await writeFile(join(root, "packages/notes/src/migrate.ts"), "\nawait sql`CREATE INDEX CONCURRENTLY notes_idx ON notes.items(id)`;\n");
    await writeFile(join(root, "packages/notes/src/migrate.test.ts"), "await sql`CREATE INDEX CONCURRENTLY t ON notes.items(id)`;\n");
    await writeFile(join(root, "scripts/fixtures/seed.ts"), "await sql`DROP INDEX CONCURRENTLY notes.notes_idx`;\n");
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.filter((finding) => finding.line).map((finding) => [finding.file, finding.line])).toEqual([
      ["scripts/fixtures/seed.ts", 1],
      ["packages/notes/src/migrate.ts", 2],
    ]);
    expect(findings.find((finding) => finding.line)?.message).toContain("UNIQUE index a transaction relies on is not one of those");
    // None of the allowed files exists here, so each one is stale.
    expect(findings.filter((finding) => !finding.line).map((finding) => finding.file)).toEqual(Object.keys(ALLOWED));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
