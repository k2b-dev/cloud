import { expect, mock, test } from "bun:test";
import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { AuthContext } from "@k2b/cloud/server";
import type { KnownApp } from "../../../known-apps";
import { createMaintenanceService } from "../../../maintenance";
import { loadMaintenanceAdmin } from "./load";

const person = (roles: AuthContext["Variables"]["user"]["roles"]): AuthContext["Variables"]["user"] => ({
  id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51",
  uid: "lea",
  provider: "local",
  roles,
  profile: "user",
  givenname: "Lea",
  sn: "Muster",
  displayName: "Lea Muster",
  mail: null,
  avatarHash: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
});
const known = (id: string, name: string): KnownApp => ({
  id,
  name,
  description: "",
  icon: "ti ti-box",
  accent: null,
  release: null,
  routes: [],
  navHref: null,
  adminHref: null,
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: null,
  hidden: false,
});
const apps: MaintenanceStatus["apps"] = { ready: 1, total: 2, starting: ["mail"] };

const setup = () => {
  const read = mock(async () => null);
  const knownApps = mock(async () => [known("mail", "Mail"), known("files", "Dateien")]);
  const service = createMaintenanceService({
    store: { read, write: async () => {}, clear: async () => {} },
    appsReady: async () => apps,
    record: async () => {},
  });
  return { read, knownApps, service };
};

test("a signed-in person without the administrator role gets no state and no app catalogue", async () => {
  const { read, knownApps, service } = setup();
  for (const user of [undefined, person(["user"])]) {
    const result = await loadMaintenanceAdmin(user, { service, knownApps });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  }
  expect(read).not.toHaveBeenCalled();
  expect(knownApps).not.toHaveBeenCalled();
});

test("an administrator gets the state and the app names for starting apps", async () => {
  const { knownApps, service } = setup();
  const result = await loadMaintenanceAdmin(person(["admin"]), { service, knownApps });
  expect(result).toEqual({ ok: true, data: { status: { active: false, apps }, appNames: { mail: "Mail", files: "Dateien" } } });
});
