import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import * as ai from "@valentinkolb/cloud/ai";
import * as live from "@valentinkolb/cloud/ai/live";
import type { CloudRuntime, User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import * as services from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import * as sidebar from "../sidebar";
import * as projectContext from "../project-context";

const root = mkdtempSync(join(tmpdir(), "assistant-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
  mail: "reader@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const project = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "project123",
  name: "Selected project",
  description: "",
  icon: "ti ti-folders",
  instructions: "",
  defaultModelProfileId: null,
  permission: "read",
  revision: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} satisfies ai.AiProject;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(spyOn(live, "latestAiInvalidationCursor").mockResolvedValue("0-0"));
  spies.push(
    spyOn(ai, "toPublicAiSettingsState").mockResolvedValue({
      ok: true,
      enabled: false,
      defaultModelId: "",
      visionModelConfigured: false,
      error: null,
      firecrawlConfigured: false,
      models: [],
    }),
  );
  spies.push(spyOn(ai, "listAiModels").mockResolvedValue([]));
  spies.push(
    spyOn(ai.aiUserPrefs, "get").mockResolvedValue({
      userId: user.id,
      memoryEnabled: true,
      memoryLearningEnabled: false,
      lastModelId: "",
      updatedAt: project.updatedAt,
    }),
  );
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
});

const request = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/assistant", ...handler);
  return app.request("https://cloud.example.test/app/assistant?project=project123");
};

test("missing or revoked selected project returns opaque HTML404 despite a stale sidebar", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [{ ...project, id: project.shortId }],
      conversations: [],
    }),
  );
  spies.push(spyOn(ai.aiProjects, "getByShortId").mockResolvedValue(null));
  const chats = spyOn(ai.aiConversations, "listConversationsPage");
  spies.push(chats);
  const response = await request();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).not.toContain(project.name);
  expect(chats).not.toHaveBeenCalled();
});

test("authorized project omitted by sidebar cap remains in the rendered workspace with public IDs", async () => {
  spies.push(spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({ projects: [], conversations: [] }));
  const lookup = spyOn(ai.aiProjects, "getByShortId").mockResolvedValue(project);
  const chats = spyOn(ai.aiConversations, "listConversationsPage").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 20,
    hasNext: false,
  });
  spies.push(lookup, chats);
  spies.push(
    spyOn(projectContext, "loadAssistantProjectContextSnapshot").mockResolvedValue({
      projectId: project.shortId,
      knowledge: [],
      files: [],
      references: [],
    }),
  );
  const response = await request();
  expect(response.status).toBe(200);
  expect(lookup).toHaveBeenCalledWith(project.shortId, { type: "user", userId: user.id });
  expect(chats).toHaveBeenCalledWith({ ownerUserId: user.id, projectId: project.id, page: 1, perPage: 20 });
  const html = await response.text();
  expect(html).toContain(project.name);
  expect(html).toContain(project.shortId);
  expect(html).not.toContain(project.id);
});
