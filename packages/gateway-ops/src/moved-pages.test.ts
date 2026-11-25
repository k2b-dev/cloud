import { expect, spyOn, test } from "bun:test";

// Pages that became areas of a record keep their old addresses: each leads to its new place with its whole query.
// Admission is replaced only inside a child process, so the package's other suites keep the real middleware.
export const MOVED_PAGES: [old: string, moved: string][] = [
  ["/admin/observability/postgres?schema=mail&q=messages", "/admin/observability/infrastructure/postgres?schema=mail&q=messages"],
  ["/admin/observability/postgres?search=x&sort=rows-desc", "/admin/observability/infrastructure/postgres?search=x&sort=rows-desc"],
  ["/admin/observability/valkey?depth=2", "/admin/observability/infrastructure/valkey?depth=2"],
  ["/admin/observability/nats?stream=MAIL_DLQ&offset=50", "/admin/observability/infrastructure/nats?stream=MAIL_DLQ&offset=50"],
  ["/admin/observability/nats/access", "/admin/observability/infrastructure/nats-access"],
];

if (process.env.GATEWAY_MOVED_PAGES_CHILD !== "1") {
  test("every moved page's old address leads to its new place with its query", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, GATEWAY_MOVED_PAGES_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const { auth } = await import("@k2b/cloud/server");
  const { prepareNoTransformRouterTest } = await import("../../../scripts/fixtures/no-transform");
  prepareNoTransformRouterTest();
  const requireRole = spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  const { router } = await import("./router");
  for (const [old, moved] of MOVED_PAGES)
    test(`${old} moved`, async () => {
      const response = await router.request(old);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(moved);
    });
  test("the moved pages and their redirects still require the admin role", () => {
    const roles = requireRole.mock.calls.map((call) => call[0]);
    expect(roles.filter((role) => role === "admin").length).toBeGreaterThanOrEqual(MOVED_PAGES.length * 2);
  });
}
