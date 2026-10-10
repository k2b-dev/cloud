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
