import { expect, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { resolveAppPresentation } from "@k2b/cloud/shared";
import { visiblePanelProviders } from "@k2b/cloud/ssr/app-navigation";
import { Hono } from "hono";
import { app } from "./config";

/** Invented signed-in person. */
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  roles: ["user", "local"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

test("Core offers its Help as a panel inside its own routes to every signed-in reader, in their language", () => {
  const meta = app.meta;
  expect(meta.panel).toEqual({ href: "/panel", label: "Help", icon: "ti ti-help-circle" });
  expect(meta.routes).toContain("/");
  expect(meta.routes).toContain("/_cloud/app-access");
  expect(resolveAppPresentation(meta, "de").panel?.label).toBe("Hilfe");
  expect(visiblePanelProviders([meta], undefined, "en")).toEqual([]);
  expect(visiblePanelProviders([meta], person, "en").map((provider) => provider.label)).toEqual(["Help"]);
  expect(visiblePanelProviders([meta], { ...person, profile: "guest", roles: [] }, "de").map((provider) => provider.label)).toEqual([
    "Hilfe",
  ]);
});

test("country requests reach their own app-proof authentication without a Core browser session", async () => {
  const path = "/api/_internal/ip-country";
  expect(app.meta.routes).toContain(path);
  const router = new Hono()
    .use(requireAppAccess(app.meta, async (c) => c.text("Core access denied", 403)))
    .post(path, (c) => c.text("route-owned authentication"));
  const response = await router.request(path, { method: "POST", headers: { Authorization: "Bearer app.proof.signature" } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("route-owned authentication");
});

test("a browser visitor without a session reaches a public Code page; app access does not send them to sign-in first", async () => {
  const path = "/code/c_survey/answer";
  const router = new Hono()
    .use(requireAppAccess(app.meta, async (c) => c.text("Core access denied", 403)))
    .get("/code/:codeId/*", (c) => c.text("route-owned authentication"));
  const response = await router.request(path, { headers: { Accept: "text/html" } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("route-owned authentication");
});

test("the label card of a public Code page answers visitors without a session; reports and neighbors stay behind entry", async () => {
  const request = (path: string) =>
    new Hono()
      .use(requireAppAccess(app.meta, async (c) => c.text("Core access denied", 403)))
      .post(path, (c) => c.text("route-owned admission"))
      .request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  // The card admits like the page itself, so entry lets every visitor reach the route's own admission.
  const card = await request("/api/code/pages/provenance");
  expect(card.status).toBe(200);
  expect(await card.text()).toBe("route-owned admission");
  // Only members report (F28): the report route and the label's neighbors keep the normal entry.
  for (const path of ["/api/code/pages/report", "/api/code/pages/provenance/extra", "/api/code/pages"]) {
    const response = await request(path);
    // A visitor without a session is sent to sign in before any route sees the request.
    expect(response.status).toBe(401);
    expect(await response.text()).not.toBe("route-owned admission");
  }
});
