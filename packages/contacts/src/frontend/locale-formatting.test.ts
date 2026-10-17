import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

test("Contacts uses shared locale formatters (I18N-05)", () => {
  const root = resolve(import.meta.dir, "..");
  const violations: string[] = [];
  // toLocale*String formats in the runtime's zone and locale, so a date-only value can shift a day and
  // SSR and the browser can disagree. User-facing values go through Format.* / the shared formatters (I18N-05).
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__fixtures__" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (/\.toLocale(Date|Time)?String\(/.test(line)) violations.push(`src/${relative(root, path)}:${index + 1}`);
          });
      }
    }
  };
  walk(root);
  expect(violations, violations.join("\n")).toEqual([]);
});
