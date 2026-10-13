import { expect, test } from "bun:test";
import { browserName } from "../../../ui/test/browser";

// Keep this app's SSR plugin and island IDs isolated from other test apps.
if (process.env.CLOUD_ISLAND_PROPS_CSP_BROWSER_CHILD === "1") {
  await import("./island-props-csp.browser-suite");
} else {
  test(`Cloud mounts JSON props without unsafe-eval in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CLOUD_ISLAND_PROPS_CSP_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 300_000);
}
