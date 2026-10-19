import { CHECK_STEPS, REQUIRED_RIGHTS, type StoreCheckCode, type StoreCheckResult } from "./check-codes";
import { clickhouseQuery, type QueryOptions, StoreQueryError } from "./client";
import { hashServicePassword, READ_LIMITS, READ_PROFILES, randomHex } from "./setup-sql";

import { quoteIdentifier as q, StorePassword, StorePrefix, StoreUrl, StoreUser } from "./validation";

export { CHECK_STEPS, REQUIRED_RIGHTS, type StoreCheckCode, type StoreCheckResult };

const ACCESS_DENIED = 497;
const AUTHENTICATION_FAILED = 516;
const NO_PROFILE = 180;
const UNKNOWN_TABLE = 60;
const ADMIN_PRIVILEGE =
  /\b(?:ALL(?: PRIVILEGES)?|ACCESS MANAGEMENT|ROLE ADMIN|(?:CREATE|ALTER|DROP) (?:SETTINGS )?PROFILE|(?:CREATE|ALTER|DROP) (?:ROLE|QUOTA|ROW POLICY|POLICY))\b/i;
const BROAD_TARGET = /^(?:\*(?:\.\*)?|`?system`?\.\*)$/i;
/** Rights that would let the service user lift the limits, act as an admin, or read every log. Only the
 * privilege list and target count: a grantee such as `all` must not read as the ALL privilege. */
const tooBroad = (grant: string): boolean => {
  const match = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b/i.exec(grant);
  if (!match) return false;
  const [, privileges = "", target = ""] = match;
  return ADMIN_PRIVILEGE.test(privileges) || (/\bSELECT\b/i.test(privileges) && BROAD_TARGET.test(target));
};

export const supportedVersion = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)(?:\.\d+)*$/.exec(version);
  return Boolean(match && (Number(match[1]) > 26 || (Number(match[1]) === 26 && Number(match[2]) >= 9)));
};
class CheckFailure extends Error {
  constructor(readonly code: StoreCheckCode) {
    super(code);
  }
}
export type CheckStoreOptions = {
  url: string;
  user: string;
  password: string;
  prefix?: string;
  mode: "connection" | "full";
  signal?: AbortSignal;
  clock?: () => Date;
  transport?: QueryOptions["transport"];
};

