import { expect, test } from "bun:test";
import { browserName } from "../../../../../../ui/test/browser";

// The SSR island plugin must own its process so fixture IDs match the browser bundles.
if (process.env.SPACES_WORKSPACE_STEP_BROWSER_CHILD === "1") {
  await import("./workspace-step.browser-suite");
} else {
  test(`Spaces detail stepping behaves in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SPACES_WORKSPACE_STEP_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 300_000);
}
