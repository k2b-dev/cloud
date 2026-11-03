import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { person } from "../packages/cloud/src/_internal/define-app.test-fixture";
import { requireAppAccess } from "../packages/cloud/src/server/middleware/app-access";
import type { AuthContext, RequestAuthority } from "../packages/cloud/src/server/middleware/auth";
import * as authentication from "../packages/cloud/src/server/middleware/auth";
import { usableAppIds } from "../packages/cloud/src/services/app-access";
import * as metrics from "../packages/cloud/src/services/app-access-metrics";
import { app as contacts } from "../packages/contacts/src/config";
import { app as grids } from "../packages/grids/src/config";
import { app as mail } from "../packages/mail/src/config";
import { app as pulse } from "../packages/pulse/src/config";
import { app as spaces } from "../packages/spaces/src/config";
import { app as venue } from "../packages/venue/src/config";
import { useUnitClients } from "../scripts/fixtures/unit-clients";

useUnitClients();
const apps = [spaces, grids, contacts, mail, pulse, venue];
const full: RequestAuthority = {
  actor: { kind: "user", user: person },
  accessSubject: { type: "user", userId: person.id },
  credentialKind: "session",
  scopes: [],
};
const guestUser = { ...person, profile: "guest", roles: ["guest"] } satisfies typeof person;
const guest: RequestAuthority = { ...full, actor: { kind: "user", user: guestUser } };
const service = (appId: string, kind: "resource_bound" | "standalone" | "user_delegated" = "resource_bound"): RequestAuthority => ({
  actor: {
    kind: "service_account",
    delegatedUser: kind === "user_delegated" ? guestUser : null,
    scopes: ["read"],
    serviceAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Object reader",
      kind,
      status: "active",
      delegatedUserId: kind === "user_delegated" ? person.id : null,
      appId: kind === "resource_bound" ? appId : null,
      resourceType: kind === "resource_bound" ? "fixture" : null,
      resourceId: kind === "resource_bound" ? "Object" : null,
      createdBy: null,
      createdAt: "2026-11-03T12:00:00Z",
    },
  },
  accessSubject:
    kind === "user_delegated"
      ? { type: "user", userId: person.id }
      : { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
  credentialKind: "api_key",
  scopes: ["read"],
});
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  setSystemTime(new Date("2026-11-03T12:00:00Z"));
  spies.push(spyOn(metrics, "recordAppAccessDenied").mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setSystemTime();
});
const authenticate = (current: () => RequestAuthority | null) => {
  spies.push(
    spyOn(authentication, "loadAuthenticatedActor").mockImplementation(async (c) => {
      const value = current();
      if (value) {
        c.set("actor", value.actor);
        c.set("accessSubject", value.accessSubject);
        c.set("credentialKind", value.credentialKind);
        c.set("credentialScopes", value.scopes);
      }
      return { token: null, user: null, actor: value?.actor ?? null };
    }),
  );
};

describe("six built-in app declarations exclude guests at the shared gate", () => {
  for (const app of apps) {
    test(`${app.meta.id}: API and framework surfaces deny guests before handlers and admit full accounts and machine keys`, async () => {
      expect(app.meta.access?.kind).toBe("noGuests");
      let current = guest;
      authenticate(() => current);
      let calls = 0;
      const router = new Hono<AuthContext>()
        .use(requireAppAccess(app.meta, async () => new Response("denied", { status: 403 })))
        .all("*", (c) => {
          calls++;
          return c.text("app handler");
        });
      const paths = [`/api/${app.meta.id}/Object`, `/cli/plugins/${app.meta.id}/module.js`, `/app/${app.meta.id}`];
      for (const denied of [guest, service(app.meta.id, "user_delegated")]) {
        current = denied;
        for (const path of paths) {
          const response = await router.request(path);
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ code: "app_access_denied", app: app.meta.id });
        }
      }
      expect(calls).toBe(0);
      for (const allowed of [full, service(app.meta.id), service(app.meta.id, "standalone")]) {
        current = allowed;
        expect((await router.request(paths[0]!)).status).toBe(200);
      }
      expect(calls).toBe(3);
    });

    test(`${app.meta.id}: every declared public pattern still reaches route authentication without an ordinary identity`, async () => {
      authenticate(() => {
        throw new Error("The public path must bypass ordinary app authentication");
      });
      const router = new Hono<AuthContext>()
        .use(requireAppAccess(app.meta, async () => new Response("denied", { status: 403 })))
        .all("*", (c) => c.json({ code: "route_authentication_required" }, 401));
      for (const pattern of app.meta.access?.publicRoutes ?? []) {
        const path = pattern.replace(/:[A-Za-z]+/g, "Object").replace("*", "records");
        const response = await router.request(path);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: "route_authentication_required" });
      }
    });
  }

  test("shared discovery excludes guests and delegated guests from capabilities, widgets, search and CLI", async () => {
    const metas = apps.map((app) => app.meta);
    expect(await usableAppIds(guest, metas)).toEqual(new Set());
    expect(await usableAppIds(service("spaces", "user_delegated"), metas)).toEqual(new Set());
    expect(await usableAppIds(full, metas)).toEqual(new Set(metas.map((app) => app.id)));
  });
});
