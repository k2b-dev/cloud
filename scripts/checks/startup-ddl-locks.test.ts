import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE, lockingStatements, rule } from "./startup-ddl-locks";

test("finds IF NOT EXISTS columns and indexes with their lines, but not concurrent builds", () => {
  const source = [
    "await sql`ALTER TABLE a.b ADD COLUMN IF NOT EXISTS c TEXT`;",
    "await sql`CREATE UNIQUE INDEX",
    "  IF NOT EXISTS i ON a.b(c)`;",
    "await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS j ON a.b(c)`;",
    'await addColumns(sql, "a.b", { d: "TEXT" });',
    "await sql`alter table a.b add column if not exists e text`;",
  ].join("\n");
  expect(lockingStatements(source)).toEqual([1, 2, 6]);
});

test("allows the baseline, reports growth and stale entries, ignores the helper and tests, and --fix only lowers", async () => {
  const root = await mkdtemp(join(tmpdir(), "startup-ddl-locks-"));
  try {
    for (const dir of ["packages/cloud/src/services", "packages/notes/src", "scripts/checks"])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "packages/cloud/src/services/migration-ddl.ts"), "`ADD COLUMN IF NOT EXISTS ${name}`\n");
    await writeFile(join(root, "packages/notes/src/migrate.test.ts"), "await sql`ALTER TABLE n.t ADD COLUMN IF NOT EXISTS a TEXT`;\n");
    await writeFile(
      join(root, "packages/notes/src/migrate.ts"),
      "await sql`ALTER TABLE n.t ADD COLUMN IF NOT EXISTS a TEXT`;\n\nawait sql`CREATE INDEX IF NOT EXISTS i ON n.t(a)`;\n",
    );
    await writeFile(join(root, "packages/notes/src/old.ts"), "await sql`ALTER TABLE n.o ADD COLUMN IF NOT EXISTS a TEXT`;\n");
    await writeFile(join(root, BASELINE), "# header\n1 packages/notes/src/migrate.ts\n3 packages/notes/src/old.ts\n");
    const run = (fix: boolean) => rule.run({ workspaceRoot: root, fix, flags: new Set() });

    const findings = await run(false);
    expect(findings.map((finding) => [finding.file, finding.line])).toEqual([
      ["packages/notes/src/migrate.ts", 3],
      ["packages/notes/src/old.ts", undefined],
    ]);

    expect((await run(true)).map((finding) => finding.file)).toEqual(["packages/notes/src/migrate.ts"]);
    const baseline = await readFile(join(root, BASELINE), "utf8");
    expect(baseline).toContain("1 packages/notes/src/migrate.ts\n1 packages/notes/src/old.ts\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
