/** Immutable, source-keyed PostgreSQL templates for integration fixtures. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SQL } from "bun";
import { packageIds, workspaceRoot } from "../workspace";

/** Validate before SQL interpolation, including PostgreSQL's identifier truncation boundary. */
export const quoteTestDatabase = (name: string): string => {
  if (!name.endsWith("_test") || Buffer.byteLength(name) > 63 || name.includes("\0")) {
    throw new Error("Integration database names must end in _test and fit within 63 bytes");
  }
  return `"${name.replaceAll('"', '""')}"`;
};

/**
 * Hash runtime sources and assets, not a hand-maintained list of migration files:
 * migrations also import shared helpers, baseline SQL and generated avatar data.
 * Conservatively invalidating on other runtime edits keeps transitive inputs safe.
 */
export const integrationSchemaHash = (root = workspaceRoot): string => {
  const files = [
    "bun.lock",
    "package.json",
    "scripts/workspace.ts",
    ...["integration-bootstrap.ts", "integration-migrations.ts", "test-database-template.ts"].map((name) => `scripts/fixtures/${name}`),
  ];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !/\.(?:test|spec|test-fixture)\.[^.]+$/.test(entry.name)) files.push(relative(root, path));
    }
  };
  for (const id of packageIds(root)) {
    files.push(`packages/${id}/package.json`);
    walk(join(root, "packages", id, "src"));
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const data = readFileSync(join(root, file));
    hash.update(`${file}\0${data.byteLength}\0`).update(data);
  }
  return hash.digest("hex");
};

const templateNames = (target: string, schemaHash: string) => {
  const url = new URL(target);
  quoteTestDatabase(decodeURIComponent(url.pathname.slice(1)));
  const key = createHash("sha256").update(schemaHash).update("\0").update(url.username).digest("hex").slice(0, 40);
  return { name: `cloud_tpl_${key}_test`, building: `cloud_build_${key}_test` };
};

const useLock = (name: string) => `cloud.integration.template.use:${name}`;
type Connection = Awaited<ReturnType<SQL["reserve"]>>;

/** Reclaim only our marked databases, with no active runner, file or builder. */
const cleanUnusedTemplates = async (connection: Connection): Promise<void> => {
  const rows = await connection<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname ~ '^cloud_(tpl|build)_[0-9a-f]{40}_test$'
      AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND shobj_description(oid, 'pg_database') IN ('cloud integration template', 'cloud integration build')`;
  for (const { datname } of rows) {
    const name = datname.replace("cloud_build_", "cloud_tpl_");
    const [lease] = await connection<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_lock(hashtextextended(${useLock(name)}, 0)) AS acquired`;
    if (!lease?.acquired) continue;
    try {
      const [builder] = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${name}, 0)) AS acquired`;
      if (!builder?.acquired) continue;
      try {
        await connection.unsafe(`DROP DATABASE IF EXISTS ${quoteTestDatabase(datname)} WITH (FORCE)`);
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`;
      }
    } finally {
      await connection`SELECT pg_advisory_unlock(hashtextextended(${useLock(name)}, 0))`;
    }
  }
};

/**
 * A session lock on the maintenance database serializes builders across processes
 * and shards. Publish only after the migration process has closed its connections.
 * A killed builder leaves an unpublished database that the next holder replaces.
 */
