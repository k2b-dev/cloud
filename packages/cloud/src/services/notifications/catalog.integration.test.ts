import { expect, test } from "bun:test";
import { z } from "zod";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/notifications";
import { bindNotificationDefinitions, notification } from "../../contracts/notification-types";
import { sql } from "../../runtime/clients";
import { registerNotificationDefinitions, startNotificationDefinitionRegistration } from "./catalog";

databaseSuite()("notification catalog schema recovery with Bun SQL", () => {
  test("idempotently persists excluded channels and localized reasons and clears removed exclusions", async () => {
    await migrate();
    await migrate();
    const appId = `excluded-${crypto.randomUUID()}`;
    const input = {
      recipient: "user" as const,
      label: "Updates",
      description: "Status updates.",
      data: z.object({}),
      render: () => ({ title: "Update" }),
    };
    const definitions = bindNotificationDefinitions(appId, {
      update: notification({
        ...input,
        delivery: { recommended: ["browser"], excluded: ["email"] },
        excludedReason: "Too frequent.",
        presentation: { baseLocale: "en", translations: { de: { excludedReason: "Zu häufig." } } },
      }),
    });
    try {
      await registerNotificationDefinitions(appId, definitions);
      await registerNotificationDefinitions(appId, definitions);
      const [stored] =
        await sql`SELECT excluded_channels, excluded_reason, presentation FROM notifications.definitions WHERE app_id = ${appId}`;
      expect(stored).toMatchObject({
        excluded_channels: ["email"],
        excluded_reason: "Too frequent.",
        presentation: { baseLocale: "en", translations: { de: { excludedReason: "Zu häufig." } } },
      });
      await registerNotificationDefinitions(appId, bindNotificationDefinitions(appId, { update: notification(input) }));
      const [cleared] = await sql`SELECT excluded_channels, excluded_reason FROM notifications.definitions WHERE app_id = ${appId}`;
      expect(cleared).toEqual({ excluded_channels: [], excluded_reason: null });
    } finally {
      await sql`DELETE FROM notifications.definitions WHERE app_id = ${appId}`;
    }
  });

  for (const [sqlState, query] of [
    ["42P01", () => sql`SELECT * FROM pg_catalog.notification_catalog_missing_relation_test`],
    ["42703", () => sql`SELECT notification_catalog_missing_column FROM pg_catalog.pg_class`],
  ] as const) {
    test(`defers registration for the actual driver error ${sqlState}`, async () => {
      let attempts = 0;
      const registered = Promise.withResolvers<void>();
      const stop = await startNotificationDefinitionRegistration(
        "rollout-test",
        {},
        {
          retryMs: 1,
          register: async () => {
            attempts += 1;
            if (attempts === 1) {
              try {
                await query();
              } catch (error) {
                expect(error).toMatchObject({ code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState });
                throw error;
              }
              throw new Error("The missing schema object unexpectedly exists");
            }
            registered.resolve();
          },
        },
      );

      try {
        await registered.promise;
        expect(attempts).toBe(2);
      } finally {
        stop();
      }
    });
  }
});
