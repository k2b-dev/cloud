import { expect, test } from "bun:test";
import { Hono } from "hono";
import { authorizeOAuthRequest } from "./identity-oauth-issuance";

test("accepted legacy OAuth secret use is recorded before continuing; rejected credentials never count", async () => {
  const seen: string[] = [];
  const routes = new Hono().post("/oauth", async (c) => {
    const denied = await authorizeOAuthRequest(
      c,
      (token) => token === "legacy-secret",
      async (path) => {
        seen.push(path);
      },
    );
    return denied ?? c.body(null, 204);
  });
  expect((await routes.request("/oauth", { method: "POST", headers: { authorization: "Bearer bad" } })).status).toBe(401);
  expect(seen).toEqual([]);
  expect((await routes.request("/oauth", { method: "POST", headers: { authorization: "Bearer legacy-secret" } })).status).toBe(204);
  expect(seen).toEqual(["broker-secret"]);
});
