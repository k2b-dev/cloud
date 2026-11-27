import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-overview-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("../page");

// the sentences say "Today" and "Yesterday": the clock stands still at a fixed morning
beforeAll(() => setSystemTime(new Date("2026-11-25T08:00:00.000Z")));
afterAll(() => setSystemTime());

const person = (roles: User["roles"]): User => ({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "jana.berger",
  roles,
  provider: "local",
  profile: "user",
  givenname: "Jana",
  sn: "Berger",
  displayName: "Jana Berger",
  mail: "jana@solberg-kramer.example",
  avatarHash: null,
  ipa: null,
  accountExpires: "2026-01-31T00:00:00.000Z",
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});

const summary = {
  ipaAccountsTotal: 41,
  localAccountsTotal: 12,
  groupsTotal: 17,
  ipaGroupsTotal: 9,
  localGroupsTotal: 8,
  openRequests: 2,
  ipaExpiring30d: 3,
  localUserExpiring30d: 0,
  localGuestExpiring30d: 1,
  lastSync: { createdAt: "2026-11-25T07:00:00.000Z" },
  recentSyncRuns: 10,
  recentSyncRunsWithFailures: 1,
  recentDemotionRuns: 10,
  recentDemotionRunsWithFailures: 0,
  recentReminderRuns: 10,
  recentReminderRunsWithFailures: 0,
  runHealthWindow: 10,
};

const render = async (user: User, freeIpa = true) => {
  const dashboard = spyOn(services.accountsAppService.dashboard, "get").mockResolvedValue(summary as never);
  const activity = spyOn(services.audit, "latest").mockResolvedValue([
    {
      id: 41,
      createdAt: "2026-11-25T07:42:00.000Z",
      action: "accounts.group.member.add",
      outcome: "allowed",
      actor: { userId: "44444444-4444-4444-8444-000000000001", uid: "ada.renz", provider: "local", roles: ["admin"] },
      target: { type: "group", id: "33333333-3333-4333-8333-000000000001", label: "Werkstatt", provider: "local" },
      reason: null,
      errorCode: null,
      errorMessage: null,
      requestId: null,
      metadata: {},
    },
    {
      id: 40,
      createdAt: "2026-11-24T16:20:00.000Z",
      action: "accounts.user.remove",
      outcome: "failed",
      actor: { userId: null, uid: null, provider: null, roles: [] },
      target: { type: "user", id: "44444444-4444-4444-8444-000000000002", label: "guest-tom", provider: "local" },
      reason: null,
      errorCode: "FREEIPA",
      errorMessage: "FreeIPA nicht erreichbar",
      requestId: null,
      metadata: {},
    },
  ]);
  const groups = spyOn(services.accountsAppService.group, "list").mockImplementation(
    async ({ scope }) => ({ items: [], page: 1, perPage: 1, total: scope?.mode === "all" ? 23 : 3, hasNext: false }) as never,
  );
  const spies = [
    stubRailSnapshot(),
    dashboard,
    activity,
    spyOn(services.coreSettings, "get").mockResolvedValue(freeIpa),
    groups,
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts", ...handler);
  try {
    const response = await app.request("/app/accounts", { headers: { "Accept-Language": "en" } });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    return {
      html,
      dashboardCalls: dashboard.mock.calls.length,
      activityCalls: activity.mock.calls.length,
      activityLimits: activity.mock.calls.map(([config]) => config.limit),
      groupScopes: groups.mock.calls.map(([config]) => config.scope?.mode),
    };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("an administrator sees their account, the groups and the administration, linked to the new places", async () => {
  const { html, activityLimits, groupScopes } = await render(person(["user", "admin"]));
  // the number of all groups comes from the dashboard (17), so the groups are read only for the person's own
  expect(groupScopes.sort()).toEqual(["managed", "member"]);
  expect(html).toContain('data-k2-part="Workspace"');
  expect(html).toContain("Jana Berger");
  expect(html).toContain("Your account");
  // the account expired: its date stands as a bad state
  expect(html).toContain("Expired Jan 31, 2026");
  for (const label of ["Your account", "Your groups", "All groups", "Requests", "Run health", "Activity"]) {
    expect(html).toContain(label);
  }
  // the groups section leads to all groups, the cells to the requests and the accounts
  // an administrator's groups start at all groups, so the address names no scope
  expect(html).toContain('href="/app/accounts/groups"');
  expect(html).toContain('href="/app/accounts/requests"');
  expect(html).toContain('href="/app/accounts/users"');
  // the audit log, reminders and deleted accounts live on the activity page now (the shared sidebar is not this page's)
  expect(html).toContain('href="/app/accounts/activity"');
  expect(html).toContain("/app/accounts/activity?kind=deleted");
  expect(html).toContain("/app/accounts/activity?kind=reminders");
  // who changed what, as sentences from one read of the audit log: the actor, the verb, the thing with its link
  expect(activityLimits).toEqual([8]);
  expect(html).toContain("ada.renz");
  expect(html).toContain('href="/app/accounts/groups/33333333-3333-4333-8333-000000000001"');
  expect(html).toContain("Today, 07:42");
  expect(html).toContain("Yesterday, 16:20");
  expect(html).toContain("Failed");
  expect(html).toContain("All activity");
  expect(html).toContain('href="/me"');
  expect(html).not.toContain('data-k2-part="Loading"');
  // the island gets only what the view shows: its serialized props, as the page sends them
  const props = html.match(/data-props="([^"]*)"[^>]*data-file="OverviewScreen\.island\.tsx"/)?.[1] ?? "";
  console.info(`overview island props (admin): ${props.length} characters in the page, ${props.replaceAll("&quot;", "\"").length} decoded`);
  expect(props.length).toBeGreaterThan(0);
  expect(props.length).toBeLessThan(16_000);
  console.info(`overview v2 DOM elements (admin): ${html.match(/<[a-z][a-z0-9-]*/gi)?.length}`);
});

test("everyone else sees only their account and their groups; the administration's data is not even read", async () => {
  const { html, dashboardCalls, activityCalls, groupScopes } = await render(person(["user"]));
  // without the dashboard, the cell "All groups" needs its own count
  expect(groupScopes.sort()).toEqual(["all", "managed", "member"]);
  expect(html).toContain(">23<");
  expect(html).toContain("Your account");
  expect(html).toContain("My groups");
  expect(html).toContain('href="/app/accounts/groups?scope=managed"');
  expect(html).not.toContain("Administration");
  expect(html).not.toContain("Run health");
  expect(html).not.toContain("/admin/observability/logs");
  expect(html).not.toContain("/app/accounts/requests");
  expect(dashboardCalls).toBe(0);
  // no audit read at all for someone who may not read the audit log
  expect(activityCalls).toBe(0);
});
