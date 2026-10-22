import { expect, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { resolveAppPresentation } from "@k2b/cloud/shared";
import { visiblePanelProviders } from "@k2b/cloud/ssr/app-navigation";
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
  expect(resolveAppPresentation(meta, "de").panel?.label).toBe("Hilfe");
  expect(visiblePanelProviders([meta], undefined, "en")).toEqual([]);
  expect(visiblePanelProviders([meta], person, "en").map((provider) => provider.label)).toEqual(["Help"]);
  expect(visiblePanelProviders([meta], { ...person, profile: "guest", roles: [] }, "de").map((provider) => provider.label)).toEqual([
    "Hilfe",
  ]);
});
