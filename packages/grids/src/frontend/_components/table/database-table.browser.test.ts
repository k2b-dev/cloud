import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { browserName } from "../../../../../ui/test/browser";

// Run at the workspace root so Grids' render-test preload cannot transform the fixture
// with a different island root before this suite registers its own plugin.
if (process.env.GRIDS_TABLE_BROWSER_CHILD === "1") {
  await import("./database-table.browser-suite");
} else {
  test(`the Grids table fits beside Detail in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: resolve(import.meta.dir, "../../../../../.."),
      env: { ...process.env, GRIDS_TABLE_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 180_000);
}
