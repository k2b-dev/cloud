import { expect, spyOn, test } from "bun:test";

// The apps table moved to Administration › Apps; its old address keeps working and says where it is now.
// Admission is replaced only inside a child process, so the package's other suites keep the real middleware.
if (process.env.GATEWAY_OLD_PATHS_CHILD !== "1") {
  test("old addresses (Gateway › Apps, Jobs, Deliveries) lead to their new places with their query", async () => {
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
  // Jobs and the deliveries view became the runs list: their addresses lead there with the same filters.
  const moved: [string, string][] = [
    ["/admin/observability/jobs", "/admin/observability/runs?kind=job"],
    ["/admin/observability/jobs?search=grids", "/admin/observability/runs?kind=job&q=grids"],
    [
      "/admin/observability/jobs?window=7d&health=failed&run=aa:bb",
      "/admin/observability/runs?kind=job&time=last-7d&status=failed&run=job:aa:bb",
    ],
    ["/admin/observability/deliveries", "/admin/observability/runs?kind=delivery"],
    ["/admin/observability/deliveries?status=failed&apps=mail", "/admin/observability/runs?kind=delivery&status=failed&app=mail"],
  ];
  for (const [from, to] of moved)
    test(`${from} → ${to}`, async () => {
      const response = await router.request(from);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(to);
    });
}
