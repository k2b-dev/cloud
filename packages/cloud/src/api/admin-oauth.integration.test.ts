import { expect, test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import * as settings from "../services/settings";
import { registerSettings } from "../services/settings/defaults";
import { createCoreApiRouter } from "./index";

const unexpectedNotification = async (): Promise<never> => {
  throw new Error("Unexpected notification");
};
const { api: routes } = createCoreApiRouter({
  notifications: {
    sendNewBrowserSignIn: unexpectedNotification,
    sendMagicLink: unexpectedNotification,
    sendIpaLoginHint: unexpectedNotification,
    sendPasswordReset: unexpectedNotification,
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Core administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => path.startsWith("/admin/"));
    }));
  test("the ALL-mounted Sync proxy retains its stricter admin-only OAuth scope", () =>
    withAdminOAuth(async ({ readHeaders, writeHeaders }) => {
      // ALL registrations also include middleware, so concrete proxy requests
      // supplement the explicit mutation-route enumeration above.
      for (const headers of [readHeaders, writeHeaders]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const response = await routes.request("/admin/sync/core/schedules/example/run-now", { method, headers });
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
        }
      }
    }));
  test("settings remain unchanged on rejection; write/admin OAuth and browser sessions can save", () =>
    withAdminOAuth(async ({ readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
      const key = `test.admin_scope_${crypto.randomUUID().replaceAll("-", "")}`;
      registerSettings([{ key, kind: "string", default: "before", description: "Test only", label: "Scope test", group: "test" }]);
      const save = (headers: Record<string, string>, value: string) =>
        routes.request("/admin/core/settings", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ updates: { [key]: value } }),
        });
      try {
        for (const [index, headers] of [writeHeaders, adminHeaders, sessionHeaders].entries()) {
          const before = await settings.get<string>(key);
          expect((await save(readHeaders, "forbidden")).status).toBe(403);
          expect(await settings.get<string>(key)).toBe(before);
          expect((await save(headers, `saved-${index}`)).status).toBe(204);
          expect(await settings.get<string>(key)).toBe(`saved-${index}`);
        }
      } finally {
        await settings.remove(key);
      }
    }));
});
