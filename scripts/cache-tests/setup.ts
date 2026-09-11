import assert from "node:assert/strict";
const db = new URL(process.env.DATABASE_URL!);
assert.equal(db.hostname, "127.0.0.1");
assert.equal(db.pathname, "/cloud_cache_test");
assert.equal(process.env.CLOUD_CACHE_TEST, "1");
for (const name of ["auth", "settings", "rail-preferences", "rail-shortcuts", "announcements", "logging"]) {
  await (await import(`../../packages/core/src/migrate/core/${name}.ts`)).migrate();
}
