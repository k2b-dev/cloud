import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { browserName } from "../../../../ui/test/browser";

// The workspace-root child avoids Grids' render-test preload registering a different island root.
if (process.env.GRIDS_CHART_TOOLTIPS_BROWSER_CHILD === "1") {
  await import("./chart-tooltips.browser-suite");
} else {
  test(`Grids custom-app charts support inspection and preserve SSR layout in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: { ...process.env, GRIDS_CHART_TOOLTIPS_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  }, 180_000);
}
