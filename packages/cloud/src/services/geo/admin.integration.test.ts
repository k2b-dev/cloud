import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { createGeoAdmin, GeoAdminError } from "./admin";
import { GEO_TEST_NOW, geoTestConfig } from "./geo.test-fixture";
import { createGeoLedger } from "./ledger";
import { migrate } from "./migrate";
import { readGeoConfig } from "./settings";

const admin = { id: "11111111-1111-4111-8111-111111111111", uid: "lea", provider: "local", roles: ["admin", "user"] };
const person = { id: "22222222-2222-4222-8222-222222222222", uid: "max", provider: "local", roles: ["user"] };
const previousSecret = process.env.APP_SECRET;

suiteFor("database", "valkey")("Core geo administration", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const checked: string[] = [];
  // The provider check: keys starting with "ok-" pass, "bad-" are refused, anything else cannot be verified.
  const verify = async (apiKey: string) => {
    checked.push(apiKey);
    if (apiKey.startsWith("bad-")) throw new GeoAdminError({ code: "geo_key_rejected" }, 422);
    if (!apiKey.startsWith("ok-")) throw new GeoAdminError({ code: "geo_key_unverified" }, 502);
  };
  const service = () => createGeoAdmin({ verify, now: () => GEO_TEST_NOW });
  const storedKey = async () => (await import("../settings")).readStates(["geo.api_key"]).then((states) => states.get("geo.api_key"));

  beforeAll(async () => {
    process.env.APP_SECRET = "test-only-geo-admin";
    database = await useFreshDatabase("geo_admin");
    await migrate(sql);
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.simple();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY, uid text NOT NULL, display_name text)`.simple();
    await sql`INSERT INTO auth.users VALUES (${admin.id}, 'lea', 'Lea Schulz'), (${person.id}, 'max', '')`;
    await sql`CREATE SCHEMA audit`.simple();
    await sql`CREATE TABLE audit.events (
      id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), action text, outcome text,
      actor_user_id uuid, actor_uid text, actor_provider text, actor_roles text[],
      target_type text, target_id text, target_label text, target_provider text,
      reason text, error_code text, error_message text, request_id text, metadata jsonb
    )`.simple();
  });
  beforeEach(async () => {
    checked.length = 0;
    await sql`TRUNCATE settings.entries, audit.events, geo.shares, geo.usage`;
    await sql`INSERT INTO settings.entries (key, value) VALUES ('app.timezone', ${await (await import("../settings/crypto")).encryptValue("Europe/Berlin")})`;
  });
  afterAll(async () => {
    await sql.close();
    await database?.drop();
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  });

  test("a verified key is stored and named with its admin; a refused or unverifiable replacement keeps the old key", async () => {
    const geo = service();
    expect((await geo.status(admin)).key).toEqual({ state: "none", setAt: null, setBy: null });
    const set = await geo.setKey(admin, "  ok-first  ");
    expect(set.key).toMatchObject({ state: "set", setBy: { id: admin.id, name: "Lea Schulz" } });
    expect(JSON.stringify(set)).not.toContain("ok-first");
    expect((await storedKey())?.value).toBe("ok-first");

    for (const [candidate, code] of [
      ["bad-second", "geo_key_rejected"],
      ["down-second", "geo_key_unverified"],
    ] as const) {
      const refused = await geo.setKey(admin, candidate).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(GeoAdminError);
      expect((refused as GeoAdminError).body).toEqual({ code });
      expect(String((refused as GeoAdminError).message)).not.toContain(candidate);
      expect((await storedKey())?.value).toBe("ok-first");
    }
    await geo.setKey(admin, "ok-second");
    expect((await storedKey())?.value).toBe("ok-second");
    const events = await sql<{ action: string; metadata: { replaced: boolean } }[]>`
      SELECT action, metadata FROM audit.events ORDER BY id`;
    expect(events.map((event) => [event.action, event.metadata.replaced])).toEqual([
      ["core.geo.key_set", false],
      ["core.geo.key_set", true],
    ]);
    expect(JSON.stringify(events)).not.toContain("ok-");
  });

  test("empty and malformed keys are refused before any provider check", async () => {
    const geo = service();
    for (const [raw, code] of [
      ["   ", "geo_key_missing"],
      ["has space", "geo_key_malformed"],
      ["x".repeat(257), "geo_key_malformed"],
    ] as const)
      expect(((await geo.setKey(admin, raw).catch((error: unknown) => error)) as GeoAdminError).body).toEqual({ code });
    expect(checked).toEqual([]);
  });

  test("an unreadable stored key is reported and can be replaced or removed", async () => {
    await sql`INSERT INTO settings.entries (key, value) VALUES ('geo.api_key', 'broken-ciphertext')`;
    const geo = service();
    expect((await geo.status(admin)).key.state).toBe("unreadable");
    expect((await geo.setKey(admin, "ok-repair")).key.state).toBe("set");
    await sql`UPDATE settings.entries SET value = 'broken-ciphertext' WHERE key = 'geo.api_key'`;
    expect((await geo.removeKey(admin)).key).toEqual({ state: "none", setAt: null, setBy: null });
  });

  test("removing the key turns geo off and is audited once", async () => {
    const geo = service();
    await geo.setKey(admin, "ok-key");
    expect((await geo.removeKey(admin)).key.state).toBe("none");
    expect((await geo.removeKey(admin)).key.state).toBe("none");
    const actions = await sql<{ action: string }[]>`SELECT action FROM audit.events ORDER BY id`;
    expect(actions.map((row) => row.action)).toEqual(["core.geo.key_set", "core.geo.key_removed"]);
  });

  test("budget saves validate every field and the pair before writing, and report who changed them", async () => {
    const geo = service();
    const initial = (await geo.status(admin)).budget;
    expect(initial).toMatchObject({ plan: "free", monthlyCredits: 90000, personDailyCredits: 300, changedAt: null, changedBy: null });
    const invalid = (await geo
      .saveBudget(admin, { plan: "custom", customRps: 0, customDailyCredits: 1.5, monthlyCredits: 90000, personDailyCredits: 120000 })
      .catch((error: unknown) => error)) as GeoAdminError;
    expect(invalid.body).toEqual({
      code: "geo_budget_invalid",
      errors: {
        customRps: { code: "too_small", min: 1 },
        customDailyCredits: { code: "not_whole_number" },
        personDailyCredits: { code: "above_monthly", max: 90000 },
      },
    });
    expect(await sql<{ key: string }[]>`SELECT key FROM settings.entries WHERE key LIKE 'geo.%'`).toHaveLength(0);

    const saved = await geo.saveBudget(admin, {
      plan: "api10",
      customRps: "ignored",
      customDailyCredits: null,
      monthlyCredits: 300000,
      personDailyCredits: 500,
    });
    expect(saved.budget).toMatchObject({
      plan: "api10",
      monthlyCredits: 300000,
      personDailyCredits: 500,
      customRps: 5,
      unreadable: [],
      changedBy: { id: admin.id, name: "Lea Schulz" },
    });
    expect(saved.plans.api10).toEqual({ dailyCredits: 10000, rps: 12 });
    expect(saved.timezone).toBe("Europe/Berlin");
    // A later write outside this page has no audited person: the date stays, the name goes.
    await sql`UPDATE settings.entries SET updated_at = now() + interval '1 minute' WHERE key = 'geo.plan'`;
    expect((await geo.status(admin)).budget.changedBy).toBeNull();
    // A write that committed later but started earlier carries an older stamp; the saved rows no longer agree, so
    // the page names nobody instead of the person whose values were partly overwritten.
    await geo.saveBudget(admin, { plan: "api10", customRps: 5, customDailyCredits: 3000, monthlyCredits: 300000, personDailyCredits: 500 });
    expect((await geo.status(admin)).budget.changedBy?.name).toBe("Lea Schulz");
    await sql`UPDATE settings.entries SET updated_at = updated_at - interval '1 second' WHERE key = 'geo.plan'`;
    expect((await geo.status(admin)).budget.changedBy).toBeNull();
  });

  test("saving the budget replaces an unreadable stored value", async () => {
    await sql`INSERT INTO settings.entries (key, value) VALUES ('geo.monthly_budget_credits', 'broken-ciphertext')`;
    const geo = service();
    expect((await geo.status(admin)).budget.unreadable).toEqual(["monthlyCredits"]);
    const saved = await geo.saveBudget(admin, {
      plan: "free",
      customRps: 5,
      customDailyCredits: 3000,
      monthlyCredits: 50000,
      personDailyCredits: 300,
    });
    expect(saved.budget).toMatchObject({ monthlyCredits: 50000, unreadable: [] });
  });

  test("saving a standard plan resets an unreadable hidden custom value, so geo turns back on", async () => {
    const geo = service();
    await geo.setKey(admin, "ok-key");
    await sql`INSERT INTO settings.entries (key, value) VALUES ('geo.custom_rps', 'broken-ciphertext')`;
    expect((await readGeoConfig()).apiKey).toBe("");
    expect((await geo.status(admin)).budget.unreadable).toEqual(["customRps"]);
    const saved = await geo.saveBudget(admin, {
      plan: "free",
      customRps: null,
      customDailyCredits: null,
      monthlyCredits: 90000,
      personDailyCredits: 300,
    });
    expect(saved.budget).toMatchObject({ unreadable: [], customRps: 5 });
    expect((await readGeoConfig()).apiKey).toBe("ok-key");
    const [event] = await sql<{ metadata: { resets?: string[] } }[]>`
      SELECT metadata FROM audit.events WHERE action = 'core.geo.budget_changed' ORDER BY id DESC LIMIT 1`;
    expect(event?.metadata.resets).toEqual(["custom_rps"]);
    // A readable hidden value stays as it is.
    await geo.saveBudget(admin, { plan: "custom", customRps: 7, customDailyCredits: 4000, monthlyCredits: 90000, personDailyCredits: 300 });
    const kept = await geo.saveBudget(admin, {
      plan: "free",
      customRps: null,
      customDailyCredits: null,
      monthlyCredits: 90000,
      personDailyCredits: 300,
    });
    expect(kept.budget).toMatchObject({ plan: "free", customRps: 7, customDailyCredits: 4000, unreadable: [] });
  });

  test("an unreadable plan is reported and replaced by the next save", async () => {
    await sql`INSERT INTO settings.entries (key, value) VALUES ('geo.plan', 'broken-ciphertext')`;
    const geo = service();
    expect((await geo.status(admin)).budget.unreadable).toEqual(["plan"]);
    const saved = await geo.saveBudget(admin, {
      plan: "api25",
      customRps: 5,
      customDailyCredits: 3000,
      monthlyCredits: 90000,
      personDailyCredits: 300,
    });
    expect(saved.budget).toMatchObject({ plan: "api25", unreadable: [] });
  });

  test("usage reports this month, today against the plan allowance, shares and people at their limit", async () => {
    const geo = service();
    await geo.saveBudget(admin, { plan: "free", customRps: 5, customDailyCredits: 3000, monthlyCredits: 90000, personDailyCredits: 3 });
    const ledger = createGeoLedger(sql);
    const config = { ...geoTestConfig, monthlyCredits: 90000, personDailyCredits: 3 };
    const lea = { type: "user", userId: admin.id } as const;
    const agent = { type: "service_account", serviceAccountId: "33333333-3333-4333-8333-333333333333" } as const;
    for (let i = 0; i < 3; i++) await ledger.reserve(lea, config, 1000, "places", GEO_TEST_NOW);
    await ledger.reserve(agent, config, 1000, "address", GEO_TEST_NOW);
    await ledger.reserve(agent, config, 250, "tiles", GEO_TEST_NOW);
    // Yesterday counts for the month, not for today.
    await ledger.reserve(agent, config, 2000, "route", new Date(GEO_TEST_NOW.getTime() - 86400_000));
    const usage = await geo.usage(admin);
    expect(usage).toEqual({
      month: { period: "2026-10", used: 6.25, limit: 90000, resetsAt: "2026-10-31T23:00:00.000Z" },
      today: { period: "2026-10-20", used: 4.25, allowance: 3000, resetsAt: "2026-10-20T22:00:00.000Z" },
      shares: [
        { group: "tiles", credits: 0.25 },
        { group: "places", credits: 3 },
        { group: "route", credits: 2 },
        { group: "address", credits: 1 },
      ],
      peopleAtLimit: 1,
      timezone: "Europe/Berlin",
    });
  });

  test("every operation refuses a non-admin before reading or writing", async () => {
    const geo = service();
    const input = { plan: "free", customRps: 5, customDailyCredits: 3000, monthlyCredits: 9, personDailyCredits: 1 } as const;
    for (const run of [
      () => geo.status(person),
      () => geo.usage(person),
      () => geo.setKey(person, "ok-key"),
      () => geo.removeKey(person),
      () => geo.saveBudget(person, input),
    ])
      expect(((await run().catch((error: unknown) => error)) as { status: number }).status).toBe(403);
    expect(checked).toEqual([]);
    expect(await sql<{ key: string }[]>`SELECT key FROM settings.entries WHERE key LIKE 'geo.%'`).toHaveLength(0);
  });
});
