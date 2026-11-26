import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { spacesService } from "../../service";
import * as mailIntegration from "../../service/mail-integration";
import * as overview from "../../service/overview";
import { spacesPublicResources } from "../../service/public-resources";
import { defaultCalendarFilter } from "./_components/calendar/filter";
import * as workspaceState from "./_components/workspace/workspace-state";
import type { SpacesWorkspaceState } from "./_components/workspace/workspace-types";

const root = mkdtempSync(join(tmpdir(), "spaces-page-panel-context-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

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
  accessVisible: true,
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
    spyOn(overview, "loadSpacePulse").mockResolvedValue({ done: Array(14).fill(0), overdue: 0, unassigned: 0 }),
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
const request = (path = "/app/spaces/Space1") => {
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
  return app.request(`https://cloud.test${path}`);
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

test("an open task reads its due time against the snapshot's time, so the server and the first browser picture agree", async () => {
  // The snapshot was taken two days before the deadline; the clock of the test run is long past it.
  const item = {
    id: "Item01",
    spaceId: "Space1",
    columnId: "Col001",
    title: "Publish release",
    description: null,
    location: null,
    url: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    deadline: "2026-10-20T10:00:00.000Z",
    deadlineAllDay: false,
    estimatedDurationMinutes: null,
    activeBlockerCount: 0,
    priority: null,
    recurrence: null,
    recurringEventId: null,
    recurrenceId: null,
    rank: "1024",
    completedAt: null,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
    assignees: [],
    tags: [],
    claim: null,
  };
  spies.push(
    spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue({
      ...state,
      query: "item=Item01",
      snapshotAt: now,
      selectedItemDetail: {
        item,
        comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
        commentTarget: { itemId: item.id, recurrenceId: null },
        recurringContext: null,
        references: [],
        links: [],
        attachments: [],
        checklist: [],
        blockedBy: [],
        blocks: [],
      },
    }),
  );
  const html = await (await request("/app/spaces/Space1?item=Item01")).text();
  expect(html).toContain("Publish release");
  expect(html).toContain("in 2 days");
  expect(html).not.toContain("Overdue");
});

test("the Space is named once: by its entry in the sidebar and the phone bar, not again in the head", async () => {
  spies.push(spyOn(workspaceState, "loadSpacesWorkspaceState").mockResolvedValue(state));
  const html = await (await request()).text();
  const head = html.slice(html.indexOf('data-slot="head"'), html.indexOf('data-k2-part="Pane.Split"'));
  expect(head).toContain('data-k2-part="Tabs"');
  expect(head).not.toContain(">Launch<");
  // The phone bar names it: its menu carries the Space's name.
  expect(html).toContain('data-cloud-workspace-navigation>{"label":"Launch"');
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
  // the main action of the phone is a command link, so it also works before the page is live
  const primary = html.match(/<a\b[^>]*k2-fab[^>]*>/)?.[0];
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
