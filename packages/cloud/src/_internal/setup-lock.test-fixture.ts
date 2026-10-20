import { createInterface } from "node:readline";
import { sql } from "bun";
import { defineApp } from "./define-app";

// Only imports define-app: reverting its setup call is the negative control for this fixture.
const [appId, schema, mode] = process.argv.slice(2);
if (!appId || !schema || !/^setup_lock_[a-f0-9]+$/.test(schema)) throw new Error("Invalid setup probe arguments");
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const command = async () => {
  if ((await lines.next()).done) throw new Error("Parent closed the setup probe barrier");
};
const report = (event: string, details = {}) =>
  console.log(JSON.stringify({ event, at: performance.timeOrigin + performance.now(), ...details }));
const app = defineApp({
  id: appId,
  name: "Setup lock probe",
  icon: "ti ti-lock",
  description: "Concurrent setup regression",
  baseUrl: "http://setup-lock.test:3000",
  routes: [`/api/${appId}`],
});
report("armed");
await command();
try {
  await app.start({
    fetch: () => new Response("probe"),
    lifecycle: {
      setup: async () => {
        report("setup-start");
        if (mode === "hold") {
          await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`).simple();
          report("partial");
          await new Promise<void>(() => {});
        }
        // Hold the first DDL until the parent sees the other replica waiting for either
        // the setup lease or this uncommitted schema. Without the lease this reliably
        // reproduces pg_namespace's unique violation on a cold schema.
        await sql.begin(async (tx) => {
          await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`).simple();
          report("schema-created");
          await command();
        });
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${schema}.items (id integer PRIMARY KEY, value integer NOT NULL)`).simple();
        await sql.unsafe(`CREATE INDEX IF NOT EXISTS items_value_idx ON ${schema}.items (value)`).simple();
        await sql.unsafe(`ALTER TABLE ${schema}.items DROP CONSTRAINT IF EXISTS value_positive`).simple();
        await sql.unsafe(`ALTER TABLE ${schema}.items ADD CONSTRAINT value_positive CHECK (value >= 0)`).simple();
        await sql
          .unsafe(`CREATE OR REPLACE FUNCTION ${schema}.check_item() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RETURN NEW; END $$`)
          .simple();
        await sql.unsafe(`DROP TRIGGER IF EXISTS check_item ON ${schema}.items`).simple();
        await sql
          .unsafe(`CREATE TRIGGER check_item BEFORE INSERT ON ${schema}.items FOR EACH ROW EXECUTE FUNCTION ${schema}.check_item()`)
          .simple();
        report("setup-end");
      },
    },
  });
  report("ready");
  await command();
  // defineApp's signal handler unregisters the heartbeat and drains process Sync before exit.
  process.kill(process.pid, "SIGTERM");
} catch (error) {
  report("failed", { message: error instanceof Error ? error.message : String(error), code: Reflect.get(Object(error), "code") });
  await sql.close();
  process.exit(1);
}
