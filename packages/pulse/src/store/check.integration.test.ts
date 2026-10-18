import { expect, test } from "bun:test";
import {
  clickhouseAdminQuery as admin,
  clickhouseTestAdmin,
  clickhouseTestPrefix as prefix,
} from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { checkStore } from "./check";
import { clickhouseQuery } from "./client";
import { buildSetupSql, hashServicePassword, randomHex } from "./setup-sql";
import { quoteIdentifier as q } from "./validation";

const suite = suiteFor("clickhouse");
const password = "obviously-fake-clickhouse-fixture-password";
const user = `${prefix}service`;
const clock = () => new Date("2026-10-17T12:00:00.000Z");
const install = async (name: string, omitCreateUser = false) => {
  const hash = await hashServicePassword(password);
  let sql = buildSetupSql({ prefix, user: name, passwordSha256Hex: hash.sha256Hex, saltHex: hash.saltHex });
  expect(sql).toContain(hash.sha256Hex);
  expect(sql).not.toContain(password);
  if (omitCreateUser) sql = sql.replace("GRANT CREATE USER, ALTER USER, DROP USER", "GRANT ALTER USER, DROP USER");
  for (const query of sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await admin(query);
};
suite("Pulse ClickHouse store", () => {
  test("setup is repeatable, full check passes, passwords and privilege boundaries are enforced", async () => {
    await install(user);
    await install(user);
    const connection = { url: clickhouseTestAdmin().url, user, password, prefix, clock, mode: "full" as const };
    const value = await checkStore(connection);
    expect(value).toMatchObject({ ok: true, checkedAt: clock().toISOString() });
    expect(value.version).toMatch(/^(?:26\.(?:9|[1-9]\d)|(?:2[7-9]|[3-9]\d)\.)/);
    expect((await checkStore({ ...connection, password: "obviously-wrong-fake-password" })).code).toBe("AUTH_FAILED");
    const limited = `${prefix}limited`;
    await install(limited, true);
    expect((await checkStore({ ...connection, user: limited })).code).toBe("MISSING_RIGHT:CREATE USER");
    expect((await checkStore({ ...connection, ...clickhouseTestAdmin() })).code).toBe("TOO_MANY_RIGHTS");
  }, 90_000);
  test("a read profile whose limit was changed counts as missing", async () => {
    await install(user);
    const hash = await hashServicePassword(password);
    const sql = buildSetupSql({ prefix, user, passwordSha256Hex: hash.sha256Hex, saltHex: hash.saltHex });
    const normal = sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((query) => query.trim())
      .find((query) => query.startsWith(`CREATE SETTINGS PROFILE OR REPLACE ${q(prefix + "read_normal")}`));
    if (!normal) throw new Error("Missing normal profile fixture");
    try {
      await admin(normal.replace("max_result_rows = 10000 READONLY", "max_result_rows = 1000000 READONLY"));
      const value = await checkStore({ url: clickhouseTestAdmin().url, user, password, prefix, clock, mode: "full" });
      expect(value).toMatchObject({ ok: false, code: `PROFILE_MISSING:${prefix}read_normal` });
    } finally {
      await install(user);
    }
  }, 30_000);
  test("wildcard database grant cannot create outside the prefix", async () => {
    await install(user);
    const inside = `${prefix}x`,
      outside = `other_${randomHex(4)}`;
    const run = (query: string) => clickhouseQuery({ url: clickhouseTestAdmin().url, user, password, query, timeoutMs: 5000 });
    try {
      await run(`CREATE DATABASE ${q(inside)}`);
      await expect(run(`CREATE DATABASE ${q(outside)}`)).rejects.toMatchObject({ kind: "clickhouse", code: 497 });
    } finally {
      await admin(`DROP DATABASE IF EXISTS ${q(inside)}`);
      await admin(`DROP DATABASE IF EXISTS ${q(outside)}`);
    }
  });
  test("read_normal forbids SET, SETTINGS clause and HTTP overrides", async () => {
    await install(user);
    const reader = `${prefix}reader`,
      hash = await hashServicePassword(password);
    await admin(
      `CREATE USER ${q(reader)} IDENTIFIED WITH sha256_hash BY '${hash.sha256Hex}' SALT '${hash.saltHex}' SETTINGS PROFILE '${prefix}read_normal'`,
    );
    try {
      for (const input of [
        { query: "SET max_memory_usage = 1" },
        { query: "SELECT 1 SETTINGS max_memory_usage = 1" },
        { query: "SELECT 1", settings: { max_memory_usage: 1 } },
      ]) {
        await expect(
          clickhouseQuery({ url: clickhouseTestAdmin().url, user: reader, password, timeoutMs: 5000, ...input }),
        ).rejects.toMatchObject({ code: 164 });
      }
    } finally {
      await admin(`DROP USER IF EXISTS ${q(reader)}`);
    }
  });
  test("closed loopback port fails quickly", async () => {
    const start = performance.now();
    const value = await checkStore({ url: "http://127.0.0.1:1", user, password, prefix, clock, mode: "full" });
    expect(value.code).toBe("UNREACHABLE");
    expect(performance.now() - start).toBeLessThan(6000);
  });
});
