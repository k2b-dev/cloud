import { expect, test } from "bun:test";
import { browserName } from "../../../../../../ui/test/browser";

// The suite registers the SSR island plugin for its whole process. Run alone, no other test file's
// plugin can transform its fixture first and give the island an ID the browser bundle does not know.
if (process.env.SPACES_CALENDAR_TRAY_BROWSER_CHILD === "1") {
  await import("./calendar-tray.browser-suite");
} else {
  test(`the task tray below the day view behaves in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SPACES_CALENDAR_TRAY_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 180_000);
}
