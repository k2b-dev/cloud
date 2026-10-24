import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStatusPreservingSsrHandler } from "../packages/cloud/src/_internal/status-preserving-ssr";
import type { CloudRuntime } from "../packages/cloud/src/contracts";
import type { AuthContext } from "../packages/cloud/src/server";
import { session } from "../packages/cloud/src/services";
import { adminFixtureIdentity } from "../packages/pulse/src/store/admin-identity.test-fixture";
import { createConfig } from "../packages/ssr/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "pulse-admin-navigation-"));
const snapshot = createConfig({
  dev: true,
  rootDir: root,
  template: ({ body }) => `<!doctype html><html><head></head><body>${body}</body></html>`,
});
Bun.plugin(snapshot.plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const config = await import("../packages/pulse/src/config");
const baseAdmin = await import("../packages/pulse/src/service/base-admin");
const { storeAdmin } = await import("../packages/pulse/src/store/service");
// Keep the real route guards, page, AdminLayout and registry metadata. Replace
// only unrelated platform service preloads; retain the production access-aware SSR adapter.
const originalSsr = config.ssr;
const ssr = spyOn(config, "ssr").mockImplementation(Object.assign(createStatusPreservingSsrHandler(snapshot.html), originalSsr));
// Bun's spy wrapper does not retain function properties. The real route must
// still receive the original SSR access/error handlers, including login redirects.
Object.assign(config.ssr, originalSsr);
const routes = await import("../packages/pulse/src/frontend/admin/page").finally(() => ssr.mockRestore());
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
