import { expect, test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import verifyRoutes from "../verify";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("proxy-auth administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders);
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Proxy authentication credential ceiling", () => {
  test("read OAuth cannot obtain unrestricted forwarded identity through GET", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      const response = await verifyRoutes.request("/verify/example", { headers: readHeaders });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    }));
});
