import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { browserName } from "../../../../../ui/test/browser";

// Register the fixture's island root outside the package's SSR preload.
if (process.env.GRIDS_MACHINE_AUTHORITY_BROWSER_CHILD === "1") {
  await import("./machine-authority.browser-suite");
} else {
  test(`machine execution authority supports keyboard, conflict recovery and phone dark mode in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
      cwd: resolve(import.meta.dir, "../../../../../.."),
      env: { ...process.env, GRIDS_MACHINE_AUTHORITY_BROWSER_CHILD: "1" },
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
