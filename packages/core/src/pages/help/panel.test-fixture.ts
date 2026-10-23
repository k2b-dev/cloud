import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { CloudRuntime, RuntimeAppMeta } from "@k2b/cloud/contracts/app";
import { withPanelContext } from "@k2b/cloud/contracts/panel-context";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "cloud-help-panel-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
// The unavailable-store frame is a unit fixture too; its diagnostic must not write to Postgres.
const logging = await import("@k2b/cloud/services/logging");
const logger = spyOn(logging, "logger").mockReturnValue({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
const { default: page } = await import("./panel.page").finally(() => logger.mockRestore());
const settings = await import("@k2b/cloud/server/middleware/settings");
const snapshot = await import("@k2b/cloud/services/settings/snapshot");
const rail = await import("@k2b/cloud/services/rail-snapshot");
const { defaultRailPreferences } = await import("@k2b/cloud/contracts/rail-preferences");
const help = await import("@k2b/cloud/services/help");
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

export const apps: RuntimeAppMeta[] = ["spaces", "restricted", "app-denied", "admin-only", "core", "empty"].map((id) => ({
  id,
  ...(id === "app-denied" ? { access: { kind: "roles", roles: ["admin"] } as const } : {}),
  name: `${id} fixture app`,
  icon: "ti ti-box",
  description: "Help fixture",
  routes: id === "core" ? ["/"] : [`/app/${id}`],
  ...(id === "admin-only"
    ? { adminHref: "/admin/fixture" }
    : { nav: { href: `/app/${id}`, section: "primary", ...(id === "restricted" ? { requiresRoles: ["admin"] } : {}) } }),
  appearance: { accent: "#16a34a", background: { from: "#16a34a", to: "#0284c7" } },
  ...(id !== "empty" ? { help: { manifestHash: id, pageBase: `/help/apps/${id}`, baseLocale: "en" } } : {}),
  ...(id === "core" ? { panel: { href: "/panel", label: "Help", icon: "ti ti-help-circle" } } : {}),
}));
export const server = new Hono<{ Variables: AuthContext["Variables"] & { runtime: CloudRuntime } }>()
  .use(async (c, next) => {
    c.set("user", person);
    c.set("actor", { kind: "user", user: person });
    c.set("accessSubject", { type: "user", userId: person.id });
    c.set("credentialKind", "session");
    c.set("runtime", { apps });
    await next();
  })
  .get("/panel", ...page);
export const panelUrl = (app: string, help = ["spaces-share", "unknown-id"]) =>
  withPanelContext("/panel", {
    v: 1,
    seq: 0,
    pageId: "22222222-2222-4222-8222-222222222222",
    app,
    help,
  });

export { defaultRailPreferences, help, rail, settings, snapshot };
