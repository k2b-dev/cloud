import { expect, spyOn, test } from "bun:test";

// The apps table moved to Administration › Apps; its old address keeps working and says where it is now.
// Admission is replaced only inside a child process, so the package's other suites keep the real middleware.
if (process.env.GATEWAY_OLD_PATHS_CHILD !== "1") {
  test("the old Gateway › Apps address opens Administration › Apps with its hint", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, GATEWAY_OLD_PATHS_CHILD: "1" },
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
  spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  const { router } = await import("./router");
  test("redirect", async () => {
    const response = await router.request("/admin/observability/gateway");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/apps?moved=gateway");
  });
}
