import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The v2 access entry must not pull the v1 components along: a value import from a v1 module puts its v1 UI (and its
// v1 dependencies) into every v2 page that uses `@k2b/cloud/access/v2`. Types may come from anywhere.
const v2Modules = [
  "v2.tsx",
  "AccessDialogV2.tsx",
  "AccessSummaryV2.tsx",
  "PermissionEditorV2.tsx",
  "ResourceApiKeysV2.tsx",
  "access-dialog-state.ts",
  "access-summary.ts",
  "permission-editor-state.ts",
  "permission-levels.ts",
  "principal-face.ts",
  "principal-search.ts",
  "group-coverage.ts",
];
const v1Modules = [
  "./PermissionEditor",
  "./AccessDialog",
  "./AccessSummary",
  "./PrincipalPicker",
  "./ResourceApiKeys",
  "./GroupCoverage",
  "./AccessRow",
];

/** The modules a file imports values from: `import type`, `export type` and braces of only `type` names do not count. */
const valueImports = (source: string): string[] =>
  [...source.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gms)].flatMap((match) => {
    if (match[2]) return [];
    const braces = /\{([^}]*)\}/.exec(match[3]!)?.[1];
    const names =
      braces
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? [];
    const onlyTypes = braces !== undefined && !/^[^{]*\w[^{]*\{/.test(match[3]!) && names.every((name) => name.startsWith("type "));
    return onlyTypes ? [] : [match[4]!];
  });

test("the v2 access modules import no value from a v1 access module", () => {
  const offending = v2Modules.flatMap((file) =>
    valueImports(readFileSync(resolve(import.meta.dir, file), "utf8"))
      .filter((specifier) => v1Modules.includes(specifier))
      .map((specifier) => `${file} -> ${specifier}`),
  );
  expect(offending).toEqual([]);
});

test("the check sees a value import and ignores a type import", () => {
  expect(valueImports('import { levelKey } from "./PermissionEditor";')).toEqual(["./PermissionEditor"]);
  expect(valueImports('import type { PermissionEditorProps } from "./PermissionEditor";')).toEqual([]);
  expect(valueImports('import { type ResolvedLevel } from "./PermissionEditor";')).toEqual([]);
  expect(valueImports('export type { AccessSummaryProps } from "./access-summary";')).toEqual([]);
  expect(valueImports('export { AccessSummaryV2 as AccessSummary } from "./AccessSummaryV2";')).toEqual(["./AccessSummaryV2"]);
});
