import { expect, test } from "bun:test";
import { join } from "node:path";
import { assistantCopyFor, missingAssistantGermanText } from "./frontend/ui-copy";

/**
 * People see scheduled Assistant tasks as routines (Routinen). Stable codes such as `core.ai.task`,
 * `/api/ai/tasks`, and `cld assistant tasks` keep "task"; this guard covers only the words people read.
 */
const replacedTerms = [
  /\bscheduled[ -](?:AI |Assistant |chat )?tasks?\b/i,
  /\bgeplante[nrs]? (?:KI-|Chat-)?Aufgaben?\b/i,
  /\b(?:KI|Chat)-Aufgaben?\b/i,
];

const catalogs = ["frontend/ui-copy.ts", "frontend/chat-sidebar-messages.ts", "frontend/messages.ts", "artifacts/messages.ts"];

/** Every quoted or template string in a source file: the text a catalog can show, without code comments. */
const stringLiterals = (source: string): string[] =>
  [...source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs)].map((match) => match[2] ?? "").filter(Boolean);

const offending = (texts: Iterable<string>): string[] => [...texts].filter((value) => replacedTerms.some((term) => term.test(value)));

test("Assistant catalogs and UI strings no longer call routines scheduled tasks", async () => {
  const found: string[] = [];
  for (const path of catalogs) found.push(...offending(stringLiterals(await Bun.file(join(import.meta.dir, path)).text())));
  for await (const path of new Bun.Glob("frontend/**/*.{ts,tsx}").scan({ cwd: import.meta.dir })) {
    if (path.includes(".test.")) continue;
    const source = await Bun.file(join(import.meta.dir, path)).text();
    found.push(
      ...offending([...source.matchAll(/\b(?:text|assistantBrowserText|contextText)\(\s*(["'])(.*?)\1/g)].map((match) => match[2] ?? "")),
    );
  }
  expect(found).toEqual([]);
});

test("Assistant help in English and German no longer calls routines scheduled tasks", async () => {
  const found: string[] = [];
  for await (const path of new Bun.Glob("help/documents/{de,en}/*.md").scan({ cwd: import.meta.dir })) {
    const lines = (await Bun.file(join(import.meta.dir, path)).text()).split("\n");
    found.push(...offending(lines).map((line) => `${path}: ${line}`));
  }
  expect(found).toEqual([]);
});

test("every English UI string that names a routine has a German translation without Aufgabe", async () => {
  const german = assistantCopyFor("de");
  const values = new Set<string>();
  for await (const path of new Bun.Glob("frontend/**/*.{ts,tsx}").scan({ cwd: import.meta.dir })) {
    if (path.includes(".test.")) continue;
    const source = await Bun.file(join(import.meta.dir, path)).text();
    for (const match of source.matchAll(/\b(?:text|assistantBrowserText|contextText)\(\s*(["'])(.*?)\1/g))
      if (/\broutines?\b/i.test(match[2] ?? "")) values.add(match[2]!);
  }
  expect(values.size).toBeGreaterThan(5);
  expect(missingAssistantGermanText(values)).toEqual([]);
  expect([...values].filter((value) => /Aufgabe/i.test(german.text({ value })))).toEqual([]);
});
