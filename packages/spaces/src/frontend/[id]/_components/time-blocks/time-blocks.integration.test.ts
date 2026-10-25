import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../../../scripts/fixtures/test-infra";

// Integration naming keeps this real-API browser regression in CI's database job.
// The SSR plugin needs its own process, as in calendar-tray.browser.test.ts.
if (process.env.SPACES_TIME_BLOCK_BROWSER_CHILD === "1") {
  await import("./time-blocks.browser-suite");
} else {
  databaseSuite()("Time block browser regression against the real Spaces API (#1701)", () => {
    test("runs the SSR islands with real authorization and persistence", async () => {
      // Bun --bail exits before suite teardown; the child stops later cases itself so all fixture hooks run.
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, SPACES_TIME_BLOCK_BROWSER_CHILD: "1" },
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
  });
}
