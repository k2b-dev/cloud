import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateLogging } from "../../../core/src/migrate/core/logging";
import type { AppEventEnvelope } from "../contracts/app-events";
import { sql } from "../runtime/clients";
import { freeipa } from "../server/services";
import * as freeIpaConfig from "../services/freeipa-config";
import { syncFromIpa } from "../services/ipa/sync";
import { create } from "../services/providers/local/users";
import * as settings from "../services/settings";
import { startAppEventDelivery } from "./app-event-delivery";
import { coreUserEventPublisher } from "./core-user-created";

let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;

beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("user_created_events");
  await migrateAuth();
  await migrateEvents();
  await migrateLogging();
  await sql`CREATE SCHEMA settings`.simple();
  await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY,value TEXT NOT NULL)`.simple();
}, 30000);
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});
const records = () => sql<{ payload: AppEventEnvelope }[]>`SELECT payload FROM events.outbox WHERE kind='event' ORDER BY seq`;
suiteFor("database")("Core user creation events", () => {
  test("importing creation services does not start or register a second Core publisher", async () => {
    expect(await startAppEventDelivery("core")).toBeNull();
    expect(coreUserEventPublisher()).toBe(coreUserEventPublisher());
  });
  test("local creation commits one thin event and a rejected duplicate emits none", async () => {
    const setting = spyOn(settings, "get").mockResolvedValue(8);
    try {
      const result = await create({ data: { email: "fixture@example.test" }, profile: "user", accountExpires: null });
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error(result.error);
      expect((await records()).map((row) => row.payload)).toMatchObject([
        {
          type: "core.user.created",
          version: 1,
          source: "core",
          subject: { type: "core.user", id: result.data.id },
          data: { userId: result.data.id, provider: "local" },
        },
      ]);
      expect(Object.keys((await records())[0]!.payload.data as object).sort()).toEqual(["provider", "userId"]);
      expect((await create({ data: { email: "fixture@example.test" }, profile: "user", accountExpires: null })).ok).toBe(false);
      expect(await records()).toHaveLength(1);
    } finally {
      setting.mockRestore();
    }
  });
  test("first FreeIPA import emits once; syncing an existing identity emits no created event", async () => {
    await sql`TRUNCATE events.outbox`;
    await sql`DELETE FROM auth.users`;
    const config = spyOn(freeIpaConfig, "getFreeIpaConfig").mockResolvedValue({
      enabled: true,
      configured: true,
      missingSettings: [],
      url: "ipa.example.test",
      serviceUser: "fixture",
      servicePassword: "fixture",
      groupsAdmin: [],
      groupsBaseSync: ["people"],
      groupsBaseIpaRealm: ["people"],
      groupsExcluded: [],
      caCert: "",
      allowInsecure: false,
      syncGuard: { maxUserChanges: 100, maxUserChangePercent: 100, maxGroupDeletions: 100, maxGroupDeletionPercent: 100 },
    });
    const setting = spyOn(settings, "get").mockResolvedValue(null);
    const session = spyOn(freeipa.session, "getServiceSession").mockResolvedValue("fixture-session");
    const remote = spyOn(freeipa.client, "call").mockImplementation(async (input) => ({
      id: 0,
      error: null,
      result: {
        count: 1,
        truncated: false,
        result:
          input.method === "user_find"
            ? [
                {
                  uid: ["eventfixture"],
                  uidnumber: ["100001"],
                  gidnumber: ["100001"],
                  homedirectory: ["/home/eventfixture"],
                  loginshell: ["/bin/bash"],
                  memberof_group: ["people"],
                },
              ]
            : [{ cn: ["people"], gidnumber: ["100002"], member_user: ["eventfixture"] }],
      },
    }));
    try {
      await syncFromIpa();
      const first = await records();
      expect(first).toHaveLength(1);
      expect(first[0]!.payload).toMatchObject({ type: "core.user.created", data: { provider: "ipa" } });
      const [user] = await sql`SELECT id FROM auth.users WHERE uid='eventfixture'`;
      expect(first[0]!.payload.subject.id).toBe(user!.id);
      expect(await sql`SELECT FROM auth.user_posix WHERE user_id=${user!.id}::uuid`).toHaveLength(1);
      await syncFromIpa();
      expect(await records()).toHaveLength(1);
    } finally {
      remote.mockRestore();
      session.mockRestore();
      setting.mockRestore();
      config.mockRestore();
    }
  });
});
