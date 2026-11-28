import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// The v2 access entry must not pull v1 UI along: a value import of a v1 component (the root `@k2b/ui` with its Button,
// PanelDialog, Avatar …) anywhere in its import graph puts v1 into every v2 page that uses `@k2b/cloud/access/v2`, and
// Solid's JSX modules have side effects, so the bundler keeps them. The check walks the whole graph from the entry,
// through every relative value import, and fails on any v1 component import it meets. Types may come from anywhere.

const entries = [resolve(import.meta.dir, "v2.tsx")];
const cloudSrc = resolve(import.meta.dir, "..");

/** What the root `@k2b/ui` may give a v2 module: headless helpers, no component. */
const allowedRootUi = new Set(["useLocale", "LocaleProvider", "formatShortcut", "keyboardPlatform", "announce", "prefersReducedMotion"]);

type Import = { specifier: string; names: string[] };

/** The value imports and re-exports of a module: `import type`, `export type` and `type` names do not count. */
const valueImports = (source: string): Import[] =>
  [...source.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";|^import\s+"([^"]+)";/gms)].flatMap((match) => {
    if (match[5]) return [{ specifier: match[5], names: [] }];
    if (match[2]) return [];
    const clause = match[3]!;
    const braces = /\{([^}]*)\}/.exec(clause)?.[1];
    const named = (braces ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name && !name.startsWith("type "))
      .map((name) => name.split(/\s+as\s+/)[0]!.trim());
    const outside = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, " ")
      .trim();
    const names = [...named, ...(outside ? [outside] : [])];
    return names.length > 0 ? [{ specifier: match[4]!, names }] : [];
  });

const resolveLocal = (from: string, specifier: string): string | undefined => {
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((path) =>
    statSync(path, { throwIfNoEntry: false })?.isFile(),
  );
};

/** Every v1 component import reachable from the entries, as `module -> what`. */
const v1Imports = (): string[] => {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, names } of valueImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = resolveLocal(file, specifier);
        if (target && !target.endsWith(".css")) queue.push(target);
      } else if (specifier === "@k2b/ui") {
        const components = names.filter((name) => !allowedRootUi.has(name));
        if (components.length > 0) found.push(`${relative(cloudSrc, file)} -> @k2b/ui { ${components.join(", ")} }`);
      }
    }
  }
  return found;
};

test("the v2 access entry reaches no v1 component through its whole import graph", () => {
  expect(v1Imports()).toEqual([]);
});

test("the walk sees value imports and ignores types", () => {
  expect(valueImports('import { Button, useLocale } from "@k2b/ui";')).toEqual([{ specifier: "@k2b/ui", names: ["Button", "useLocale"] }]);
  expect(valueImports('import type { AvatarProps } from "@k2b/ui";')).toEqual([]);
  expect(valueImports('import { type AvatarProps } from "@k2b/ui";')).toEqual([]);
  expect(valueImports('import Section, { line } from "./Section";')).toEqual([{ specifier: "./Section", names: ["line", "Section"] }]);
  expect(valueImports('export { AccessSummaryV2 as AccessSummary } from "./AccessSummaryV2";')).toEqual([
    { specifier: "./AccessSummaryV2", names: ["AccessSummaryV2"] },
  ]);
  expect(valueImports('export type { AccessSummaryProps } from "./access-summary";')).toEqual([]);
});