export const prepareDatabaseTemplate = async (
  target: string,
  schemaHash: string,
  migrate: (url: string) => Promise<void>,
): Promise<string> => {
  const { name, building } = templateNames(target, schemaHash);
  const url = new URL(target);
  url.pathname = "/postgres";
  const admin = new SQL(url.toString(), { max: 1 });
  const connection = await admin.reserve().catch(async (error: unknown) => {
    await admin.close();
    throw error;
  });
  try {
    await connection`SELECT pg_advisory_lock(hashtextextended(${name}, 0))`;
    try {
      const [existing] = await connection<{ datallowconn: boolean }[]>`SELECT datallowconn FROM pg_database WHERE datname = ${name}`;
      if (existing) {
        if (existing.datallowconn) throw new Error(`Integration template ${name} is not sealed`);
        return name;
      }
      await connection.unsafe(`DROP DATABASE IF EXISTS ${quoteTestDatabase(building)} WITH (FORCE)`);
      await connection.unsafe(`CREATE DATABASE ${quoteTestDatabase(building)} TEMPLATE template0`);
      await connection.unsafe(`COMMENT ON DATABASE ${quoteTestDatabase(building)} IS 'cloud integration build'`);
      const buildUrl = new URL(target);
      buildUrl.pathname = `/${building}`;
      try {
        await migrate(buildUrl.toString());
        await connection.unsafe(`ALTER DATABASE ${quoteTestDatabase(building)} ALLOW_CONNECTIONS false`);
        await connection.unsafe(`COMMENT ON DATABASE ${quoteTestDatabase(building)} IS 'cloud integration template'`);
        await connection.unsafe(`ALTER DATABASE ${quoteTestDatabase(building)} RENAME TO ${quoteTestDatabase(name)}`);
      } catch (error) {
        await connection.unsafe(`DROP DATABASE IF EXISTS ${quoteTestDatabase(building)} WITH (FORCE)`);
        throw error;
      }
      return name;
    } finally {
      await connection`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`;
    }
  } finally {
    connection.release();
    await admin.close();
  }
};

type TemplateLease = { name: string; prepare: () => Promise<void>; close: () => Promise<void> };
let template: Promise<TemplateLease> | undefined;

/** Release the run/file lease; the last user also removes the template. */
export const closeMigratedDatabaseTemplate = async (): Promise<void> => {
  const current = template;
  template = undefined;
  if (current) await (await current).close();
};

/** Hold a template through preparation and cloning; close after the last clone. */
export const leaseDatabaseTemplate = async (
  target: string,
  hash: string,
  migrate: (url: string) => Promise<void>,
): Promise<TemplateLease> => {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid integration database schema hash");
  const { name } = templateNames(target, hash);
  const url = new URL(target);
  url.pathname = "/postgres";
  const admin = new SQL(url.toString(), { max: 1 });
  const connection = await admin.reserve().catch(async (error: unknown) => {
    await admin.close();
    throw error;
  });
  const close = async () => {
    try {
      await connection`SELECT pg_advisory_unlock_shared(hashtextextended(${useLock(name)}, 0))`;
      await cleanUnusedTemplates(connection);
    } finally {
      connection.release();
      await admin.close();
    }
  };
  try {
    await connection`SELECT pg_advisory_lock_shared(hashtextextended(${useLock(name)}, 0))`;
    await cleanUnusedTemplates(connection);
    let preparing: Promise<void> | undefined;
    return {
      name,
      close,
      prepare: () =>
        (preparing ??= (async () => {
          await prepareDatabaseTemplate(target, hash, migrate);
        })()),
    };
  } catch (error) {
    await close();
    throw error;
  }
};

/** Keep the template alive across the runner's bootstrap and all its child files. */
export const retainMigratedDatabaseTemplate = async (target: string, hash: string): Promise<void> => {
  template ??= leaseDatabaseTemplate(target, hash, runTemplateMigrations);
  await template;
};

/** The runner passes its hash to children, so files never rescan runtime sources. */
export const migratedDatabaseTemplate = async (target: string): Promise<string> => {
  template ??= leaseDatabaseTemplate(target, process.env.CLOUD_TEST_DATABASE_SCHEMA_HASH ?? integrationSchemaHash(), runTemplateMigrations);
  const lease = await template;
  await lease.prepare();
  return lease.name;
};

const runTemplateMigrations = async (url: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "integration-migrations.ts")], {
    cwd: workspaceRoot,
    env: { ...process.env, CLOUD_TEST_DATABASE_URL: url, DATABASE_URL: url, POSTGRES_URL: url, PGURL: url },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if ((await child.exited) !== 0) throw new Error("Integration template migrations failed");
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
};
