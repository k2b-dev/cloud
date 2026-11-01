import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import type { CapabilityDispatchParams } from "./capabilities";
import { type CodeAccessRouteDependencies, codeAccountOwner, createCodeAccessRoutes } from "./code-access-routes";

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

const manifest = compileCapabilities(
  "mail",
  defineCapabilities({
    protocolVersion: 2,
    types: { mailbox: { title: "Mailbox", description: "A mailbox.", reader: "mailbox.get" } },
    queries: {
      "mailbox.get": {
        title: "Read mailbox",
        description: "Read one mailbox.",
        input: z.object({ id: z.string().describe("Mailbox ID.") }).strict(),
        data: z.unknown(),
        openWorld: false,
        run: async () => ok({ data: {} }),
      },
    },
  }),
).manifest;
const mail: CapabilityRegistryEntry = {
  appId: "mail",
  appName: "Mail",
  appIcon: "ti ti-mail",
  appAccent: "#0f766e",
  appDescription: "Mail",
  endpoint: "http://mail/api/_internal/capabilities/v1",
  manifest,
};
const ids = {
  mailbox: "22222222-2222-4222-8222-222222222222",
  hidden: "33333333-3333-4333-8333-333333333333",
  app: "44444444-4444-4444-8444-444444444444",
  agent: "55555555-5555-4555-8555-555555555555",
};
const view = (title: string) => ({ data: { view: { title, permission: "read" } } });
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const routes = (dependencies: CodeAccessRouteDependencies) =>
  new Hono().route("/api/resources/code-access", createCodeAccessRoutes(dependencies));

describe("Code account owners", () => {
  test("come from the documented account name", () => {
    expect(codeAccountOwner("code:mail.mailbox:mb_4kd2")).toEqual({ kind: "resource", ref: { type: "mail.mailbox", id: "mb_4kd2" } });
    expect(codeAccountOwner("code:grids.base:a:b")).toEqual({ kind: "resource", ref: { type: "grids.base", id: "a:b" } });
    expect(codeAccountOwner("code:app:hr")).toEqual({ kind: "app", appId: "hr" });
    for (const name of ["agent-1", "code:", "code:mail.mailbox:", "code:app:Bad", "code:nodot:id"])
      expect(codeAccountOwner(name)).toBeNull();
  });
});

describe("POST /api/resources/code-access/accounts", () => {
  test("reads each owner's title live under the person's authority and hides what the person cannot read", async () => {
    const calls: CapabilityDispatchParams[] = [];
    const response = await routes({
      accounts: async (requested) =>
        [
          { id: ids.mailbox, name: "code:mail.mailbox:mb_info" },
          { id: ids.hidden, name: "code:mail.mailbox:mb_private" },
          { id: ids.app, name: "code:app:mail" },
        ].filter((row) => requested.includes(row.id)),
      getCapability: async (appId) => (appId === "mail" ? mail : null),
      appUsable: async (appId, authority) => {
        expect(authority.accessSubject).toEqual({ type: "user", userId: user.id });
        return appId === "mail";
      },
      dispatch: async (params) => {
        calls.push(params);
        return params.input && (params.input as { id: string }).id === "mb_info"
          ? Response.json(view("info@moebel-beispiel.de"))
          : Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404 });
      },
    }).request("/api/resources/code-access/accounts", post({ ids: [ids.mailbox, ids.hidden, ids.app, ids.agent, ids.mailbox] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      items: [
        { id: ids.mailbox, ownerTitle: "info@moebel-beispiel.de", appId: "mail", icon: "ti ti-mail", accent: "#0f766e" },
        // An owner the person cannot read looks exactly like an unknown account.
        { id: ids.hidden, ownerTitle: null, appId: null, icon: null, accent: null },
        { id: ids.app, ownerTitle: "Mail", appId: "mail", icon: "ti ti-mail", accent: "#0f766e" },
        // Not a Code account: the same shape as an owner the person cannot read.
        { id: ids.agent, ownerTitle: null, appId: null, icon: null, accent: null },
      ],
    });
    expect(calls.map((call) => [call.appId, call.kind, call.capabilityId, call.input])).toEqual([
      ["mail", "queries", "mailbox.get", { id: "mb_info" }],
      ["mail", "queries", "mailbox.get", { id: "mb_private" }],
    ]);
    for (const call of calls) expect(call.authority?.accessSubject).toEqual({ type: "user", userId: user.id });
  });

  test("names an application that owns Code only to people who may use it", async () => {
    const response = await routes({
      accounts: async () => [{ id: ids.app, name: "code:app:mail" }],
      getCapability: async () => mail,
      appUsable: async () => false,
    }).request("/api/resources/code-access/accounts", post({ ids: [ids.app] }));
    expect(await response.json()).toEqual({ items: [{ id: ids.app, ownerTitle: null, appId: null, icon: null, accent: null }] });
  });

  test("refuses lists that are empty, too long or not account IDs", async () => {
    const app = routes({ accounts: async () => [] });
    for (const body of [
      { ids: [] },
      { ids: ["x"] },
      { ids: Array.from({ length: 501 }, () => ids.agent) },
      { ids: [ids.agent], extra: 1 },
    ]) {
      expect((await app.request("/api/resources/code-access/accounts", post(body))).status).toBe(400);
    }
  });
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
      accounts: async () => [],
      invoke: async () => {
        invoked = true;
        return Response.json({ data: { removed: true } });
      },
    });
    const body = JSON.stringify({ appId: "spaces", grantId });
    for (const path of ["remove", "accounts"]) {
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
