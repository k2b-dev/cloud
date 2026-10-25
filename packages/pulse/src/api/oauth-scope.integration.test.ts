import { afterAll, beforeAll, test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { settingsFixture } from "../store/settings.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("pulse resource OAuth ceiling", () => {
  let fixture: ReturnType<typeof settingsFixture>;
  beforeAll(() => {
    fixture = settingsFixture();
    fixture.values["pulse.clickhouse_connection"] = JSON.stringify({ url: "http://127.0.0.1:1", user: "fixture", password: "fixture" });
  });
  afterAll(() => fixture?.restore());
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/admin/") && path !== "/ingest");
    }));
});
