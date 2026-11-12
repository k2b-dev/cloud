import { expect, spyOn, test } from "bun:test";

// The retired token-management page has no replacement route.
// Admission is replaced only inside a child process, so the package's other suites keep the real middleware.
if (process.env.CORE_OLD_PATHS_CHILD !== "1") {
  test("the retired credentials address is absent", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CORE_OLD_PATHS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const { auth, middleware } = await import("@k2b/cloud/server");
  const { Hono } = await import("hono");
  const { prepareNoTransformRouterTest } = await import("../../../../../../scripts/fixtures/no-transform");
  prepareNoTransformRouterTest();
  spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  const { createPagesRouter } = await import("../../create");
  const pages = new Hono().use("*", middleware.runtime()).use("*", middleware.settings()).route("/", createPagesRouter());
  test("redirect", async () => {
    const response = await pages.request("/admin/app-credentials");
    expect(response.status).toBe(404);
  });
}
