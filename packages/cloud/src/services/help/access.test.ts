import { expect, test } from "bun:test";
import type { AppRegistryNav } from "../../contracts/registry";
import type { RequestActor, Role, User } from "../../contracts/shared";
import { buildProjectedUser } from "../session/user";
import { canReadAppHelp } from "./index";

const person = (profile: User["profile"], effectiveAdmin = false): RequestActor => ({
  kind: "user",
  user: buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile, effective_admin: effectiveAdmin }),
});
const user = person("user");
const guest = person("guest");
const admin = person("user", true);
const visible = (nav: AppRegistryNav | undefined) => [undefined, guest, user, admin].map((viewer) => canReadAppHelp({ nav }, viewer));
const roles = (requiresRoles: Role[]): AppRegistryNav => ({ href: "/app/x", section: "primary", requiresAuth: true, requiresRoles });

test("Help follows the app's declared visibility and always needs a user", () => {
  // anonymous, guest, user, admin
  expect(visible(undefined)).toEqual([false, true, true, true]);
  expect(visible({ href: "/app/x", section: "more", requiresAuth: true })).toEqual([false, true, true, true]);
  expect(visible(roles(["user"]))).toEqual([false, false, true, true]);
  expect(visible(roles(["user", "guest"]))).toEqual([false, true, true, true]);
  expect(visible({ href: "", section: "hidden", requiresRoles: ["admin"] })).toEqual([false, false, false, true]);
  expect(visible({ href: "", section: "hidden", adminHref: "/admin/x" })).toEqual([false, false, false, true]);
});

test("Help hides a denied app before loading its manifest, content, or search results", async () => {
  const { createHelpReader } = await import("./index");
  const app = {
    id: "secret",
    name: "Secret",
    description: "Secret",
    icon: "ti ti-lock",
    routes: [],
    baseUrl: "http://secret.invalid",
    access: { kind: "roles" as const, roles: ["admin" as const] },
    help: { manifestHash: "a".repeat(64), pageBase: "/help/apps/secret", baseLocale: "en" },
  };
  const reader = createHelpReader("en", user, {
    authority: {
      actor: user,
      accessSubject: { type: "user", userId: user.kind === "user" ? user.user.id : "" },
      credentialKind: "session",
      scopes: [],
    },
    getApp: async () => app,
    listApps: async () => [app],
  });
  expect(await reader.manifest("secret")).toBeNull();
  expect(await reader.read({ appId: "secret", documentId: "secret" })).toBeNull();
  expect(await reader.list()).toEqual([]);
  expect(await reader.search({ query: "secret" })).toEqual([]);
});
