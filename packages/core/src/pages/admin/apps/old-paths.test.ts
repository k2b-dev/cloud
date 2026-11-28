import { expect, spyOn, test } from "bun:test";

// Moved admin pages keep their addresses: App credentials moved into each app's keys, the app bar into Apps, and
// `/admin` opens the operations overview or Apps.
// Admission is replaced only inside a child process, so the package's other suites keep the real middleware.
if (process.env.CORE_OLD_PATHS_CHILD !== "1") {
  test("the old App credentials address opens the Apps page with its hint", async () => {
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
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/apps?moved=credentials");
    // The app bar's shortcuts became the section Navigation of Apps; the address keeps its parameters.
    const rail = await pages.request("/admin/rail?shortcut=new&from=help");
    expect(rail.status).toBe(302);
    expect(rail.headers.get("Location")).toBe("/admin/apps/navigation?shortcut=new&from=help");
    // `/admin` has no page of its own; without Gateway Ops it opens Apps, and an old link keeps its parameters
    const start = await pages.request("/admin?from=mail");
    expect(start.status).toBe(302);
    expect(start.headers.get("Location")).toBe("/admin/apps?from=mail");
  });
}
