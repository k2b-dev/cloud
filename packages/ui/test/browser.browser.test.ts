import { expect, test } from "bun:test";
import { browserName } from "../test/browser";

if (process.env.UI_BROWSER_RECOVERY_CHILD === "1") {
  await import("./browser-recovery.browser-suite");
} else {
  test(`the shared ${browserName} browser recovers after a test times out`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, UI_BROWSER_RECOVERY_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `${stdout}\n${stderr}`;
    // A piped `bun test` lists only failing tests by name; the summary counts the passing ones.
    const failed = Array.from(output.matchAll(/^\(fail\) (.*?) \[[^\]\r\n]*\]\r?$/gm), (match) => match[1]);
    const passed = Number(/^ (\d+) pass\r?$/m.exec(output)?.[1] ?? 0);
    expect({ code, failed, passed }, output).toEqual({ code: 1, failed: ["a test that hangs waiting on its page"], passed: 3 });
    if (!process.env.TEST_BROWSER_ENDPOINT?.trim()) {
      // Prove Bun killed the local browser. If Bun stops killing subprocesses,
      // revisit the launcher comment about timeout cleanup.
      expect(output).toMatch(/killed \d+ dangling process/);
      // The hung step rejects after the timeout. Its error names what it waited for, not a failed close in the
      // test's cleanup (#1355).
      expect(output).toContain("waiting for locator('#never')");
      expect(output).not.toContain("close: Target page, context or browser has been closed");
    }
  }, 60_000);
}
