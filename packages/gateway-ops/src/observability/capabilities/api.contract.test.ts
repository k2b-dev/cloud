import { expect, test } from "bun:test";

test("every capability history route is admin-only, rate limited and read-only", async () => {
  const source = await Bun.file(new URL("./api.ts", import.meta.url)).text();

  expect(source).toContain(".use(rateLimit())");
  expect(source).toContain('.use(auth.requireRole("admin"))');
  // The dispatcher owns every write to this history; the console must not offer one.
  expect(source).not.toContain(".post(");
  expect(source).not.toContain(".put(");
  expect(source).not.toContain(".delete(");
  expect(source).not.toContain("recordCapabilityExecution");
  expect(source).not.toContain("pruneCapabilityExecutions");
});

test("the page and the API are mounted behind the same admin gate", async () => {
  const source = await Bun.file(new URL("../../index.ts", import.meta.url)).text();

  expect(source).toContain('.get("/admin/observability/capabilities", auth.requireRole("admin", ssr.access), ...capabilitiesPage)');
  expect(source).toContain('.route("/api/gateway/capabilities", capabilitiesApiRoutes)');
});
