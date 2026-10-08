import { expect, test } from "bun:test";
import { browserName } from "../../../ui/test/browser";

// The suite registers the SSR island plugin for its whole process and serves the
// bundles next to this file. Run alone, no other test file's plugin can render its
// islands first with IDs the browser bundles do not know.
if (process.env.CLOUD_ISLAND_ERRORS_BROWSER_CHILD === "1") {
  await import("./island-errors.browser-suite");
} else {
  test(`a failing island shows Cloud's fallback in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CLOUD_ISLAND_ERRORS_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 300_000);
}
