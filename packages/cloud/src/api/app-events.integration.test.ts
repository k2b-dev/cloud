import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "../../../core/src/migrate/core/app-events";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { compileCapabilities } from "../_internal/capabilities";
import type { AppEventEnvelope } from "../contracts/app-events";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { LocalUserSchema } from "../contracts/shared";
import { sql } from "../runtime/clients";
import type { AuthContext } from "../server";
import { createAppEventBroker } from "../services/app-events";
import { createAppEventRoutes } from "./app-events";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const schema = z.strictObject({
  id: z.uuid(),
  label: z.string().max(40).optional(),
  items: z.array(z.string().max(10)).max(20).optional(),
});
const compiled = compileCapabilities("producer", {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "An item." } },
  events: { changed: { title: "Changed", description: "An item changed.", subject: "item", schema, version: 1 } },
});
const entry: CapabilityRegistryEntry = {
  appId: "producer",
  appName: "Producer",
  appDescription: "Fixture producer.",
  appIcon: "box",
  endpoint: "http://producer.test",
  manifest: compiled.manifest,
};
const broker = createAppEventBroker({ registry: async () => [entry], deadLetters: async () => [], streams: async function* () {} });
const authenticate: MiddlewareHandler<AuthContext> = async (context, next) => {
  const user = LocalUserSchema.parse({
    id: id(100),
    uid: "operator",
    provider: "local",
    roles: ["admin"],
    profile: "user",
    givenname: "Test",
    sn: "Operator",
    displayName: "Test Operator",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  context.set("actor", { kind: "user", user });
  context.set("accessSubject", { type: "user", userId: user.id });
  context.set("credentialKind", "session");
  await next();
};
const routes = createAppEventRoutes(authenticate, broker);
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("app_event_api");
  await migrateEvents();
  await migrateAppEvents();
  await migrateAudit();
});
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});
suiteFor("database")("app events administration API", () => {
  beforeEach(async () => {
    await sql`TRUNCATE events.app_deliveries, events.app_subscriptions, events.app_events RESTART IDENTITY CASCADE`.simple();
    await sql`UPDATE events.app_broker_status SET last_sequence=0, state='ready', gap_from=NULL, gap_to=NULL,unseen_sequences='{}'::int8multirange`;
    await sql`DELETE FROM audit.events WHERE action LIKE 'app_events.%'`;
  });
  test("record samples recent events once per distinct value-free shape with stable, distinct fixture IDs", async () => {
    const emit = async (number: number, data: unknown) => {
      const envelope: AppEventEnvelope = {
        id: id(number),
        type: "producer.changed",
        source: "producer",
        version: 1,
        time: "2000-01-01T00:00:00.000Z",
        subject: { type: "producer.item", id: id(101) },
        data,
      };
      await broker.accept(envelope, number);
    };
    await emit(1, { id: id(51) });
    await emit(2, { id: id(52), label: "private-label" });
    await emit(3, { id: id(53), items: ["secret-a", "secret-b"] });
    await emit(4, { id: id(54), items: ["secret-c", "secret-d", "secret-e", "secret-f"] });
    const response = await routes.request("/record/producer.changed?shapeOnly=true&limit=4");
    expect(response.status).toBe(200);
    const text = await response.text();
    const fixtures = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(fixtures).toHaveLength(3);
    expect(new Set(fixtures.map(({ id }) => id)).size).toBe(3);
    for (const fixture of fixtures) expect(schema.safeParse(fixture.data).success).toBe(true);
    expect(text).not.toContain("private-label");
    expect(text).not.toContain("secret-");
    expect(await (await routes.request("/record/producer.changed?shapeOnly=true&limit=4")).text()).toBe(text);
    const limited = await (await routes.request("/record/producer.changed?shapeOnly=true&limit=2")).text();
    expect(limited.trim().split("\n")).toHaveLength(1);
  });
  test("status exposes rejected-event metadata and no payload through the admin API", async () => {
    await broker.reconcileSubscriptions();
    await broker.accept(
      {
        id: id(90),
        type: "producer.changed",
        source: "producer",
        version: 1,
        time: "2000-01-01T00:00:00.000Z",
        subject: { type: "producer.item", id: id(101) },
        data: { id: "private-invalid-payload" },
      },
      90,
    );
    const response = await routes.request("/status");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      rejectedCount: 1,
      rejectionLimit: 10,
      rejections: [{ type: "producer.changed", source: "producer", code: "schema_mismatch", time: expect.any(String) }],
    });
    expect(JSON.stringify(result)).not.toContain("private-invalid-payload");
    expect(Object.keys(result.rejections[0]).sort()).toEqual(["code", "source", "time", "type"]);
  });
  test("administrator acknowledgement resets a persisted gap and audits the administrator", async () => {
    await sql`UPDATE events.app_broker_status SET state='gap_detected',code='reconcile_required',gap_from=1,gap_to=3`;
    const response = await routes.request("/status/acknowledge", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "ready", lastSequence: "3" });
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.gap.acknowledge'`).toHaveLength(1);
    expect((await routes.request("/status/acknowledge", { method: "POST" })).status).toBe(409);
  });
});
