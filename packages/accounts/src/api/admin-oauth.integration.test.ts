import { expect, spyOn, test } from "bun:test";
import { providers } from "@k2b/cloud/services";
import { z } from "zod";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("accounts administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/widget") && path !== "/action-notice");
    }));
  test("login-token issuance requires write/admin OAuth or an administrator browser session", () =>
    withAdminOAuth(async ({ userId, readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
      const issue = spyOn(providers.local.auth, "createAccountLoginToken");
      try {
        const response = await routes.request(`/users/${userId}/login-token`, { method: "POST", headers: readHeaders });
        expect(response.status).toBe(403);
        expect(issue).not.toHaveBeenCalled();
        for (const headers of [writeHeaders, adminHeaders, sessionHeaders]) {
          const response = await routes.request(`/users/${userId}/login-token`, { method: "POST", headers });
          expect(response.status).toBe(200);
          const { token } = z.object({ token: z.string() }).parse(await response.json());
          expect(await providers.local.auth.consumeMagicLinkToken(token)).toEqual({ userId });
        }
      } finally {
        issue.mockRestore();
      }
    }));
});
