import { describe, expect, it, mock } from "bun:test";

const defineSsrTests = () => {
  it("does not load or subscribe during server rendering", async () => {
    const [{ renderToString }, { query }] = await Promise.all([
      import("solid-js/web"),
      import("./query"),
    ]);
    const load = mock(async () => "loaded");
    const subscribe = mock(() => mock(() => {}));

    renderToString(() => {
      const result = query.create({
        source: () => "/items",
        load,
        subscribe,
      });
      return result.loading() ? "loading" : "ready";
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(load).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
};

if (process.env.STDLIB_QUERY_SSR_TESTS === "1") {
  defineSsrTests();
} else {
  describe("query SSR suite", () => {
    it("passes with isolated SolidJS server conditions", async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STDLIB_QUERY_SSR_TESTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Query SSR tests failed:\n${stdout}\n${stderr}`);
      }
    });
  });
}
