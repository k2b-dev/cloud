import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";

// The closing contacts-feedback-books slice must empty this list.
const PENDING = new Set(["BookSettingsForm.tsx", "create-book.ts", "DeleteBookButton.tsx", "BookActions.tsx"]);
const ALLOWED = [
  { file: "ContactsBulkActions.tsx", key: "contactsMoved", reason: "contacts left the view" },
  { file: "ContactsBulkActions.tsx", key: "contactsDeleted", reason: "contacts left the view" },
  { file: "ContactUpsertForm.tsx", key: "contactDeleted", reason: "contact left the view" },
];

const root = import.meta.dir;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
});

test("Contacts uses one feedback channel for each outcome (#1235)", () => {
  const violations: string[] = [];
  for (const path of files(root)) {
    const file = path.split("/").at(-1)!;
    if (PENDING.has(file)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/prompts\.error\s*\(|toast\.success\s*\(([^;]+);/g)) {
      if (match[0].startsWith("toast.success") && ALLOWED.some((entry) => entry.file === file && new RegExp(`\\b${entry.key}\\b`).test(match[0]))) continue;
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${relative(root, path)}:${line}: ${match[0].split("\n")[0]}`);
    }
  }
  expect(violations).toEqual([]);
});
