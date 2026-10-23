import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { spacesService } from "../../service";
import * as mailIntegration from "../../service/mail-integration";
import * as overview from "../../service/overview";
import { spacesPublicResources } from "../../service/public-resources";
import { defaultCalendarFilter } from "./_components/calendar/filter";
import * as workspaceState from "./_components/workspace/workspace-state";
import type { SpacesWorkspaceState } from "./_components/workspace/workspace-types";

const root = mkdtempSync(join(tmpdir(), "spaces-page-panel-context-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"] as const,
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
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
const internalId = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-18T08:00:00.000Z";
const state: Extract<SpacesWorkspaceState, { kind: "ok" }> = {
  kind: "ok",
  title: [{ title: "Launch" }],
  currentUserId: user.id,
  space: {
    id: "Space1",
    name: "Launch",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: now,
    updatedAt: now,
    columns: [],
    virtualColumns: [],
    tags: [],
    templates: [],
  },
  settings: { view: "list", hideSettings: false },
  currentView: "list",
  hasOverride: false,
  isAdmin: false,
  canWrite: false,
  query: "",
  icalBaseUrl: "https://cloud.test",
  eventCursor: null,
  snapshotDay: "2026-10-18",
  itemsResult: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 },
  kanbanBuckets: [],
  calendarView: "month",
  calendarDate: now,
  calendarFilter: defaultCalendarFilter,
  calendarRange: { from: now, to: "2026-11-18T08:00:00.000Z" },
  calendarItems: [],
  calendarWeather: {},
  calendarTray: null,
  selectedItemDetail: null,
  wormholes: [],
};
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  spies.push(
    spyOn(overview, "loadSpacesSidebar").mockResolvedValue({ spaces: [], pinnedSpaceIds: [], myWorkCount: 0 }),
    stubRailSnapshot(),
    spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null),
    spyOn(cloudServices, "get").mockResolvedValue("https://cloud.test"),
    spyOn(spacesPublicResources, "resolvePublicId").mockResolvedValue(internalId),
    spyOn(mailIntegration, "isMailInvitationIntegrationAvailable").mockResolvedValue(false),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const request = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      const person = { ...user, roles: ["user"] as Array<"user">, provider: "local" as const, profile: "user" as const };
      c.set("user", person);
      c.set("actor", { kind: "user", user: person });
      c.set("accessSubject", { type: "user", userId: user.id });
      c.set("credentialKind", "oauth");
      c.set("credentialScopes", ["mail:read"]);
      c.set("runtime", {
        apps: [
          {
            id: "spaces",
            name: "Spaces",
            icon: "ti ti-box",
            description: "Fixture",
            routes: ["/app/spaces"],
            panel: { href: "/app/spaces/panel", label: "Spaces", icon: "ti ti-box" },
          },
        ],
      });
      await next();
    })
    .get("/app/spaces/:id", ...handler);
  return app.request("https://cloud.test/app/spaces/Space1");
};

test("a page that shows a Space reports its public Space ID in shell data", async () => {
  spies.push(spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue(state));
  const response = await request();
  expect(response.status).toBe(200);
  const html = await response.text();
  const shell = JSON.parse(html.match(/id="cloud-shell-data" type="application\/json">([^<]*)/)![1]!);
  expect(shell.panel.context.scope).toEqual({ type: "spaces.space", id: state.space.id });
  expect(shell.panel.context.scope.id).not.toBe(internalId);
});

test("a writable Space with a long query still renders its primary command link", async () => {
  spies.push(
    spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue({
      ...state,
      query: `view=list&q=${"x".repeat(1990)}`,
      canWrite: true,
    }),
    spyOn(spacesService.item, "listAssignableUsers").mockResolvedValue([]),
  );
  const response = await request();
  expect(response.status).toBe(200);
  const html = await response.text();
  const primary = html.match(/<a\b[^>]*data-workspace-primary[^>]*>/)?.[0];
  expect(primary?.match(/\bhref="([^"]*)"/)?.[1]).toContain("command=spaces.task.compose");
});

for (const kind of ["notFound", "accessDenied"] as const)
  test(`${kind} does not report a Space scope`, async () => {
    spies.push(spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue({ kind, title: "Unavailable", message: "Unavailable" }));
    const response = await request();
    expect(response.status).toBe(kind === "notFound" ? 404 : 403);
    expect(await response.text()).not.toContain('"type":"spaces.space"');
  });

test("the Space page passes the same capped authority to discovery and reference readers", async () => {
  const load = spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue(state);
  spies.push(load);
  expect((await request()).status).toBe(200);
  const authority = load.mock.calls[0]?.[0].authority;
  expect(authority).toMatchObject({
    actor: { kind: "user", user: { id: user.id } },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "oauth",
    scopes: ["mail:read"],
  });
  expect(mailIntegration.isMailInvitationIntegrationAvailable).toHaveBeenCalledWith(authority);
});
