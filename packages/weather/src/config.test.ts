import { expect, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { canReadAppHelp } from "@k2b/cloud/services/help";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { app } from "./config";

const person = (profile: "user" | "guest"): RequestActor => ({
  kind: "user",
  user: buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile, effective_admin: false }),
});

test("guests get no Weather Help, since its pages need a full account", () => {
  const nav = app.meta.nav;
  expect(nav).toBeDefined();
  expect(canReadAppHelp({ nav }, person("guest"))).toBe(false);
  expect(canReadAppHelp({ nav }, person("user"))).toBe(true);
});
