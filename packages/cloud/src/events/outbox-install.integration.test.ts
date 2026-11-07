import { expect, test } from "bun:test";
import { installLiveOutbox } from "@k2b/cloud/events/testing";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";

const schema = (db: SQL) => db`
  SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint WHERE conrelid = 'events.outbox'::regclass
  UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'events'
  UNION ALL SELECT 'function', proname, pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace = 'events'::regnamespace
  ORDER BY kind, name
`;

databaseSuite()("standalone app outbox installation", () => {
  test("installs only events, matches Core, and keeps trigger writes transactional", async () => {
    const database = await createDisposableDatabase("outbox_install");
    const db = new SQL(database.url);
    try {
      await installLiveOutbox(db);
      const installed = await schema(db);
      expect(installed.length).toBeGreaterThan(0);
      expect(
        await db<
          { auth: string | null; workflows: string | null }[]
        >`SELECT to_regnamespace('auth') AS auth, to_regnamespace('workflows') AS workflows`,
      ).toEqual([{ auth: null, workflows: null }]);
      await installLiveOutbox(db);
      expect(await schema(db)).toEqual(installed);
      // Execute the real production migration, without pulling Core's program into the package typecheck.
      const corePath = "../../../core/src/migrate/core/events";
      const { migrate } = await import(corePath);
      await migrate(db);
      expect(await schema(db)).toEqual(installed);

      await db
        .unsafe(`
        CREATE TABLE public.items (n integer);
        CREATE FUNCTION public.item_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          PERFORM events.enqueue(gen_random_uuid(), 'inventory', 'live', 'items',
            jsonb_build_object('v', 1, 'k', 'items', 'd', NEW.n), 'items');
          RETURN NEW;
        END $$;
        CREATE TRIGGER item_changed AFTER INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.item_changed();
      `)
        .simple();
      const rollback = new Error("rollback domain write");
      await expect(
        db.begin(async (tx) => {
          await tx`INSERT INTO public.items VALUES (1)`;
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await db<unknown[]>`SELECT * FROM events.outbox`).toEqual([]);
      await db.begin(async (tx) => {
        await tx`INSERT INTO public.items VALUES (1)`;
        const [first] = await tx<{ seq: string }[]>`SELECT seq FROM events.outbox`;
        if (!first) throw new Error("Missing trigger outbox row");
        await tx`INSERT INTO public.items VALUES (2)`;
        expect(await tx<{ seq: string; payload: unknown }[]>`SELECT seq, payload FROM events.outbox`).toEqual([
          { seq: first.seq, payload: { v: 1, k: "items", d: 2 } },
        ]);
      });
      await db`INSERT INTO public.items VALUES (3)`;
      expect(await db<{ payload: unknown }[]>`SELECT payload FROM events.outbox ORDER BY seq`).toEqual([
        { payload: { v: 1, k: "items", d: 2 } },
        { payload: { v: 1, k: "items", d: 3 } },
      ]);
      await db`SELECT events.enqueue('00000000-0000-4000-8000-000000000001'::uuid, 'inventory', 'live', 'large', ${JSON.stringify({ v: 1, k: "large", d: "x".repeat(40_000) })}::jsonb)`;
      expect(await db<{ payload: unknown }[]>`SELECT payload FROM events.outbox WHERE ordering_key = 'large'`).toEqual([
        { payload: { v: 1, k: "large", r: true } },
      ]);
      await expect(
        db`SELECT events.enqueue('00000000-0000-4000-8000-000000000002'::uuid, 'inventory', 'event', 'large', ${JSON.stringify({ d: "x".repeat(5000) })}::jsonb)`.execute(),
      ).rejects.toThrow();
      await expect(
        db`SELECT events.enqueue('00000000-0000-4000-8000-000000000003'::uuid, '', 'live', 'invalid', '{}'::jsonb)`.execute(),
      ).rejects.toThrow();
    } finally {
      await db.close();
      await database.drop();
    }
  });
});
