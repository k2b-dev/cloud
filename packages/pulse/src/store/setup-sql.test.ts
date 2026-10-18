import { expect, test } from "bun:test";
import { buildSetupSql, DATABASE_RIGHTS, hashServicePassword, READ_LIMITS, READ_PROFILES } from "./setup-sql";
import { StorePassword, StorePrefix, StoreUrl, StoreUser } from "./validation";

const input = { user: "pulse_fixture", passwordSha256Hex: "a".repeat(64), saltHex: "b".repeat(32) };
test("setup contains exactly the allowed grants and READONLY constraints on every limit", () => {
  const sql = buildSetupSql(input);
  for (const [name, limits] of Object.entries(READ_PROFILES)) {
    for (const verb of ["CREATE SETTINGS PROFILE IF NOT EXISTS", "ALTER SETTINGS PROFILE"]) {
      const statement = sql.split(";").find((part) => part.includes(`${verb} \`pulse_${name}\``))!;
      for (const [key, value] of Object.entries({ ...limits, ...READ_LIMITS })) {
        expect(statement).toContain(`${key} = ${typeof value === "string" ? `'${value}'` : value} READONLY`);
      }
    }
  }
  const grants = sql.split("\n").filter((line) => line.startsWith("GRANT "));
  expect(grants).toEqual([
    "GRANT CREATE USER, ALTER USER, DROP USER ON *.* TO `pulse_fixture`;",
    // Bare wildcard: ClickHouse treats a quoted `pulse_*` as a literal database name.
    `GRANT ${DATABASE_RIGHTS.join(", ")} ON pulse_*.* TO \`pulse_fixture\`;`,
    "GRANT SELECT ON pulse_*.* TO `pulse_fixture` WITH GRANT OPTION;",
    "GRANT SELECT ON system.parts TO `pulse_fixture`;",
    "GRANT SELECT ON system.disks TO `pulse_fixture`;",
    "GRANT KILL QUERY ON *.* TO `pulse_fixture`;",
  ]);
  expect(sql).toContain("pulse_maintenance` SETTINGS max_memory_usage = 1000000000 READONLY");
  expect(sql).toContain("CREATE USER IF NOT EXISTS");
  expect(sql).toContain(`sha256_hash BY '${input.passwordSha256Hex}' SALT '${input.saltHex}'`);
  expect(sql).not.toMatch(/ACCESS MANAGEMENT|ROLE ADMIN|SOURCES|GRANT ALL/);
});
test("setup updates all four profiles in place with the same settings, preserving attached users", () => {
  const sql = buildSetupSql(input);
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((part) => part.trim());
  for (const name of [...Object.keys(READ_PROFILES), "maintenance"]) {
    const create = statements.find((part) => part.startsWith(`CREATE SETTINGS PROFILE IF NOT EXISTS \`pulse_${name}\` SETTINGS`));
    const alter = statements.find((part) => part.startsWith(`ALTER SETTINGS PROFILE \`pulse_${name}\` SETTINGS`));
    expect(create).toBeDefined();
    expect(alter).toBe(create?.replace("CREATE SETTINGS PROFILE IF NOT EXISTS", "ALTER SETTINGS PROFILE"));
  }
  expect(sql).not.toContain("OR REPLACE");
});
test("hash uses a new 16-byte salt and SHA256(password + salt), without plaintext in SQL", async () => {
  const password = "obviously-fake-fixture-password";
  const a = await hashServicePassword(password),
    b = await hashServicePassword(password);
  expect(a.saltHex).toMatch(/^[a-f0-9]{32}$/);
  expect(a.saltHex).not.toBe(b.saltHex);
  const expected = new Bun.CryptoHasher("sha256").update(password + a.saltHex).digest("hex");
  expect(a.sha256Hex).toBe(expected);
  const sql = buildSetupSql({ ...input, passwordSha256Hex: a.sha256Hex, saltHex: a.saltHex });
  expect(sql).not.toContain(password);
});
test("identifiers and hash verifiers cannot inject SQL", () => {
  for (const user of ["x`", "x; DROP USER x", "1user", "x".repeat(65)]) expect(() => buildSetupSql({ ...input, user })).toThrow();
  for (const prefix of ["pulse", "Pulse_", "pulse__", "a".repeat(32) + "_", "pulse_*_"])
    expect(() => buildSetupSql({ ...input, prefix })).toThrow();
  expect(() => buildSetupSql({ ...input, passwordSha256Hex: "'" })).toThrow();
  expect(() => buildSetupSql({ ...input, saltHex: "'" })).toThrow();
});
test("shared address, user, password and prefix validation", () => {
  for (const value of ["http://clickhouse:8123", "https://store.example/"]) expect(StoreUrl.safeParse(value).success).toBe(true);
  for (const value of [
    "file:///x",
    "ftp://store",
    "http://u:p@store",
    "http://store/path",
    "http://store/a/..",
    "http://@store",
    "http://store/\t",
    "http://store\\evil",
    "http://store?x",
    "http://store#x",
    "http://store?",
    "http://store#",
    "http://" + "x".repeat(2050),
  ])
    expect(StoreUrl.safeParse(value).success).toBe(false);
  expect(StoreUser.safeParse("_fixture1").success).toBe(true);
  expect(StorePrefix.safeParse("pulsetest_1234abcd_").success).toBe(true);
  for (const password of ["", "x".repeat(257), "fake\nsecret", "fake\u007fsecret", "fake\u0085secret"])
    expect(StorePassword.safeParse(password).success).toBe(false);
  expect(StorePassword.safeParse(" fake password with spaces ").success).toBe(true);
});
