import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function openingTags(source: string) {
  const tags: { text: string; index: number }[] = [];
  for (const match of source.matchAll(/<[A-Za-z][\w.]*/g)) {
    let depth = 0;
    let quote = "";
    for (let end = match.index + match[0].length; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === "\\") end += 1;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        tags.push({ text: source.slice(match.index, end + 1), index: match.index });
        break;
      }
    }
  }
  return tags;
}

function scan(source: string, file: string) {
  const violations: string[] = [];
  const report = (index: number, rule: string) => violations.push(`${file}:${source.slice(0, index).split("\n").length}: ${rule}`);
  const rules = [
    [/\btype\s*=\s*["']checkbox["']/g, "Use the shared Checkbox"],
    [/\bfocus-ui\b/g, "UI-01: use IconButton/IconButtonLink/Button or documented --k2b-focus-* tokens"],
    [/(?<![\w-])border-[lt](?:-\[[^\]]+\]|-[\w]+)?(?![\w-])/g, "No app-drawn connector lines; indentation draws hierarchy"],
  ] as const;
  for (const [pattern, rule] of rules) {
    for (const match of source.matchAll(pattern)) report(match.index, rule);
  }
  for (const tag of openingTags(source)) {
    if (/\brole\s*=\s*["'](?:status|alert)["']/.test(tag.text) && /\b(?:text|bg|border)-(?:amber|red)-\d{2,3}\b/.test(tag.text)) {
      report(tag.index, "Use InlineGuidance or NoticeCard for status and alert rows");
    }
  }
  return violations;
}

function frontendFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? frontendFiles(path) : entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

test("Contacts frontend uses shared controls and feedback without connector lines", () => {
  const root = import.meta.dir;
  const violations = frontendFiles(root).flatMap((file) => scan(readFileSync(file, "utf8"), relative(join(root, "../../../.."), file)));
  expect(violations, violations.join("\n")).toEqual([]);
});

test("scanner catches local controls and feedback while allowing shared usage", () => {
  const source = [
    '<input type="checkbox" />',
    '<a class="focus-ui" />',
    '<div class="text-amber-700" onClick={() => x} role="status">',
    '<div role="alert" class={`bg-red-100 ${x ? "border-red-600" : ""}`} onClick={() => ({ x: ">" })}>',
    '<span class="border-l border-t border-l-2" />',
  ].join("\n");
  expect(scan(source, "fixture.tsx")).toEqual([
    "fixture.tsx:1: Use the shared Checkbox",
    "fixture.tsx:2: UI-01: use IconButton/IconButtonLink/Button or documented --k2b-focus-* tokens",
    ...Array(3).fill("fixture.tsx:5: No app-drawn connector lines; indentation draws hierarchy"),
    "fixture.tsx:3: Use InlineGuidance or NoticeCard for status and alert rows",
    "fixture.tsx:4: Use InlineGuidance or NoticeCard for status and alert rows",
  ]);
  expect(
    scan(
      '<InlineGuidance tone="danger" role="alert" /><Checkbox aria-label="x" /><div class="border-[var(--ui-divider)] rounded-l hover:text-red-600" />',
      "shared.tsx",
    ),
  ).toEqual([]);
});
