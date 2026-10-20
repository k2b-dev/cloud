import { sql } from "bun";
import { clickhouseAdminQuery, clickhouseTestAdmin, clickhouseTestPrefix } from "../../../../scripts/fixtures/test-clickhouse";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { PulsePolicy } from "./admin-contracts";
import { baseStoreNames } from "./base-schema";
import { insertBaseStore } from "./base-status";
import { createBaseStore } from "./base-store";
import { buildSetupSql, hashServicePassword } from "./setup-sql";

export const fixturePolicy: PulsePolicy = {
  baseCreation: "everyone",
  maxBases: 200,
  maxRawRetentionDays: 730,
  defaultProfile: "normal",
  defaultLimits: {
    queriesPerHour: 600,
    valuesPerMinute: 2000,
    bytesPerMinute: 5242880,
    storageBytes: 5000000000,
    maxSeries: 50000,
    maxEventKinds: 2000,
    maxStateKeys: 2000,
  },
};
const password = "obviously-fake-base-store-fixture-password";
export const fixtureConnection = () => ({ url: clickhouseTestAdmin().url, user: `${clickhouseTestPrefix}service`, password });
export const fixtureClock = () => new Date("2026-10-17T12:00:00.000Z");
export const fixtureStore = (clock = fixtureClock) => {
  const store = createBaseStore({ prefix: clickhouseTestPrefix, connection: async () => fixtureConnection(), clock });
  const query = store.query;
  store.query = async (statement, params, connection) => {
    if (/\bsystem\.disks\b/i.test(statement)) throw new Error("Tests must inject disk measurements");
    return query(statement, params, connection);
  };
  return store;
};
export const installFixtureStore = async () => {
  await migrate();
  const hash = await hashServicePassword(password);
  const setup = buildSetupSql({
    prefix: clickhouseTestPrefix,
    user: fixtureConnection().user,
    passwordSha256Hex: hash.sha256Hex,
    saltHex: hash.saltHex,
  });
  for (const statement of setup
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await clickhouseAdminQuery(statement);
};
export const fixtureBase = async (id: string = crypto.randomUUID()) => {
  const shortId = newShortId();
  await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days,rollup_retention_days,sensitive_retention_hours) VALUES(${id}::uuid,${shortId},'Store fixture',30,365,24)`;
  await insertBaseStore(id, fixturePolicy, sql, clickhouseTestPrefix);
  return { id, shortId, ...baseStoreNames(id, clickhouseTestPrefix) };
};
export const cleanupFixtureBase = async (base: Awaited<ReturnType<typeof fixtureBase>>) => {
  const { quoteIdentifier: q } = await import("./validation");
  await clickhouseAdminQuery(`DROP USER IF EXISTS ${q(base.readUser)}`);
  await clickhouseAdminQuery(`DROP DATABASE IF EXISTS ${q(base.database)} SYNC`);
  await sql`DELETE FROM auth.access WHERE id IN(SELECT access_id FROM pulse.base_access WHERE base_id=${base.id}::uuid)`;
  await sql`DELETE FROM pulse.bases WHERE id=${base.id}::uuid`;
};
