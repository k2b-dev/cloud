import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { aiProjects, aiSkills } from "@k2b/cloud/ai";
import type { LocalUser } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { managesAiPrincipalSearchTarget } from "./ai-principal-search-target";

const user: LocalUser = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "target-manager",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Target",
  sn: "Manager",
  displayName: "Target Manager",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const common = {
  id: "resource-id",
  shortId: "AI2568",
  name: "lookup",
  description: "Lookup fixture",
  revision: 1,
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
};
const skill = {
  ...common,
  source: null,
  permission: "admin" as const,
  enabled: true,
  manualOnly: false,
  referenceCount: 0,
  instructions: "Test",
  extraFrontmatter: {},
  references: [],
};
const project = { ...common, permission: "admin" as const, icon: "ti ti-folders", instructions: "Test", defaultModel: null };
afterEach(() => mock.restore());

for (const kind of ["skill", "project"] as const) {
  test(`${kind} uses the local service's current Manage decision`, async () => {
    const skillRead = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    const projectRead = spyOn(aiProjects, "getByShortId").mockResolvedValue(project);
    const target = { type: `core.ai.${kind}`, id: common.shortId };
    expect(await managesAiPrincipalSearchTarget(target, authority)).toBe(true);
    if (kind === "skill") expect(skillRead).toHaveBeenCalledWith(common.shortId, authority, "admin", authority);
    else expect(projectRead).toHaveBeenCalledWith(common.shortId, authority, "admin");
    skillRead.mockResolvedValue(null);
    projectRead.mockResolvedValue(null);
    expect(await managesAiPrincipalSearchTarget(target, authority)).toBe(false);
    skillRead.mockRejectedValue(new Error("Target unavailable"));
    projectRead.mockRejectedValue(new Error("Target unavailable"));
    expect(await managesAiPrincipalSearchTarget(target, authority)).toBe(false);
  });
  test(`${kind} keeps existing Cloud-admin recovery, but only for a live target`, async () => {
    const admin: RequestAuthority = { ...authority, actor: { kind: "user", user: { ...user, roles: ["user", "admin"] } } };
    const skillRead = spyOn(aiSkills.admin, "getByShortId").mockResolvedValue({
      ...common,
      source: null,
      referenceCount: 0,
      accessCount: 0,
      adminCount: 0,
    });
    const projectRead = spyOn(aiProjects.admin, "getByShortId").mockResolvedValue({
      ...common,
      icon: project.icon,
      accessCount: 0,
      adminCount: 0,
    });
    const target = { type: `core.ai.${kind}`, id: common.shortId };
    expect(await managesAiPrincipalSearchTarget(target, admin)).toBe(true);
    skillRead.mockResolvedValue(null);
    projectRead.mockResolvedValue(null);
    expect(await managesAiPrincipalSearchTarget(target, admin)).toBe(false);
  });
}

test("other apps use A2's reader; a mismatched AI subject gets no lookup", async () => {
  expect(await managesAiPrincipalSearchTarget({ type: "spaces.space", id: "space-1" }, authority)).toBeUndefined();
  const read = spyOn(aiSkills, "getByShortId");
  expect(
    await managesAiPrincipalSearchTarget(
      { type: "core.ai.skill", id: common.shortId },
      {
        ...authority,
        accessSubject: { type: "user", userId: "somebody-else" },
      },
    ),
  ).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
