import { afterAll, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import {
  integrationSchemaHash,
  leaseDatabaseTemplate,
  migratedDatabaseTemplate,
  prepareDatabaseTemplate,
  quoteTestDatabase,
} from "../../scripts/fixtures/test-database-template";
import { schemaFixture } from "../../scripts/fixtures/test-database-template.test-fixture";
import {
  createDisposableDatabase,
  createMigratedDatabase,
  requireDatabaseUrl,
  testFor,
  testInfra,
  usesMigratedDatabase,
} from "../../scripts/fixtures/test-infra";

// Cold migration work belongs outside a file's test/hook budget, as in the runner bootstrap.
if (testInfra.database) {
  process.env.CLOUD_TEST_DATABASE_SCHEMA_HASH ??= integrationSchemaHash();
  await migratedDatabaseTemplate(requireDatabaseUrl());
}

const databases: Awaited<ReturnType<typeof createDisposableDatabase>>[] = [];
const templates = new Set<string>();
const leases: Awaited<ReturnType<typeof leaseDatabaseTemplate>>[] = [];
const prepare = async (hash: string, migrate: (url: string) => Promise<void>) => {
  const lease = await leaseDatabaseTemplate(requireDatabaseUrl(), hash, migrate);
  leases.push(lease);
  await lease.prepare();
  return lease.name;
};
afterAll(async () => {
  for (const database of databases) await database.drop();
  for (const lease of leases) await lease.close();
  if (!templates.size) return;
  const url = new URL(requireDatabaseUrl());
  url.pathname = "/postgres";
  const admin = new SQL(url.toString());
  try {
    for (const name of templates) await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteTestDatabase(name)} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

const clone = async (template: string) => {
  const database = await createDisposableDatabase("template_guard", template);
  databases.push(database);
  return database;
};
const version = async (url: string) => {
  const db = new SQL(url);
  try {
    const [row] = await db<{ version: string }[]>`SELECT version FROM public.template_guard`;
    return row!.version;
  } finally {
    await db.close();
  }
};

testFor("database")("a file gets isolated Core, Mail and Pulse schemas within three seconds", async () => {
  const started = performance.now();
  const first = await createMigratedDatabase("template_speed");
  databases.push(first);
  const elapsed = performance.now() - started;
  console.log(`Migrated database ready: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(3_000);
  const second = await createMigratedDatabase("template_isolation");
  databases.push(second);
  const selected = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = first.url;
    expect(usesMigratedDatabase()).toBe(true);
    process.env.DATABASE_URL = requireDatabaseUrl();
    expect(usesMigratedDatabase()).toBe(false);
  } finally {
    process.env.DATABASE_URL = selected;
  }
  const db = new SQL(first.url);
  const other = new SQL(second.url);
  try {
    const [schemas] = await db`SELECT to_regclass('auth.users') IS NOT NULL AS core,
      to_regclass('mail.mailboxes') IS NOT NULL AS mail, to_regclass('pulse.bases') IS NOT NULL AS pulse`;
    expect(schemas).toEqual({ core: true, mail: true, pulse: true });
    await db`CREATE TABLE public.template_guard (version text)`;
    expect((await other`SELECT to_regclass('public.template_guard') AS relation`)[0]?.relation).toBeNull();
  } finally {
    await db.close();
    await other.close();
  }
});

testFor("database")("concurrent builders publish once, reuse unchanged sources and rebuild after a migration edit", async () => {
  const fixture = await schemaFixture();
  await writeFile(join(fixture.root, "bun.lock"), crypto.randomUUID());
  let builds = 0;
  const source = join(fixture.root, "packages/mail/src/schema.sql");
  const migrate = async (url: string) => {
    builds += 1;
    const db = new SQL(url);
    try {
      await db`CREATE TABLE public.template_guard (version text)`;
      await db`INSERT INTO public.template_guard VALUES (${await Bun.file(source).text()})`;
    } finally {
      await db.close();
    }
  };
  try {
    const hash = await integrationSchemaHash(fixture.root);
    const results = await Promise.all(Array.from({ length: 3 }, () => prepare(hash, migrate)));
    for (const name of results) templates.add(name);
    expect(new Set(results).size).toBe(1);
    expect(builds).toBe(1);
    const first = await clone(results[0]!);
    expect(await version(first.url)).toBe("mail baseline");
    expect(await prepare(hash, migrate)).toBe(results[0]!);
    expect(builds).toBe(1);

    await writeFile(source, "changed mail migration");
    const changed = await prepare(await integrationSchemaHash(fixture.root), migrate);
    templates.add(changed);
    expect(changed).not.toBe(results[0]!);
    expect(builds).toBe(2);
    expect(await version((await clone(changed)).url)).toBe("changed mail migration");
    expect(await version(first.url)).toBe("mail baseline");
  } finally {
    await fixture.cleanup();
  }
});

testFor("database")("a failed migration is never published and the same identity can be rebuilt", async () => {
  const hash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await expect(
    prepare(hash, async () => {
      throw new Error("injected migration failure");
    }),
  ).rejects.toThrow("injected migration failure");
  const name = await prepare(hash, async (url) => {
    const db = new SQL(url);
    try {
      await db`CREATE TABLE public.template_guard (version text)`;
      await db`INSERT INTO public.template_guard VALUES ('recovered')`;
    } finally {
      await db.close();
    }
  });
  templates.add(name);
  expect(await version((await clone(name)).url)).toBe("recovered");
  const url = new URL(requireDatabaseUrl());
  url.pathname = "/postgres";
  const admin = new SQL(url.toString());
  try {
    const [row] = await admin<{ datallowconn: boolean }[]>`SELECT datallowconn FROM pg_database WHERE datname = ${name}`;
    expect(row?.datallowconn).toBe(false);
  } finally {
    await admin.close();
  }
});

testFor("database")("file cleanup preserves an active runner template and reclaims abandoned templates", async () => {
  const hash = process.env.CLOUD_TEST_DATABASE_SCHEMA_HASH ?? integrationSchemaHash();
  const name = await migratedDatabaseTemplate(requireDatabaseUrl());
  const active = await prepare(new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex"), async () => {});
  const orphan = await prepareDatabaseTemplate(requireDatabaseUrl(), crypto.randomUUID(), async () => {});
  templates.add(orphan);
  const abandonedBuild = orphan.replace("cloud_tpl_", "cloud_build_");
  templates.add(abandonedBuild);
  const url = new URL(requireDatabaseUrl());
  url.pathname = "/postgres";
  const admin = new SQL(url.toString());
  try {
    await admin.unsafe(`COMMENT ON DATABASE ${quoteTestDatabase(orphan)} IS 'cloud integration build'`);
    await admin.unsafe(`CREATE DATABASE ${quoteTestDatabase(abandonedBuild)} TEMPLATE template0`);
    await admin.unsafe(`COMMENT ON DATABASE ${quoteTestDatabase(abandonedBuild)} IS 'cloud integration build'`);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import { migratedDatabaseTemplate, closeMigratedDatabaseTemplate } from "./scripts/fixtures/test-database-template";
       const name = await migratedDatabaseTemplate(process.env.CLOUD_TEST_DATABASE_URL);
       await closeMigratedDatabaseTemplate();
       console.log(name);`,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, CLOUD_TEST_DATABASE_SCHEMA_HASH: hash },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe(name);
    const rows = await admin<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname IN (${name}, ${active}, ${orphan}, ${abandonedBuild}) ORDER BY datname`;
    expect(rows.map((row) => row.datname)).toEqual([name, active].sort());
  } finally {
    await admin.close();
  }
});
