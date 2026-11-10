import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { S3Client, SQL } from "bun";
import { requireInfraUrl, suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate as migrateSettings } from "../../../../core/src/migrate/core/settings";
import { objectStoreBackend, resolveObjectStoreConfig } from "../../_internal/object-store-config";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { createAdminStorageRoutes } from "../../api/admin-storage";
import { AdminStorageBucketSchema, DEFAULT_STORAGE_BUCKET_ID, StorageBucketIdSchema } from "../../contracts/storage-buckets";
import { sql } from "../../runtime/clients";
import { servePublicStorage } from "../../server/public-storage";
import { storage } from "../object-store";
import { buildProjectedUser } from "../session/user";
import { getAll, set } from "../settings";
import { registerSettings, SETTINGS, SETTINGS_MAP, toLegacySettingDefs } from "../settings/defaults";
import { migrateStorageBuckets } from "./migrate";
import { storageBucketStore } from "./store";

suiteFor(
  "s3",
  "database",
  "valkey",
)("additional storage buckets against Garage and Postgres", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let endpoint: string;
  let accessKeyId: string;
  let secretAccessKey: string;
  let bucket: string;
  let raw: S3Client;
  const context = { actor: { userId: "00000000-0000-4000-8000-000000000003" } };
  const inApp = (id: string) => {
    clearProcessApplicationId();
    bindProcessApplicationId(id);
  };
  const own = (name: string) => ({ access: "own" as const, name, endpoint, region: "garage", bucket, accessKeyId, secretAccessKey });
  const user = buildProjectedUser({ id: context.actor.userId, provider: "local", profile: "user", effective_admin: true });
  const routes = createAdminStorageRoutes(async (c, next) => {
    c.set("user", user);
    await next();
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    routes.request(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  const responseBucket = async (response: Response) => {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("bucket" in value)) throw new Error("Expected a bucket response");
    return AdminStorageBucketSchema.parse(value.bucket);
  };
  beforeAll(async () => {
    database = await useFreshDatabase("storage_buckets");
    endpoint = requireInfraUrl("s3");
    accessKeyId = process.env.CLOUD_TEST_S3_ACCESS_KEY_ID ?? "";
    secretAccessKey = process.env.CLOUD_TEST_S3_SECRET_ACCESS_KEY ?? "";
    bucket = process.env.CLOUD_TEST_S3_BUCKET ?? "";
    raw = new S3Client({ endpoint, region: "garage", bucket, accessKeyId, secretAccessKey });
    await migrateSettings();
    await migrateAudit();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY, uid TEXT, display_name TEXT)`.simple();
    await sql`INSERT INTO auth.users VALUES (${context.actor.userId}::uuid, 'storage-admin', 'Storage Admin')`;
    for (const [key, value] of Object.entries({
      "storage.endpoint": endpoint,
      "storage.region": "garage",
      "storage.bucket": bucket,
      "storage.access_key_id": accessKeyId,
      "storage.secret_access_key": secretAccessKey,
      "storage.max_object_bytes": 1024,
      "app.url": "https://cloud.example.test",
      "security.rate_limit_per_second": 1000,
    }))
      await set(key, value);
    inApp("storage-bucket-a");
  });
  afterAll(async () => {
    try {
      if (raw)
        for (const prefix of ["private/storage-bucket-", "public/storage-bucket-"]) {
          const page = await raw.list({ prefix });
          await Promise.all((page.contents ?? []).map((object) => raw.file(object.key).delete()));
        }
    } finally {
      clearProcessApplicationId();
      if (database) await database.drop();
    }
  });

  test("default storage works before the idempotent bucket migration", async () => {
    expect(await storage.buckets()).toEqual([{ id: DEFAULT_STORAGE_BUCKET_ID, name: "Default", isDefault: true, connected: true }]);
    await storage.file("default.txt").write("default");
    expect(await storage.file("default.txt").text()).toBe("default");
    const missing = StorageBucketIdSchema.parse("00000000-0000-4000-8000-000000000099");
    await expect(objectStoreBackend(missing)).rejects.toMatchObject({ code: "storage_not_configured" });
    await migrateStorageBuckets();
    await migrateStorageBuckets();
    const [tables] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'platform' AND tablename LIKE 'storage_bucket%'`;
    expect(tables?.count).toBe(2);
    await expect(objectStoreBackend(missing)).rejects.toMatchObject({ code: "storage_bucket_unknown" });
  });

  test("two applications stay isolated in both areas of an additional bucket", async () => {
    const added = await storageBucketStore.create(own("Isolation"), context);
    expect(added.check.state).toBe("ok");
    const selected = storage.bucket(added.id);
    inApp("storage-bucket-b");
    await selected.file("private.txt").write("app B");
    inApp("storage-bucket-a");
    const file = selected.file("private.txt");
    expect(await file.exists()).toBe(false);
    await file.write("app A");
    await file.copy("copy.txt");
    expect(await selected.file("copy.txt").text()).toBe("app A");
    await selected.public.file("image.png").write("image", { type: "image/png" });
    expect((await selected.list()).contents?.map((item) => item.key)).toEqual(["copy.txt", "default.txt", "private.txt"]);
    expect((await selected.public.list()).contents?.map((item) => item.key)).toEqual(["image.png"]);
    inApp("storage-bucket-b");
    expect(await selected.file("private.txt").text()).toBe("app B");
    expect((await selected.public.list()).contents ?? []).toEqual([]);
    inApp("storage-bucket-a");
  });

  test("rename and endpoint edits keep existing references and handles working", async () => {
    const added = await storageBucketStore.create(own("Before rename"), context);
    const file = storage.bucket(added.id).file("rename.txt");
    await file.write("stable ID");
    const alternate = new URL(endpoint);
    alternate.hostname = alternate.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const changed = await storageBucketStore.update(
      added.id,
      { ...own("After rename"), endpoint: alternate.origin, revision: added.revision ?? 0 },
      context,
    );
    expect(changed.id).toBe(added.id);
    expect(changed.check.state).toBe("ok");
    expect(await file.text()).toBe("stable ID");
    const originalBackend = await objectStoreBackend(added.id);
    expect(originalBackend.client).toBe((await objectStoreBackend(added.id)).client);
  });

  test("inherit uses current default access, invalidates checks and recovers after key rotation", async () => {
    const added = await storageBucketStore.create({ access: "inherit", name: "Inherited", bucket }, context);
    const file = storage.bucket(added.id).file("inherit.txt");
    await file.write("inherited");
    const before = await resolveObjectStoreConfig(added.id);
    try {
      await set("storage.access_key_id", "rotated-test-access");
      const after = await resolveObjectStoreConfig(added.id);
      expect(after.signature).not.toBe(before.signature);
      expect(after.config.access_key_id).toBe("rotated-test-access");
      expect(new URL(await file.presign()).searchParams.get("X-Amz-Credential")).toStartWith("rotated-test-access/");
      expect((await storageBucketStore.get(added.id)).check.state).toBe("untested");
    } finally {
      await set("storage.access_key_id", accessKeyId);
    }
    expect(await file.text()).toBe("inherited");
    expect((await storageBucketStore.test(added.id, context)).check.state).toBe("ok");
  });

  test("inherit never depends on the default bucket's own target", async () => {
    const added = await storageBucketStore.create({ access: "inherit", name: "Independent target", bucket }, context);
    const file = storage.bucket(added.id).file("independent.txt");
    await file.write("independent target");
    const [before] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'storage.bucket'`;
    if (!before) throw new Error("Missing test setting");
    try {
      await sql`UPDATE settings.entries SET value = 'unreadable-test-value' WHERE key = 'storage.bucket'`;
      expect(await file.text()).toBe("independent target");
      expect((await storageBucketStore.get(added.id)).check.state).toBe("ok");
      await expect(storage.file("default.txt").text()).rejects.toMatchObject({ code: "storage_unreadable" });
    } finally {
      await sql`UPDATE settings.entries SET value = ${before.value} WHERE key = 'storage.bucket'`;
    }
  });

  test("disconnect deletes credentials and restore keeps the ID and target", async () => {
    const added = await storageBucketStore.create(own("Restore"), context);
    const file = storage.bucket(added.id).file("restore.txt");
    await file.write("retained");
    const removed = await storageBucketStore.remove(added.id, context);
    expect(removed.hasCredentials).toBe(false);
    const [row] = await sql<
      { credentials_encrypted: string | null }[]
    >`SELECT credentials_encrypted FROM platform.storage_buckets WHERE id = ${added.id}::uuid`;
    expect(row?.credentials_encrypted).toBeNull();
    await expect(file.text()).rejects.toMatchObject({ code: "storage_bucket_disconnected" });
    await expect(storageBucketStore.restore(added.id, {}, context)).rejects.toMatchObject({ code: "storage_bucket_invalid" });
    const restored = await storageBucketStore.restore(added.id, { accessKeyId, secretAccessKey }, context);
    expect(restored.id).toBe(added.id);
    expect(restored.bucket).toBe(added.bucket);
    expect(await file.text()).toBe("retained");
  });

  test("public ~id URLs serve through the shared route and unknown/disconnected IDs are 404", async () => {
    const added = await storageBucketStore.create(own("Public"), context);
    const image = storage.bucket(added.id).public.file("public.png");
    await image.write("image", { type: "image/png" });
    const url = await image.url;
    expect(url).toContain(`/public/storage/~${added.id}/storage-bucket-a/`);
    const response = await servePublicStorage(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("image");
    await storageBucketStore.remove(added.id, context);
    expect((await servePublicStorage(new Request(url))).status).toBe(404);
    expect((await servePublicStorage(new Request(url.replace(added.id, "00000000-0000-4000-8000-000000000099")))).status).toBe(404);
  });

  test("admin CRUD, optimistic conflicts, case-insensitive names, usage and auto tests", async () => {
    const response = await request("/buckets", "POST", own("Admin API"));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const added = await responseBucket(response);
    expect(added.check.state).toBe("ok");
    const update = { ...own("Admin renamed"), revision: added.revision ?? 0 };
    const changed = await responseBucket(await request(`/buckets/${added.id}`, "PUT", update));
    expect(changed.revision).toBe((added.revision ?? 0) + 1);
    const conflict = await request(`/buckets/${added.id}`, "PUT", update);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "storage_bucket_conflict", current: { revision: changed.revision } });
    const collision = await request("/buckets", "POST", own("ADMIN RENAMED"));
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ code: "storage_bucket_name_taken" });
    expect((await request(`/buckets/${added.id}/test`, "POST")).status).toBe(200);
    const usage = await request(`/buckets/${added.id}/usage`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({ packages: ["storage-bucket-a", "storage-bucket-b"], truncated: false });
    expect((await request(`/buckets/${added.id}`, "DELETE")).status).toBe(200);
    const disconnected = await request(`/buckets/${added.id}/usage`);
    expect(disconnected.status).toBe(409);
    expect(await disconnected.json()).toMatchObject({ code: "storage_bucket_disconnected" });
    expect((await request(`/buckets/${added.id}/restore`, "POST", { accessKeyId, secretAccessKey })).status).toBe(200);
    expect((await responseBucket(await request("/buckets/default/test", "POST"))).check.state).toBe("ok");
    for (const method of ["PUT", "DELETE"])
      expect((await request("/buckets/default", method, method === "PUT" ? update : undefined)).status).toBe(400);
    expect((await request("/buckets/not-an-id/usage")).status).toBe(400);
    expect((await request("/buckets/00000000-0000-4000-8000-000000000099/test", "POST")).status).toBe(404);
  });

  test("failed automatic checks save the bucket and expose only the failing step", async () => {
    const fail = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request("/buckets", "POST", { ...own("Unreachable"), endpoint: "http://127.0.0.1:1" });
      expect(response.status).toBe(201);
      const added = await responseBucket(response);
      expect(added.check.state).toBe("failed");
      expect(added.check.step).toBe("write");
      expect((await storageBucketStore.get(added.id)).id).toBe(added.id);
      expect((await request(`/buckets/${added.id}/usage`)).status).toBe(502);
      await storageBucketStore.remove(added.id, context);
    } finally {
      fail.mockRestore();
    }
  }, 20000);

  test("incomplete inherited access records a config failure and becomes untested after correction", async () => {
    try {
      await set("storage.secret_access_key", "");
      const added = await storageBucketStore.create({ access: "inherit", name: "Incomplete inherited", bucket }, context);
      expect(added.check.state).toBe("failed");
      expect(added.check.step).toBe("config");
      await set("storage.secret_access_key", secretAccessKey);
      expect((await storageBucketStore.get(added.id)).check.state).toBe("untested");
      expect((await storageBucketStore.test(added.id, context)).check.state).toBe("ok");
    } finally {
      await set("storage.secret_access_key", secretAccessKey);
    }
  });

  test("restore refuses a reused name and partial credential updates retain the omitted key", async () => {
    const first = await storageBucketStore.create(own("Reused name"), context);
    await storageBucketStore.remove(first.id, context);
    const replacement = await storageBucketStore.create(own("Reused name"), context);
    await expect(storageBucketStore.restore(first.id, { accessKeyId, secretAccessKey }, context)).rejects.toMatchObject({
      code: "storage_bucket_name_taken",
    });
    const { accessKeyId: _accessKeyId, ...input } = own("One key replaced");
    const changed = await storageBucketStore.update(replacement.id, { ...input, revision: replacement.revision ?? 0 }, context);
    expect(changed.check.state).toBe("ok");
    const list = await storage.buckets();
    expect(list[0]?.id).toBe(DEFAULT_STORAGE_BUCKET_ID);
    const firstDisconnected = list.findIndex((item) => !item.connected);
    expect(list.slice(firstDisconnected).every((item) => !item.connected)).toBe(true);
  });

  test("lists, audit events, logs and invalid endpoint errors never contain keys", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const added = await storageBucketStore.create(own("Secret check"), context);
      await storageBucketStore.update(added.id, { ...own("Secret check changed"), revision: added.revision ?? 0 }, context);
      const list = await request("/buckets");
      const serialized = await list.text();
      const summaries = JSON.stringify(await storage.buckets());
      const events = JSON.stringify(await sql`SELECT * FROM audit.events WHERE action LIKE 'storage.bucket.%'`);
      const invalid = await request("/buckets", "POST", {
        ...own("Bad endpoint"),
        endpoint: `https://user:${secretAccessKey}@example.test/path`,
      });
      expect(invalid.status).toBe(400);
      const output = [
        serialized,
        summaries,
        events,
        await invalid.text(),
        JSON.stringify(log.mock.calls),
        JSON.stringify(warn.mock.calls),
        JSON.stringify(error.mock.calls),
      ].join("\n");
      expect(output).not.toContain(accessKeyId);
      expect(output).not.toContain(secretAccessKey);
      expect(summaries).not.toContain(endpoint);
      expect(summaries).not.toContain(bucket);
      expect(events).toContain("storage.bucket.create");
      expect(events).toContain("storage.bucket.test");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("storage_bucket settings entries include safe choices, including disconnected buckets", async () => {
    const defs = toLegacySettingDefs({ "storage-test.bucket": { kind: "storage_bucket" } });
    registerSettings(defs);
    try {
      const entry = (await getAll()).find((item) => item.key === "storage-test.bucket");
      expect(entry?.value).toBe(DEFAULT_STORAGE_BUCKET_ID);
      expect(entry?.storageBuckets?.[0]?.isDefault).toBe(true);
      expect(entry?.storageBuckets?.some((item) => !item.connected)).toBe(true);
      expect(JSON.stringify(entry?.storageBuckets)).not.toContain(secretAccessKey);
      await set("storage-test.bucket", " ABCDEF12-1234-5678-90AB-ABCDEF123456 ");
      expect((await getAll()).find((item) => item.key === "storage-test.bucket")?.value).toBe("abcdef12-1234-5678-90ab-abcdef123456");
    } finally {
      SETTINGS_MAP.delete("storage-test.bucket");
      const index = SETTINGS.findIndex((item) => item.key === "storage-test.bucket");
      if (index >= 0) SETTINGS.splice(index, 1);
    }
  });

  test("an application role with SELECT can resolve buckets but cannot change their rows", async () => {
    await sql`DROP ROLE IF EXISTS storage_bucket_reader`;
    await sql`CREATE ROLE storage_bucket_reader NOLOGIN`;
    await sql`GRANT USAGE ON SCHEMA platform TO storage_bucket_reader`;
    await sql`GRANT SELECT ON platform.storage_buckets, platform.storage_bucket_checks TO storage_bucket_reader`;
    const reader = new SQL(database.url, { max: 1 });
    try {
      await reader`SET ROLE storage_bucket_reader`;
      const rows = await reader<{ name: string }[]>`SELECT name FROM platform.storage_buckets`;
      expect(rows.length).toBeGreaterThan(0);
      try {
        await reader`DELETE FROM platform.storage_buckets`;
        throw new Error("Unexpected write permission");
      } catch (error) {
        expect(error).toMatchObject({ errno: "42501" });
      }
    } finally {
      await reader.close();
      await sql`REVOKE SELECT ON platform.storage_buckets, platform.storage_bucket_checks FROM storage_bucket_reader`;
      await sql`REVOKE USAGE ON SCHEMA platform FROM storage_bucket_reader`;
      await sql`DROP ROLE storage_bucket_reader`;
    }
  });
});
