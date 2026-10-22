import { expect, test } from "bun:test";
import { browserName } from "../../../ui/test/browser";

// The island plugin owns its child process so SSR IDs and browser bundles agree.
if (process.env.MAIL_SHELL_BROWSER_CHILD === "1") {
  const { defineMailShellTests } = await import("./mail-shell.browser-suite");
  defineMailShellTests(process.env.MAIL_SHELL_SCREENSHOTS);
} else {
  // Three children, so each stays well inside its time budget in WebKit: the geometry matrix, wide windows, and the rest.
  const GEOMETRY = "server = hydrated = settled";
  const WIDE = "Mail wide windows";
  for (const [name, pattern] of [
    ["geometry", `^(?!.*${WIDE}).*${GEOMETRY}`],
    ["wide windows", WIDE],
    ["behavior", `^(?!.*(${GEOMETRY}|${WIDE}))`],
  ] as const) {
    test(`Mail SSR shell ${name} in ${browserName}`, async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", pattern], {
        env: { ...process.env, MAIL_SHELL_BROWSER_CHILD: "1" },
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
    }, 300_000);
  }
}
