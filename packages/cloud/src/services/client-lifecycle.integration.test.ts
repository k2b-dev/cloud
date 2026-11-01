import { afterAll, beforeAll, expect, test } from "bun:test";
import { initializeTestPlatform, suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateGeoIp } from "../../../core/src/migrate/core/geoip";
import { migrate as migrateConsent } from "../../../core/src/migrate/core/panel-context-consent";
import { migratePosix } from "../../../core/src/migrate/core/posix";
import { migrate as migratePreferences } from "../../../core/src/migrate/core/rail-preferences";
import { migrate as migrateShortcuts } from "../../../core/src/migrate/core/rail-shortcuts";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { sql } from "../runtime/clients";
import { accountIdentities } from "./accounts/identities";
import { appApproval } from "./app-approval";
import { createGeoLedger } from "./geo/ledger";
import { migrate as migrateGeo } from "./geo/migrate";
import { geoIpUploads } from "./geoip/store";
import { panelContextConsent } from "./panel-context-consent";
import { railPreferences } from "./rail-preferences";
import { railShortcuts } from "./rail-shortcuts";
import { buildProjectedUser } from "./session/user";
import { encryptValue } from "./settings/crypto";

const userId = "11111111-1111-4111-8111-111111111111";
const admin = buildProjectedUser({ id: userId, provider: "local", profile: "user", effective_admin: true });
const ledger = createGeoLedger();
const geoBudget = { timezone: "UTC", monthlyCredits: 1, personDailyCredits: 1 };
const now = new Date("2026-10-20T12:00:00.000Z");
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("client_lifecycle");
  await migrateAuth();
  await migratePosix(sql);
  await migrateGeoIp(sql);
  await migratePreferences(sql);
  await migrateShortcuts(sql);
  await migrateConsent(sql);
  await migrateGeo(sql);
  await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
  await sql`CREATE TABLE IF NOT EXISTS settings.entries (key text PRIMARY KEY, value text NOT NULL)`.simple();
  for (const [key, value] of [
    ["app.url", "https://cloud.example.test"],
    ["user.app_approval.enabled", true],
    ["user.app_approval.origin", "https://device.example.test"],
  ] as const) {
    await sql`INSERT INTO settings.entries (key, value) VALUES (${key}, ${await encryptValue(value)})`;
  }
}, 30_000);
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});

suiteFor("database")("default service client lifecycle", () => {
  test("imported singletons follow the selected target and replacement clients", async () => {
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await initializeTestPlatform();
      expect(await geoIpUploads.versions()).toEqual({});
      expect(await railPreferences.get(userId)).toEqual(defaultRailPreferences());
      expect((await railShortcuts.list(admin)).entries).toEqual([]);
      expect(await panelContextConsent.get(userId, "fixture")).toBeNull();
      expect((await accountIdentities.provisioningUsers({})).items).toEqual([]);
      expect(await appApproval.info()).toMatchObject({ issuer: "https://cloud.example.test", appOrigin: "https://device.example.test" });
      const subject = { type: "user", userId } as const;
      const reservation = await ledger.reserve(subject, geoBudget, 250, "tiles", now);
      await ledger.settle(reservation, 0);
      expect(await ledger.availability(subject, geoBudget, now)).toMatchObject({
        cloud: { exhausted: false },
        person: { exhausted: false },
      });
    }
  });
});
