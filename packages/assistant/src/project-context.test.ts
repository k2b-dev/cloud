import { afterEach, expect, spyOn, test } from "bun:test";
import { type AiSkillSummary, aiProjects, aiSkills } from "@k2b/cloud/ai";
import type { AppRegistryEntry } from "@k2b/cloud/contracts/registry";
import type { RequestAuthority } from "@k2b/cloud/server";
import { canUseApp, oauthTokens } from "@k2b/cloud/services";
import { redis } from "bun";
import * as settings from "../../cloud/src/services/settings";
import api from "./api";
import { artifacts } from "./artifacts/service";
import { testIdentity } from "./artifacts/test-identity";
import { loadAssistantProjectContextSnapshot } from "./project-context";

const identity = testIdentity("11111111-1111-4111-8111-111111111111");
const authority: RequestAuthority = { ...identity, credentialKind: "oauth", scopes: ["demo:read"] };
const at = "2026-10-01T00:00:00.000Z";
const project = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "Prj234",
  name: "Project",
  description: "",
  icon: "",
  instructions: "",
  defaultModelProfileId: null,
  permission: "read" as const,
  revision: 1,
  createdAt: at,
  updatedAt: at,
};
const skill: AiSkillSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "Skl234",
  name: "demo-guide",
  description: "Guide",
  permission: "read",
  revision: 1,
  referenceCount: 0,
  enabled: true,
  manualOnly: false,
  createdAt: at,
  updatedAt: at,
  source: { appId: "demo", appName: "Demo" },
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup() {
  const app: AppRegistryEntry = {
    id: "demo",
    name: "Demo",
    description: "",
    icon: "",
    baseUrl: "http://demo.invalid",
    routes: [],
    access: { kind: "signedIn" },
  };
  spies.push(spyOn(aiProjects, "getByShortId").mockResolvedValue(project));
  spies.push(spyOn(aiProjects, "listKnowledge").mockResolvedValue([]));
  spies.push(spyOn(aiProjects, "listFiles").mockResolvedValue([]));
  spies.push(spyOn(aiProjects, "listReferences").mockResolvedValue([]));
  spies.push(spyOn(artifacts, "projectApps").mockResolvedValue({ items: [], page: 1, hasNext: false }));
  // Keep this test at the loader boundary; the Skill service's SQL is covered by its own suites.
  const skills = spyOn(aiSkills, "projectSkills").mockImplementation(async (_id, _subject, options) => ({
    items: (await canUseApp(options?.authority ?? null, app)) ? [skill] : [],
    page: 1,
    hasNext: false,
  }));
  spies.push(skills);
  return { app, skills };
}

test("project context keeps allowed declared-app Skills, exact scopes and mobile authority, then removes revoked Skills", async () => {
  const { app, skills } = setup();
  const mobile: RequestAuthority = {
    actor: { kind: "user", user: identity.user, sessionKind: "app" },
    accessSubject: identity.accessSubject,
    credentialKind: "session",
    scopes: [],
  };
  const allowed = await loadAssistantProjectContextSnapshot(mobile, project.shortId);
  expect(allowed?.skills.items).toEqual([{ ...skill, id: skill.shortId }]);
  expect(skills).toHaveBeenCalledWith(project.id, mobile.accessSubject, { authority: mobile });
  expect(skills.mock.calls[0]?.[2]?.authority).toBe(mobile);
  app.access = { kind: "roles", roles: ["admin"] };
  expect((await loadAssistantProjectContextSnapshot(mobile, project.shortId))?.skills.items).toEqual([]);
  app.access = { kind: "signedIn" };
  expect((await loadAssistantProjectContextSnapshot({ ...authority, scopes: ["core:read"] }, project.shortId))?.skills.items).toEqual([]);
});

test("project context API forwards the authority resolved from the request credential", async () => {
  const { app, skills } = setup();
  spies.push(spyOn(settings, "get").mockResolvedValue(100));
  spies.push(spyOn(redis, "send").mockResolvedValue([0, 0, "0"]));
  spies.push(
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user: identity.user, payload: {}, scopes: authority.scopes }),
  );
  const request = () =>
    api.request(`/workspace/projects/${project.shortId}/context`, { headers: { authorization: "Bearer project-test-token" } });
  const allowed = await request();
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ skills: { items: [{ id: skill.shortId }] } });
  expect(skills.mock.calls[0]?.[2]?.authority).toMatchObject({
    credentialKind: "oauth",
    scopes: ["demo:read"],
    accessSubject: identity.accessSubject,
  });
  app.access = { kind: "roles", roles: ["admin"] };
  expect(await (await request()).json()).toMatchObject({ skills: { items: [] } });
});
