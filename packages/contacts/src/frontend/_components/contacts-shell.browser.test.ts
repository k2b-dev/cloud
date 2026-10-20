import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserName } from "../../../../ui/test/browser";

// The island plugin owns its child process so SSR IDs and browser bundles agree.
if (process.env.CONTACTS_SHELL_BROWSER_CHILD === "1") {
  const { contactsShellSuite } = await import("./contacts-shell.browser-suite");
  await contactsShellSuite(process.env.CONTACTS_SHOTS_DIR);
} else {
  test(`Contacts workspace behaves in ${browserName}`, async () => {
    // Contacts' render-test preload installs a different SSR plugin. Disable it
    // only in this isolated child so the suite owns compilation and bundle IDs.
    const directory = mkdtempSync(join(tmpdir(), "contacts-shell-config-"));
    const config = join(directory, "bunfig.toml");
    writeFileSync(config, "[test]\npreload = []\n");
    try {
      const child = Bun.spawn([process.execPath, `--config=${config}`, "test", import.meta.path], {
        env: { ...process.env, CONTACTS_SHELL_BROWSER_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
      // A child that ran no test must not pass.
      expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300_000);
}
