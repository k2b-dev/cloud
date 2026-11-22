import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { BASE_ATTENTION_ALERT_LIMIT } from "./base-attention";
import { seedActiveBaseStore } from "./base-store.test-fixture";

suiteFor("database")("base attention reads the alerts and the store state of one readable base", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  beforeAll(async () => {
    database = await useMigratedDatabase("pulse_base_attention");
  }, 30_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });
  const fixture = async (baseId: string) => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${baseId},'local','user','Attention reader') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${baseId.slice(0, 6)},'Attention')`;
    await seedActiveBaseStore(baseId);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    return { ...adminFixtureIdentity(user!.id, false), baseId };
  };
  const rule = (baseId: string, shortId: string, state: string, severity: string | null, since: string) =>
    sql`INSERT INTO pulse.alert_rules(short_id,base_id,name,sql,comparison,warn,critical,min_duration_seconds,interval_seconds,state,severity,since)
      VALUES(${shortId},${baseId}::uuid,${`Rule ${shortId}`},'SELECT 1','above',80,95,0,300,${state},${severity},${since})`;

  test("fired critical, fired warning, unchecked, then no data; resolved rules and stale sources stay out", async () => {
    const input = await fixture("a57f31ac-d628-4505-bfd4-b5ff86ec8a98");
    const { readBaseAttention } = await import("./base-attention");
    const { settingsFixture } = await import("../store/settings.test-fixture");
    const settings = settingsFixture(); // No store connection: the read still answers and says the store is unavailable.
    try {
      for (const [shortId, state, severity] of [
        ["Attn0a", "firing", "warn"],
        ["Attn1a", "error", null],
        ["Attn2a", "firing", "critical"],
        ["Attn3a", "no_data", null],
        ["Attn4a", "ok", null],
        ["Attn5a", "pending", null],
      ] as const)
        await rule(input.baseId, shortId, state, severity, "2026-10-20T10:00:00Z");
      const [critical] = await sql<{ id: string }[]>`SELECT id FROM pulse.alert_rules WHERE short_id='Attn2a'`;
      await sql`INSERT INTO pulse.alert_states(rule_id,key,state,severity,value,since,last_checked_at)
        VALUES(${critical!.id}::uuid,'cpu','firing','critical',97,'2026-10-20T10:00:00Z','2026-10-20T10:05:00Z')`;
      await sql`INSERT INTO pulse.sources(short_id,base_id,kind,name,last_data_at,stale_since,expect_every_seconds)
        VALUES('Stale6',${input.baseId}::uuid,'http_ingest','Old','2026-10-20T09:00:00Z','2026-10-20T10:00:00Z',3600)`;
      const read = await readBaseAttention(input);
      if (!read.ok) throw new Error(read.error.message);
      expect(read.data.alerts.map((alert) => alert.reference)).toEqual(["Attn2a", "Attn0a", "Attn1a", "Attn3a"]);
      expect(read.data.alerts[0]).toMatchObject({ key: "cpu", value: 97, comparison: "above", threshold: 95 });
      expect(read.data.alerts[1]).toMatchObject({ key: null, value: null, threshold: 80 });
      expect(read.data.store).toEqual({ unavailable: true, since: null });
      // An instance outage names when it started.
      await sql`INSERT INTO pulse.store_instance(singleton,outage_started_at) VALUES(true,'2026-10-20T09:30:00Z')
        ON CONFLICT(singleton) DO UPDATE SET outage_started_at=EXCLUDED.outage_started_at`;
      const outage = await readBaseAttention(input);
      expect(outage.ok && outage.data.store).toEqual({ unavailable: true, since: "2026-10-20T09:30:00.000Z" });
      // Without an outage, a failed base store names when it failed.
      await sql`UPDATE pulse.store_instance SET outage_started_at=NULL WHERE singleton`;
      await sql`UPDATE pulse.base_stores SET state='failed',last_error='STORE_UNREACHABLE',last_error_at='2026-10-20T09:45:00Z'
        WHERE base_id=${input.baseId}::uuid`;
      const failed = await readBaseAttention(input);
      expect(failed.ok && failed.data.store).toEqual({ unavailable: true, since: "2026-10-20T09:45:00.000Z" });
    } finally {
      await sql`UPDATE pulse.store_instance SET outage_started_at=NULL WHERE singleton`;
      settings.restore();
    }
  });

  test("the alert list is bounded, and only readers of an existing base get an answer", async () => {
    const input = await fixture("b57f31ac-d628-4505-bfd4-b5ff86ec8a98");
    const { readBaseAttention } = await import("./base-attention");
    const { settingsFixture } = await import("../store/settings.test-fixture");
    const settings = settingsFixture();
    try {
      for (let index = 0; index <= BASE_ATTENTION_ALERT_LIMIT; index++)
        await rule(input.baseId, `Lim${String(index).padStart(3, "0")}`, "firing", "warn", "2026-10-20T10:00:00Z");
      const read = await readBaseAttention(input);
      expect(read.ok && read.data.alerts.length).toBe(BASE_ATTENTION_ALERT_LIMIT);
      expect(read.ok && read.data.alerts.at(-1)?.reference).toBe(`Lim${String(BASE_ATTENTION_ALERT_LIMIT - 1).padStart(3, "0")}`);
      // The public base ID reads the same base.
      expect((await readBaseAttention({ ...input, baseId: input.baseId.slice(0, 6) })).ok).toBe(true);
      expect(await readBaseAttention({ ...input, ...adminFixtureIdentity("257f31ac-d628-4505-bfd4-b5ff86ec8a98", false) })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      expect(await readBaseAttention({ ...input, baseId: "Nobase" })).toMatchObject({ ok: false, error: { status: 404 } });
      await sql`UPDATE pulse.bases SET deletion_started_at=now() WHERE id=${input.baseId}::uuid`;
      expect(await readBaseAttention(input)).toMatchObject({ ok: false, error: { status: 404 } });
    } finally {
      settings.restore();
    }
  });
});
