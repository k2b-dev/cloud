import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { startNotificationDefinitionRegistration } from "./catalog";

databaseSuite()("notification catalog schema recovery with Bun SQL", () => {
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