export const checkStore = async (options: CheckStoreOptions): Promise<StoreCheckResult> => {
  const prefix = StorePrefix.parse(options.prefix ?? "pulse_");
  const result: StoreCheckResult = {
    ok: false,
    checkedAt: (options.clock ?? (() => new Date()))().toISOString(),
    steps: { reach: "skipped", auth: "skipped", version: "skipped", rights: "skipped", profiles: "skipped" },
  };
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
  const base = { url: options.url, user: options.user, password: options.password, timeoutMs: 5_000, signal, transport: options.transport };
  const run = (query: string, extra?: Partial<Pick<QueryOptions, "params" | "settings" | "user" | "password">>) =>
    clickhouseQuery({ ...base, ...extra, query });
  let step: (typeof CHECK_STEPS)[number] = "reach";
  const fail = (code: StoreCheckCode): never => {
    throw new CheckFailure(code);
  };
  const right = async (name: (typeof REQUIRED_RIGHTS)[number], query: string, extra?: Parameters<typeof run>[1]) => {
    try {
      return await run(query, extra);
    } catch (error) {
      if (error instanceof StoreQueryError && error.code === ACCESS_DENIED) fail(`MISSING_RIGHT:${name}`);
      throw error;
    }
  };
  const mustDeny = async (query: string, cleanup?: string) => {
    try {
      await run(query);
    } catch (error) {
      if (error instanceof StoreQueryError && error.code === ACCESS_DENIED) return;
      throw error;
    }
    if (cleanup) await run(cleanup).catch(() => {});
    fail("TOO_MANY_RIGHTS");
  };
  const suffix = randomHex(4);
  const database = `${prefix}check_${suffix}`,
    reader = `${database}_reader`;
  const scratchProfile = `${prefix}check_${suffix}`;
  const outside = `${prefix.slice(0, -1)}x_check_${suffix}`;
  const table = `${q(database)}.${q("probe")}`;
  // Attempt cleanup even after a lost response: the server may have committed the DDL.
  let touched = false;
  try {
    if (
      !StoreUrl.safeParse(options.url).success ||
      !StoreUser.safeParse(options.user).success ||
      !StorePassword.safeParse(options.password).success
    )
      fail("UNREACHABLE");
    const started = performance.now();
    const rows = await run("SELECT version() AS version");
    result.latencyMs = Math.round(performance.now() - started);
    result.steps.reach = "ok";
    result.steps.auth = "ok";
    step = "version";
    const version = rows[0]?.version;
    if (typeof version !== "string" || !/^\d+\.\d+(?:\.\d+)*$/.test(version)) throw new CheckFailure("UNREACHABLE");
    result.version = version;
    if (!supportedVersion(version)) fail("VERSION_TOO_OLD");
    result.steps.version = "ok";
    if (options.mode === "connection") {
      result.ok = true;
      return result;
    }
    step = "rights";
    touched = true;
    await mustDeny(
      `CREATE SETTINGS PROFILE ${q(scratchProfile)} SETTINGS max_memory_usage = 1`,
      `DROP SETTINGS PROFILE IF EXISTS ${q(scratchProfile)}`,
    );
    await mustDeny(`CREATE DATABASE ${q(outside)}`, `DROP DATABASE IF EXISTS ${q(outside)}`);
    await mustDeny("SELECT 1 FROM system.query_log LIMIT 0").catch((error: unknown) => {
      // An absent optional log table proves nothing; the grants check below still rejects broad SELECT.
      if (!(error instanceof StoreQueryError && error.code === UNKNOWN_TABLE)) throw error;
    });
    const grants = (await run("SHOW GRANTS FINAL")).flatMap((row) => Object.values(row)).filter((v): v is string => typeof v === "string");
    if (grants.some(tooBroad)) fail("TOO_MANY_RIGHTS");
    await right("CREATE DATABASE", `CREATE DATABASE ${q(database)}`);
    await right("CREATE TABLE", `CREATE TABLE ${table} (value UInt8) ENGINE = MergeTree ORDER BY tuple()`);
    await right("ALTER TABLE", `ALTER TABLE ${table} ADD COLUMN extra UInt8 DEFAULT 0`);
    await right("INSERT", `INSERT INTO ${table} (value) VALUES (1)`);
    const readerPassword = randomHex(24);
    const hash = await hashServicePassword(readerPassword);
    try {
      await run(
        `CREATE USER ${q(reader)} IDENTIFIED WITH sha256_hash BY '${hash.sha256Hex}' SALT '${hash.saltHex}' SETTINGS PROFILE '${prefix}read_normal'`,
      );
    } catch (error) {
      if (error instanceof StoreQueryError && error.code === ACCESS_DENIED) fail("MISSING_RIGHT:CREATE USER");
      if (error instanceof StoreQueryError && error.code === NO_PROFILE) fail(`PROFILE_MISSING:${prefix}read_normal`);
      throw error;
    }
    await right("GRANT SELECT", `GRANT SELECT ON ${table} TO ${q(reader)}`);
    const asReader = { user: reader, password: readerPassword };
    const read = await right("SELECT", `SELECT value FROM ${table}`, asReader);
    if (Number(read[0]?.value) !== 1) fail("MISSING_RIGHT:SELECT");
    await right("SYSTEM PARTS", "SELECT 1 FROM system.parts LIMIT 0");
    await right("SYSTEM DISKS", "SELECT 1 FROM system.disks LIMIT 0");
    if (!grants.some((grant) => /\bKILL QUERY\b.*\bON\s+\*(?:\.\*)?(?:\s|$)/i.test(grant))) fail("MISSING_RIGHT:KILL QUERY");
    await right("OPTIMIZE", `OPTIMIZE TABLE ${table}`);
    result.steps.rights = "ok";
    step = "profiles";
    const readonly = async (profile: string, query: string, extra: Parameters<typeof run>[1]) => {
      try {
        await run(query, extra);
      } catch (error) {
        // 164 READONLY for read users (readonly=1); 452 SETTING_CONSTRAINT_VIOLATION for the service user,
        // whose maintenance limit is a READONLY constraint without readonly mode.
        if (error instanceof StoreQueryError && (error.code === 164 || error.code === 452)) return;
        // Any other refusal is not proof that the limit holds; report it by its code.
        throw error;
      }
      fail(`PROFILE_MISSING:${profile}`);
    };
    for (const [name, limits] of Object.entries(READ_PROFILES)) {
      const profile = prefix + name;
      try {
        await run(`ALTER USER ${q(reader)} SETTINGS PROFILE '${profile}'`);
      } catch (error) {
        if (error instanceof StoreQueryError && error.code === ACCESS_DENIED) fail("MISSING_RIGHT:ALTER USER");
        if (error instanceof StoreQueryError && error.code === NO_PROFILE) fail(`PROFILE_MISSING:${profile}`);
        throw error;
      }
      const expected = { ...limits, ...READ_LIMITS };
      const settings = Object.keys(expected)
        .map((setting) => `getSetting('${setting}') AS ${setting}`)
        .join(", ");
      const [actual] = await run(`SELECT ${settings}`, asReader);
      // ClickHouse shows a read user no constraint metadata, and readonly=1 already refuses every
      // setting change. So the check compares each value and proves that overriding it fails.
      for (const [setting, value] of Object.entries(expected)) {
        const found = actual?.[setting];
        if (String(typeof found === "boolean" ? Number(found) : found) !== String(value)) fail(`PROFILE_MISSING:${profile}`);
        const other = typeof value === "number" ? (value === 1 ? 0 : 1) : "break";
        await readonly(profile, `SELECT 1 SETTINGS ${setting} = ${typeof other === "string" ? `'${other}'` : other}`, asReader);
      }
      if (name === "read_normal") {
        await readonly(profile, "SELECT 1", { ...asReader, settings: { max_memory_usage: 1 } });
        await readonly(profile, "SET max_memory_usage = 1", asReader);
      }
    }
    const [maintenance] = await run("SELECT getSetting('max_memory_usage') AS memory");
    if (Number(maintenance?.memory) !== 1_000_000_000) fail(`PROFILE_MISSING:${prefix}maintenance`);
    // Raising the limit is what must fail; a MIN-only constraint would refuse only a lower value.
    await readonly(`${prefix}maintenance`, "SELECT 1 SETTINGS max_memory_usage = 2000000000", {});
    await right("TRUNCATE", `TRUNCATE TABLE ${table}`);
    await right("DROP USER", `DROP USER ${q(reader)}`);
    await right("DROP TABLE", `DROP TABLE ${table}`);
    await right("DROP DATABASE", `DROP DATABASE ${q(database)}`);
    result.steps.profiles = "ok";
    result.ok = true;
  } catch (error) {
    result.code =
      error instanceof CheckFailure
        ? error.code
        : error instanceof StoreQueryError && error.code === AUTHENTICATION_FAILED
          ? "AUTH_FAILED"
          : error instanceof StoreQueryError && error.kind === "clickhouse" && error.code !== undefined
            ? `CLICKHOUSE_ERROR:${error.code}`
            : "UNREACHABLE";
    if (step === "reach" && error instanceof StoreQueryError && error.kind === "clickhouse") {
      result.steps.reach = "ok";
      step = "auth";
    }
    if (result.code.startsWith("PROFILE_MISSING:")) step = "profiles";
    if (result.code.startsWith("MISSING_RIGHT:") || result.code === "TOO_MANY_RIGHTS") step = "rights";
    result.steps[step] = "failed";
  } finally {
    if (touched) {
      // Cleanup has its own two-second budget even when the caller or main deadline aborted.
      const cleanupSignal = AbortSignal.timeout(2_000);
      for (const query of [
        `DROP USER IF EXISTS ${q(reader)}`,
        `DROP DATABASE IF EXISTS ${q(database)}`,
        `DROP DATABASE IF EXISTS ${q(outside)}`,
        `DROP SETTINGS PROFILE IF EXISTS ${q(scratchProfile)}`,
      ]) {
        await clickhouseQuery({ ...base, query, signal: cleanupSignal, timeoutMs: 1_000 }).catch(() => {});
      }
    }
  }
  return result;
};
