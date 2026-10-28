import { expect, test } from "bun:test";
import { sql } from "bun";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("venue resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/public/"));
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Venue calendar credential creation", () => {
  test("read OAuth cannot create a subscription credential through GET", () =>
    withAdminOAuth(
      async ({ userId, readHeaders, writeHeaders, sessionHeaders }) => {
        const read = await routes.request("/calendar/my", { headers: readHeaders });
        expect(read.status).toBe(403);
        expect(await sql`SELECT token FROM venue.user_ical_tokens WHERE user_id=${userId}::uuid`).toHaveLength(0);
        for (const headers of [writeHeaders, sessionHeaders]) expect((await routes.request("/calendar/my", { headers })).status).toBe(200);
      },
      { admin: false },
    ));
});
