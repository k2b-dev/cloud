import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate as migrateGeoIp } from "../../../../core/src/migrate/core/geoip";
import { createAdminGeoIpRoutes } from "../../api/admin-geoip";
import { GEOIP_MAX_REQUEST_BYTES } from "../../contracts/geoip";
import { createGeoIp } from "../../server/request-context/geoip";
import { mmdbFixture } from "../../server/request-context/geoip.test-fixture";
import { audit } from "../audit";
import { session } from "../session";
import { buildProjectedUser } from "../session/user";
import { createGeoIpService } from ".";
import { createGeoIpUploads } from "./store";

const suite = databaseSuite();
const admin = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"], uid: "geoip-admin", provider: "local" };
const frozenNow = Date.UTC(2026, 9, 17);
const bytes = (databaseType = "GeoLite2-City") => mmdbFixture("city", { databaseType });
const body = (value: Uint8Array<ArrayBuffer>) => new Blob([value]).stream();

suite("GeoIP Postgres replacement, audit and multi-instance reload", () => {
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  let directory: string;
  let paths: { cityPath: string; asnPath: string };
  let service: ReturnType<typeof createGeoIpService>;
  let reader: ReturnType<typeof createGeoIp>;
  let restoreClock: (() => void) | undefined;
  beforeAll(async () => {
    disposable = await useFreshDatabase("geoip");
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY, uid text NOT NULL, display_name text NOT NULL)`.simple();
    await sql`INSERT INTO auth.users VALUES (${admin.id}::uuid, ${admin.uid}, 'GeoIP Admin')`;
    await migrateAudit();
    await migrateGeoIp();
    await migrateGeoIp(); // Idempotent, including the storage setting.
    directory = mkdtempSync(join(tmpdir(), "geoip-integration-"));
    paths = { cityPath: join(directory, "city.mmdb"), asnPath: join(directory, "asn.mmdb") };
    writeFileSync(paths.cityPath, mmdbFixture("city"));
    writeFileSync(paths.asnPath, mmdbFixture("asn"));
  });
  beforeEach(async () => {
    const clock = spyOn(Date, "now").mockReturnValue(frozenNow);
    restoreClock = () => clock.mockRestore();
    await sql`TRUNCATE geoip.databases, audit.events`.simple();
    reader = createGeoIp({ paths });
    service = createGeoIpService({ reader, bundled: () => createGeoIp({ paths }).status() });
  });
  afterEach(() => restoreClock?.());
  afterAll(async () => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    await sql.close();
    await disposable?.drop();
  });

  test("real route authorization rejects non-admin GET, PUT and DELETE", async () => {
    const user = buildProjectedUser({ id: admin.id, provider: "local", profile: "user", effective_admin: false });
    const authentication = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "geoip-test", authEpoch: 0, kind: "web", expiresAt: "2030-01-01T00:00:00.000Z" },
    });
    try {
      const app = createAdminGeoIpRoutes(undefined, service);
      for (const [path, method] of [
        ["/", "GET"],
        ["/", "PUT"],
        ["/city", "DELETE"],
      ])
        expect((await app.request(path!, { method, headers: { Cookie: "session_token=test", Accept: "application/json" } })).status).toBe(
          403,
        );
      expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM geoip.databases`)[0]?.count).toBe(0);
    } finally {
      authentication.mockRestore();
    }
  });

  test("invalid and oversized uploads leave the prior row, hash, reader and audit unchanged", async () => {
    const first = await service.upload(admin, body(bytes()), {});
    const sha256 = first.databases[0].upload!.sha256;
    for (const invalid of [
      new Uint8Array([1, 2, 3]),
      mmdbFixture("city", { ipVersion: 4 }),
      mmdbFixture("city", { databaseType: "Country" }),
    ])
      await expect(service.upload(admin, body(invalid), {})).rejects.toBeInstanceOf(Error);
    await expect(service.upload(admin, body(bytes()), { contentLength: GEOIP_MAX_REQUEST_BYTES + 1 })).rejects.toMatchObject({
      code: "geoip_too_large",
    });
    expect((await service.status(admin, { now: () => frozenNow })).databases[0].upload?.sha256).toBe(sha256);
    expect(reader.status().city?.sha256).toBe(sha256);
    const stored = await createGeoIpUploads().read("city", sha256);
    expect(stored).toEqual(bytes());
    expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit.events`)[0]?.count).toBe(1);
  });

  test("upload overrides bundled data, replaces one row, and reset restores it with transactional audits", async () => {
    const first = await service.upload(admin, body(bytes()), {});
    const second = await service.upload(admin, body(bytes("Custom-City")), {});
    expect(second.databases[0]).toMatchObject({
      source: "uploaded",
      databaseType: "Custom-City",
      upload: { uploadedBy: { id: admin.id, name: "GeoIP Admin" } },
    });
    expect(second.databases[0].upload?.sha256).not.toBe(first.databases[0].upload?.sha256);
    expect(reader.status().city?.databaseType).toBe("Custom-City");
    expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM geoip.databases WHERE kind = 'city'`)[0]?.count).toBe(1);
    const reset = await service.reset(admin, "city");
    expect(reset.changed).toBe(true);
    expect(reset.databases[0].source).toBe("bundled");
    expect(reader.status().city?.source).toBe("bundled");
    expect((await service.reset(admin, "city")).changed).toBe(false);
    const events = await sql<{ action: string; metadata: { kind: string; sha256: string; size: number }; actor_user_id: string }[]>`
      SELECT action, metadata, actor_user_id FROM audit.events ORDER BY id`;
    expect(events.map((event) => event.action)).toEqual(["core.geoip.upload", "core.geoip.upload", "core.geoip.reset"]);
    expect(events.every((event) => event.actor_user_id === admin.id && event.metadata.kind === "city")).toBe(true);
    expect(events[2]?.metadata.sha256).toBe(second.databases[0].upload!.sha256);
    expect(JSON.stringify(events)).not.toContain("Synthetic test database");
  });

  test("a second Core reader discovers Postgres upload and reset after its interval", async () => {
    let now = frozenNow;
    const other = createGeoIp({ paths, uploads: createGeoIpUploads(), now: () => now });
    await other.refresh();
    expect(other.status().city?.source).toBe("bundled");
    const upload = await service.upload(admin, body(bytes()), {});
    now += 59_999;
    other.lookup("8.8.8.8");
    expect(other.status().city?.source).toBe("bundled");
    now++;
    other.lookup("8.8.8.8");
    await other.refresh();
    expect(other.status().city?.sha256).toBe(upload.databases[0].upload!.sha256);
    await service.reset(admin, "city");
    now += 60_000;
    other.lookup("8.8.8.8");
    await other.refresh();
    expect(other.status().city?.source).toBe("bundled");
  });

  test("an audit failure rolls back an upload and a reset before installing a reader", async () => {
    const uploaded = await service.upload(admin, body(bytes()), {});
    const record = spyOn(audit, "record").mockRejectedValue(new Error("Audit fixture failure"));
    try {
      await expect(service.upload(admin, body(bytes("Custom-City")), {})).rejects.toThrow("Audit fixture failure");
      await expect(service.reset(admin, "city")).rejects.toThrow("Audit fixture failure");
    } finally {
      record.mockRestore();
    }
    const stored = await service.status(admin, { now: () => frozenNow });
    expect(stored.databases[0].upload?.sha256).toBe(uploaded.databases[0].upload!.sha256);
    expect(reader.status().city?.sha256).toBe(uploaded.databases[0].upload!.sha256);
  });

  test("large bytea reads use slices and preserve the uploaded bytes", async () => {
    const fixture = bytes();
    const marker = fixture.indexOf(Buffer.from("abcdef4d61784d696e642e636f6d", "hex"));
    const large = Buffer.concat([fixture.subarray(0, marker), Buffer.alloc(9 * 1024 * 1024), fixture.subarray(marker)]);
    const result = await service.upload(admin, body(large), {});
    const source = createGeoIpUploads();
    const sha256 = result.databases[0].upload!.sha256;
    expect(await source.versions()).toEqual({ city: sha256 });
    expect(await source.read("city", sha256)).toEqual(large);
    expect(await source.read("city", "0".repeat(64))).toBeNull();
    const [column] = await sql<{ attstorage: string }[]>`
      SELECT attstorage FROM pg_attribute WHERE attrelid = 'geoip.databases'::regclass AND attname = 'data'`;
    expect(column?.attstorage).toBe("e");
  });
});
