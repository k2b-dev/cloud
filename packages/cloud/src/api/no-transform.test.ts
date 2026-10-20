import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { prepareNoTransformRouterTest } from "../../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();
const { createAccountsEntitiesRoutes } = await import("./accounts-entities");
const { createSyncOpsProxyRoutes } = await import("./sync-ops");
const { aiRoutes } = await import("../ai/routes");
const { createSearchRoutes } = await import("./search");
const { createCapabilityRoutes } = await import("./capabilities");
const { createMcpRoutes } = await import("./mcp");
const { createWidgetRoutes } = await import("./widgets");
const { default: meRoutes } = await import("./me");
const { approvalRoutes } = await import("./approvals");
const { default: outgoingMail } = await import("./admin-outgoing-mail");
const { default: aiUsage } = await import("./admin-ai-usage");
const { default: lifecycle } = await import("./admin-lifecycle");
const { createAdminIdentityRoutes } = await import("./admin-identity");
const { default: aiProjects } = await import("./admin-ai-projects");
const { default: aiSkills } = await import("./admin-ai-skills");
const { aiProjectsRoutes } = await import("../ai/projects-routes");
const { aiSkillsRoutes } = await import("../ai/skills-routes");
const { createAppApprovalRoutes } = await import("./app-approval");
const { appApproval, AppApprovalError } = await import("../services/app-approval");

const groups = [
  { name: "scoped personal-data directory", router: createAccountsEntitiesRoutes(), paths: ["/entities", "/entities/__new_route__"] },
  { name: "Sync previews", router: createSyncOpsProxyRoutes(), paths: ["/", "/app/dead-letters/queue/store"] },
  { name: "AI conversations", router: aiRoutes, paths: ["/conversations", "/conversations/id/messages", "/__new_route__"] },
  { name: "search", router: createSearchRoutes(), paths: ["/search", "/search/__new_route__"] },
  {
    name: "capabilities and streams",
    router: createCapabilityRoutes(),
    paths: ["/capabilities/v1/catalog", "/capabilities/v1/streams/read", "/capabilities/v1/__new_route__"],
  },
  { name: "MCP", router: createMcpRoutes({ getAppUrl: async () => "https://cloud.test" }), paths: ["/mcp/v1", "/mcp/v1/__new_route__"] },
  { name: "widgets", router: createWidgetRoutes(), paths: ["/widgets/v1", "/widgets/v1/app/widget", "/widgets/v1/__new_route__"] },
  { name: "notifications", router: meRoutes, paths: ["/notifications/history", "/notifications/history/__new_route__"] },
  { name: "approvals", router: approvalRoutes, paths: ["/", "/__new_route__"] },
  { name: "outgoing mail", router: outgoingMail, paths: ["/", "/__new_route__"] },
  {
    name: "identity administration and mandates",
    router: createAdminIdentityRoutes(),
    paths: ["/mandates", "/mandates/__new_route__", "/workloads"],
  },
  { name: "account lifecycle reports", router: lifecycle, paths: ["/deleted-accounts", "/reminders", "/__new_route__"] },
  { name: "AI usage", router: aiUsage, paths: ["/report", "/report/__new_route__", "/__new_route__"] },
  { name: "AI project descriptions", router: aiProjects, paths: ["/", "/__new_route__"] },
  { name: "AI skill descriptions", router: aiSkills, paths: ["/", "/__new_route__"] },
  { name: "AI projects across grants", router: aiProjectsRoutes, paths: ["/", "/__new_route__"] },
  { name: "AI skills across grants", router: aiSkillsRoutes, paths: ["/", "/__new_route__"] },
];

describe("platform compression boundaries", () => {
  for (const { name, router, paths } of groups) {
    for (const path of paths) {
      test(`${name} ${path} opts out before authentication`, async () => {
        const response = await router.request(path);
        expect(response.status).toBeLessThan(500);
        expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
      });
    }
  }

  test("fan-out markers do not opt unrelated API groups out when mounted at /", async () => {
    const router = new Hono()
      .route("/", createSearchRoutes())
      .route("/", createCapabilityRoutes())
      .route("/", createMcpRoutes())
      .route("/", createWidgetRoutes());
    expect((await router.request("/unrelated")).headers.get("Cache-Control")).toBeNull();
  });
});

test("authenticator device commands opt out even when protocol access fails", async () => {
  const config = spyOn(appApproval, "config").mockRejectedValue(new AppApprovalError("FORBIDDEN", 403));
  try {
    const router = createAppApprovalRoutes({ notify: async () => {} });
    for (const path of ["/device", "/device/__new_route__", "/info"]) {
      const response = await router.request(path, { method: path === "/info" ? "GET" : "POST" });
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Cache-Control")?.includes("no-transform")).toBe(path !== "/info");
    }
  } finally {
    config.mockRestore();
  }
});

test("profile and notification preferences stay eligible for compression", async () => {
  for (const [router, path] of [
    [meRoutes, "/"],
    [meRoutes, "/access"],
    [meRoutes, "/notifications/preferences"],
    [meRoutes, "/notifications/quiet"],
    [meRoutes, "/notifications/browser/configuration"],
  ] as const) {
    const response = await router.request(path);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
  }
});
