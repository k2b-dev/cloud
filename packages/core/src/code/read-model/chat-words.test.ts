import { expect, test } from "bun:test";
import type { CodeTestResult } from "@k2b/cloud/code";
import { CodeChatStepWordsSchema } from "../authoring-contracts";
import { describeCodeCheckWords, describeCodeTestWords } from "./chat-words";

/** What the code-no-source rule forbids in anything a person reads. */
const technical = [/\bcode\.tsx?\b/i, /\.[a-z]{1,8}:\d+/i, /\bcode_[a-z_]+\b/, /\bsp_[a-z0-9]+\b/i, /\$\.calls\b/, /\btest\/\S+\.json\b/];
const expectNoCode = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const pattern of technical) expect(text).not.toMatch(pattern);
};

const result: CodeTestResult = {
  version: 1,
  mode: "test",
  ok: false,
  error: "code_test_failed",
  diagnostics: [],
  cases: [
    {
      name: "Delivery note with attachment",
      file: "test/with-attachment.json",
      ok: true,
      runs: [
        {
          entrypoint: "incoming",
          ok: true,
          error: null,
          value: null,
          calls: [{ operation: "spaces.task.create", input: { space: "sp_hidden" }, result: { ok: true, value: null } }],
          failures: [],
        },
      ],
    },
    {
      name: "Delivery note without attachment",
      file: "test/without.json",
      ok: false,
      runs: [
        {
          entrypoint: "incoming",
          ok: true,
          error: null,
          value: null,
          calls: [{ operation: "files.file.write", input: { path: "code.ts:3" }, result: { ok: true, value: null } }],
          failures: ["$.calls"],
          differences: [{ path: "calls", expected: JSON.stringify([]), actual: JSON.stringify(["files.file.write"]) }],
        },
      ],
    },
  ],
} as unknown as CodeTestResult;

test("tried examples read as names, result words and counted effects, never as files, paths or inputs", () => {
  const titles: Record<string, string> = { "spaces.task.create": "Aufgabe anlegen", "files.file.write": "Datei ablegen" };
  const words = describeCodeTestWords(result, "de", (id) => titles[id] ?? "Aufruf");
  expect(CodeChatStepWordsSchema.parse(words)).toEqual(words);
  expect(words.examples?.summary).toBe("1 von 2 Beispielen erfolgreich");
  expect(words.examples?.items.map((item) => [item.name, item.status])).toEqual([
    ["Delivery note with attachment", "Erfolgreich"],
    ["Delivery note without attachment", "Fehlgeschlagen"],
  ]);
  expect(words.examples?.items[0]?.sentence).toBe("Aufgabe anlegen · 1 im Beispiel erfolgreich");
  expect(words.examples?.items[1]?.sentence).toBe("Weicht von der Erwartung ab");
  expect(words.examples?.items[1]?.differences[0]?.subject).toBe("Aufrufe");
  expectNoCode(words);
});

test("checker findings read as a sentence with its consequence; rights by their titles, marked when new", () => {
  const words = describeCodeCheckWords(
    {
      diagnostics: [{ code: "code_unresolved_call" }],
      warnings: [{ code: "code_route_unchecked" }],
      permissions: [
        { title: "Aufgabe anlegen", typeTitle: "Space", status: "new" },
        { title: "Aufgabe anlegen", typeTitle: "Space", status: "new" },
        { title: null, typeTitle: null, status: "existing" },
      ],
    },
    "de",
  );
  expect(CodeChatStepWordsSchema.parse(words)).toEqual(words);
  expect(words.notices.map((notice) => notice.severity)).toEqual(["block", "warning"]);
  for (const notice of words.notices) {
    expect(notice.text.length).toBeGreaterThan(0);
    expect(notice.consequence.length).toBeGreaterThan(0);
  }
  expect(words.mayDo).toEqual([
    { text: "Aufgabe anlegen · Space", isNew: true },
    { text: "Nicht verfügbare Aktion", isNew: false },
  ]);
  expectNoCode(words);
});
