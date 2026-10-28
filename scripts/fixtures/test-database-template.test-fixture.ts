import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const schemaFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-schema-"));
  const files = {
    "package.json": JSON.stringify({ workspaces: { packages: ["packages/core", "packages/mail", "packages/pulse"] } }),
    "bun.lock": "dependencies",
    "scripts/workspace.ts": "workspace",
    "scripts/fixtures/integration-bootstrap.ts": "bootstrap",
    "scripts/fixtures/integration-migrations.ts": "migrations",
    "scripts/fixtures/test-database-template.ts": "template",
    "packages/core/package.json": JSON.stringify({ name: "@k2b/core" }),
    "packages/mail/package.json": JSON.stringify({ name: "@k2b/mail" }),
    "packages/pulse/package.json": JSON.stringify({ name: "@k2b/pulse" }),
    "packages/core/src/migrate.ts": "core migration",
    "packages/mail/src/schema.sql": "mail baseline",
    "packages/pulse/src/migrate.ts": "pulse migration",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return { root, files, cleanup: () => rm(root, { recursive: true, force: true }) };
};
