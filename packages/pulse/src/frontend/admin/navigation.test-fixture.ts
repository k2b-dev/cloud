import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { createSSRHandler } from "@k2b/ssr/hono";
import { Hono } from "hono";
import { adminFixtureIdentity } from "../../store/admin-identity.test-fixture";

const root = mkdtempSync(join(tmpdir(), "pulse-admin-navigation-"));
const snapshot = createConfig({
  dev: true,
  rootDir: root,
  template: ({ body }) => `<!doctype html><html><head></head><body>${body}</body></html>`,
});
Bun.plugin(snapshot.plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const config = await import("../../config");
const baseAdmin = await import("../../service/base-admin");
const { storeAdmin } = await import("../../store/service");
// Keep the real route guards, page, AdminLayout and registry metadata. Replace
// only platform service preloads with the public SSR adapter, as in the workspace fixture.
const originalSsr = config.ssr;
const ssr = spyOn(config, "ssr").mockImplementation(Object.assign(createSSRHandler(snapshot.html), originalSsr));
// Bun's spy wrapper does not retain function properties. The real route must
// still receive the original SSR access/error handlers, including login redirects.
Object.assign(config.ssr, originalSsr);
const routes = await import("./page").finally(() => ssr.mockRestore());
const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [config.app.meta] });
    await next();
  })
  .route("/admin/pulse", routes.default);

/** Synthetic identity and data reads; no authentication service, database or ClickHouse access. */
export const renderAdminNavigation = async (locale: "de" | "en", role: "admin" | "user" | "anonymous" = "admin") => {
  const identity = adminFixtureIdentity(undefined, role === "admin");
  if (identity.actor.kind !== "user") throw new Error("Expected fixture person");
  const user = identity.actor.user;
  // A synthetic session token avoids a real cookie triggering announcement service preloads.
  const token = spyOn(session, "getToken").mockReturnValue(role === "anonymous" ? null : "navigation-fixture");
  const authentication = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "navigation-fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  const read = spyOn(storeAdmin, "read").mockResolvedValue({ configured: false, url: "", user: "pulse_service", passwordSet: false });
  const bases = spyOn(baseAdmin, "listAdminBases").mockResolvedValue({ items: [], total: 0, nextOffset: null, usedBytes: 0, disk: null });
  const targets = spyOn(baseAdmin, "listInternalTargets").mockResolvedValue({ items: [], total: 0, nextOffset: null });
  try {
    const headers = new Headers({ "Accept-Language": locale });
    const response = await server.request("/admin/pulse", { headers });
    return {
      status: response.status,
      html: await response.text(),
      location: response.headers.get("location"),
      reads: read.mock.calls.length,
    };
  } finally {
    for (const spy of [token, authentication, read, bases, targets]) spy.mockRestore();
  }
};
