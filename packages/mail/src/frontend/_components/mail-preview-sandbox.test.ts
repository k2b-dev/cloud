import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// A mail preview shows the person's draft with quoted, foreign mail HTML. It stays in an opaque sandbox: an iframe
// with `allow-same-origin` would give that HTML Cloud's origin, so one later `allow-scripts` would be a full escape.
// The reader frame may run its own script, never with the page's origin.
const frontend = resolve(import.meta.dir, "..");
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.(test|browser-harness)\.tsx$/.test(entry.name) ? [path] : [];
  });
const sandboxes = sources(frontend).flatMap((path) =>
  [...readFileSync(path, "utf8").matchAll(/sandbox=("[^"]*"|\{[^}]*\})/g)].map((match) => ({
    file: relative(frontend, path),
    value: match[1]!,
  })),
);

describe("Mail preview frames", () => {
  test("no Mail frame shares the page's origin", () => {
    expect(sandboxes.length).toBeGreaterThan(0);
    expect(sandboxes.filter((frame) => frame.value.includes("allow-same-origin"))).toEqual([]);
  });

  test("the composer previews stay fully sandboxed", () => {
    for (const file of ["_components/MailComposerLarge.tsx", "_components/MailComposerEditor.tsx"]) {
      const values = sandboxes.filter((frame) => frame.file === file).map((frame) => frame.value);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((value) => value === '""')).toBe(true);
    }
  });
});
