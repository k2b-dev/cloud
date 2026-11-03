import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { type CodeAccessRouteDependencies, createCodeAccessRoutes } from "./code-access-routes";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user" });
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  spies.push(spyOn(session, "getToken").mockReturnValue("fixture"));
  spies.push(
    spyOn(session, "authenticateRequest").mockImplementation(async () => ({
      user,
      data: { userId: user.id, sid: "fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    })),
  );
  spies.push(spyOn(session, "appSessionFallback").mockReturnValue(null));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const ids = {
  mailbox: "22222222-2222-4222-8222-222222222222",
  hidden: "33333333-3333-4333-8333-333333333333",
  app: "44444444-4444-4444-8444-444444444444",
  agent: "55555555-5555-4555-8555-555555555555",
};
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const routes = (dependencies: CodeAccessRouteDependencies) =>
  new Hono().route("/api/resources/code-access", createCodeAccessRoutes(dependencies));

test("the arbitrary-account name route no longer exists", async () => {
  const response = await routes({}).request("/api/resources/code-access/accounts", post({ ids: [ids.mailbox] }));
  expect(response.status).toBe(404);
});

describe("POST /api/resources/code-access/remove", () => {
  const grantId = "66666666-6666-4666-8666-666666666666";

  test("admits exactly the target's code.access.rm with the grant", async () => {
    const invoked: unknown[] = [];
    const response = await routes({
      invoke: async (params) => {
        invoked.push({ appId: params.appId, operation: params.operation, input: params.input, subject: params.authority.accessSubject });
        return Response.json({ data: { removed: true }, receipt: { text: "Removed" } });
      },
    }).request("/api/resources/code-access/remove", post({ appId: "spaces", grantId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(invoked).toEqual([{ appId: "spaces", operation: "rm", input: { grantId }, subject: { type: "user", userId: user.id } }]);
  });

  test("passes the target's refusal through and never trusts a malformed result", async () => {
    const forbidden = await routes({
      invoke: async () => Response.json({ code: "FORBIDDEN", message: "Target manager authority required" }, { status: 403 }),
    }).request("/api/resources/code-access/remove", post({ appId: "spaces", grantId }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ code: "FORBIDDEN", message: "Target manager authority required" });
    const notRemoved = await routes({ invoke: async () => Response.json({ data: { removed: false } }) }).request(
      "/api/resources/code-access/remove",
      post({ appId: "spaces", grantId }),
    );
    expect(await notRemoved.json()).toEqual({ removed: false });
    const malformed = await routes({ invoke: async () => Response.json({ data: { removed: "yes" } }) }).request(
      "/api/resources/code-access/remove",
      post({ appId: "spaces", grantId }),
    );
    expect(malformed.status).toBe(502);
  });

  test("refuses requests a page on another site could send with the person's cookie", async () => {
    let invoked = false;
    const app = routes({
      invoke: async () => {
        invoked = true;
        return Response.json({ data: { removed: true } });
      },
    });
    const body = JSON.stringify({ appId: "spaces", grantId });
    for (const path of ["remove"]) {
      const refused: Record<string, string>[] = [
        { "content-type": "text/plain" },
        {},
        { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        { "content-type": "application/json", "sec-fetch-site": "same-site" },
      ];
      for (const headers of refused) {
        const response = await app.request(`/api/resources/code-access/${path}`, { method: "POST", headers, body });
        expect(response.status).toBe(403);
      }
    }
    expect(invoked).toBe(false);
    const sameOrigin = await app.request("/api/resources/code-access/remove", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" },
      body,
    });
    expect(sameOrigin.status).toBe(200);
  });

  test("refuses anything but one app and one grant", async () => {
    let invoked = false;
    const app = routes({
      invoke: async () => {
        invoked = true;
        return Response.json({ data: { removed: true } });
      },
    });
    for (const body of [
      { grantId },
      { appId: "spaces" },
      { appId: "Spaces", grantId },
      { appId: "spaces", grantId: "x" },
      { appId: "spaces", grantId, principal: grantId },
    ]) {
      expect((await app.request("/api/resources/code-access/remove", post(body))).status).toBe(400);
    }
    expect(invoked).toBe(false);
  });
});
