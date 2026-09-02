import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import type { Mandate } from "../services/mandates";
import { createMeMandateRoutes } from "./me";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MANDATE_ID = "22222222-2222-4222-8222-222222222222";
const user = { id: USER_ID } as AuthContext["Variables"]["user"];
const actor = { kind: "user" as const, user };

const authenticate =
  (credentialKind: "session" | "api_key"): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("user", user);
    c.set("actor", actor);
    c.set("credentialKind", credentialKind);
    await next();
  };

const mandate: Mandate = {
  id: MANDATE_ID,
  subject: { type: "user", id: USER_ID },
  ownerAppId: "inventory",
  workloadType: "scheduled-report",
  workloadId: "report-1",
  policy: { version: 1, apps: ["mail"], operations: ["capability.query:message.read"], actions: "deny" },
  state: "active",
  revision: 1,
  expiresAt: null,
  confirmedAt: null,
  confirmationDeadline: "2026-09-02T12:15:00.000Z",
  createdByUserId: USER_ID,
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
  revokedAt: null,
  revokedByUserId: null,
  revokedByAppId: null,
  revokeReason: null,
};

describe("self-service mandates", () => {
  test("creates only a pending mandate for the current session user", async () => {
    const calls: unknown[] = [];
    const routes = createMeMandateRoutes(
      {
        createPending: async (input) => {
          calls.push(input);
          return ok(mandate);
        },
        list: async () => ({ items: [], page: 1, perPage: 50, total: 0, hasNext: false }),
      },
      authenticate("session"),
    );
    const response = await routes.request("/mandates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerAppId: "inventory",
        workloadType: "scheduled-report",
        workloadId: "report-1",
        policy: { version: 1, apps: ["mail"], operations: ["capability.query:message.read"], actions: "deny" },
      }),
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        authority: { kind: "interactive", userId: USER_ID },
        subject: { type: "user", id: USER_ID },
        ownerAppId: "inventory",
        workloadType: "scheduled-report",
        workloadId: "report-1",
        policy: { version: 1, apps: ["mail"], operations: ["capability.query:message.read"], actions: "deny" },
      },
    ]);
    expect(await response.json()).toMatchObject({ id: MANDATE_ID, confirmedAt: null, revision: 1 });
  });

  test("rejects API keys and caller-supplied subject fields", async () => {
    let created = false;
    const service = {
      createPending: async () => {
        created = true;
        return ok(mandate);
      },
      list: async () => ({ items: [], page: 1, perPage: 50, total: 0, hasNext: false }),
    };
    const input = {
      ownerAppId: "inventory",
      workloadType: "scheduled-report",
      workloadId: "report-1",
      policy: { version: 1, apps: ["mail"], operations: ["capability.query:message.read"], actions: "deny" },
    };
    expect(
      (
        await createMeMandateRoutes(service, authenticate("api_key")).request("/mandates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await createMeMandateRoutes(service, authenticate("session")).request("/mandates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, subject: { type: "user", id: crypto.randomUUID() } }),
        })
      ).status,
    ).toBe(400);
    expect(created).toBeFalse();
  });

  test("lists only the current user's mandates with bounded pagination", async () => {
    const calls: unknown[] = [];
    const routes = createMeMandateRoutes(
      {
        createPending: async () => ok(mandate),
        list: async (input) => {
          calls.push(input);
          return { items: [mandate], page: 2, perPage: 100, total: 1, hasNext: false };
        },
      },
      authenticate("session"),
    );
    const response = await routes.request("/mandates?page=2&perPage=100&state=active");
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        scope: { kind: "user", userId: USER_ID },
        pagination: { page: 2, perPage: 100 },
        filter: { state: "active" },
      },
    ]);
    expect((await routes.request("/mandates?perPage=101")).status).toBe(400);
  });
});
