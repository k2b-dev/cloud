import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { person } from "../_internal/define-app.test-fixture";
import type { CloudRuntime } from "../contracts/app";
import type { PanelConsentSnapshot } from "../contracts/panel-context";
import type { AuthContext } from "../server";
import { panelContextConsent } from "../services/panel-context-consent";
import { preloadPanelConsent } from "./panel-consent";

test("SSR reads exactly once for an open consent provider, with no reads for closed, Core, unknown or anonymous", async () => {
  const get = spyOn(panelContextConsent, "get").mockResolvedValue({ allowed: true, revision: 3 });
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime; panelConsent: PanelConsentSnapshot } }>()
    .use("*", async (c, next) => {
      if (!c.req.query("anonymous")) c.set("user", person);
      c.set("runtime", {
        apps: ["core", "fixture"].map((id) => ({
          id,
          name: id,
          description: "Fixture",
          icon: "ti ti-box",
          routes: [`/app/${id}`],
          panel: { href: `/app/${id}/panel`, label: id, icon: "ti ti-box" },
        })),
      });
      await next();
    })
    .get("/", async (c) => {
      await preloadPanelConsent(c);
      return c.json(c.get("panelConsent") ?? null);
    });
  try {
    for (const cookie of ["", "cloud_panel=0:fixture:24", "cloud_panel=1:core:24", "cloud_panel=1:unknown:24"])
      expect(await (await app.request("/", { headers: { cookie } })).json()).toBeNull();
    expect(await (await app.request("/?anonymous=1", { headers: { cookie: "cloud_panel=1:fixture:24" } })).json()).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(await (await app.request("/", { headers: { cookie: "cloud_panel=1:fixture:24" } })).json()).toEqual({
      provider: "fixture",
      allowed: true,
      revision: 3,
    });
    expect(get.mock.calls).toEqual([[person.id, "fixture"]]);
    // A save of this browser with an unknown outcome: ask again, keep the revision for the fenced next save.
    expect(await (await app.request("/", { headers: { cookie: "cloud_panel=1:fixture:24; cloud_panel_unsure=fixture" } })).json()).toEqual({
      provider: "fixture",
      allowed: null,
      revision: 3,
    });
    get.mockResolvedValue(null);
    expect(await (await app.request("/", { headers: { cookie: "cloud_panel=1:fixture:24" } })).json()).toEqual({
      provider: "fixture",
      allowed: null,
      revision: 0,
    });
    get.mockRejectedValue(new Error("Store unavailable"));
    expect(await (await app.request("/", { headers: { cookie: "cloud_panel=1:fixture:24" } })).json()).toEqual({
      provider: "fixture",
      allowed: null,
      revision: 0,
    });
    expect(get).toHaveBeenCalledTimes(4);
  } finally {
    get.mockRestore();
  }
});
