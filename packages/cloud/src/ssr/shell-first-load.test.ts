import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { staticImportClosure } from "../../../../scripts/fixtures/island-closure";

test("shell islands and browser helpers keep Zod out of static imports", async () => {
  const islands = [...new Bun.Glob("*.island.tsx").scanSync({ cwd: import.meta.dir, absolute: true })];
  expect(islands.length).toBeGreaterThan(0);
  const closure = await staticImportClosure([
    ...islands,
    ...["live.ts", "commands.ts", "files.tsx"].map((file) => resolve(import.meta.dir, "../browser", file)),
  ]);
  const zod = closure.filter((path) => path.includes("node_modules/zod"));
  if (zod.length > 0) {
    const importers = [];
    for (const path of closure.filter((path) => !path.includes("node_modules"))) {
      if (/import\s+(?!type\b)[^;]*\bfrom\s+["']zod(?:\/[^"']*)?["']/.test(await Bun.file(path).text())) importers.push(path);
    }
    throw new Error(`Zod reached the first load through:\n${importers.join("\n")}\nZod inputs:\n${zod.join("\n")}`);
  }
}, 30_000);

test("the visible shell and runtime load panels only on open", async () => {
  const closure = await staticImportClosure([
    resolve(import.meta.dir, "CloudShell.island.tsx"),
    resolve(import.meta.dir, "ShellRuntime.island.tsx"),
  ]);
  for (const file of [
    "browser/panel-slot.ts",
    "ssr/AppLaunchpadPanel.tsx",
    "ssr/MobileNavigation.tsx",
    "ssr/launchpad-surface.tsx",
    "ssr/LayoutHelp.tsx",
    "ssr/GlobalSearchDialog.tsx",
    "ssr/RailEditor.tsx",
    "ssr/announcements-dialog.tsx",
    // Only sign-out and the push refresh after mount use them.
    "browser/notifications.ts",
    "clients/core.ts",
  ]) {
    expect(closure.map((path) => resolve(path))).not.toContain(resolve(import.meta.dir, "..", file));
  }
}, 30_000);
