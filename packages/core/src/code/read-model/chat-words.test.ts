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
  expect(words.examples?.items[1]?.sentence).toBe("Weicht von dem ab, was Gustav für dieses Beispiel erwartet hat.");
  expect(words.examples?.explanation).toContain("Nichts davon passiert wirklich.");
  expect(words.examples?.items[1]?.differences[0]?.subject).toBe("Aufrufe");
  expectNoCode(words);
});

test("checker findings read as a sentence with its consequence; rights by action and target name, marked when new", () => {
  const titles: Record<string, string> = { "spaces.task.create": "Aufgabe anlegen", "spaces.task.read": "Aufgabe lesen" };
  const words = describeCodeCheckWords(
    {
      diagnostics: [{ code: "code_unresolved_call" }],
      warnings: [{ code: "code_route_unchecked" }],
      permissions: [
        { operation: "spaces.task.create", title: "Logistik", typeTitle: "Space", status: "new" },
        { operation: "spaces.task.read", title: "Logistik", typeTitle: "Space", status: "existing" },
        { operation: "spaces.task.create", title: "Logistik", typeTitle: "Space", status: "new" },
        { operation: "mail.secret", title: null, typeTitle: null, status: "existing" },
      ],
    },
    "de",
    (id) => titles[id],
  );
  expect(CodeChatStepWordsSchema.parse(words)).toEqual(words);
  expect(words.notices.map((notice) => notice.severity)).toEqual(["block", "warning"]);
  for (const notice of words.notices) {
    expect(notice.text.length).toBeGreaterThan(0);
    expect(notice.consequence.length).toBeGreaterThan(0);
  }
  expect(words.mayDo).toEqual([
    { text: "Aufgabe anlegen · Logistik", isNew: true },
    { text: "Aufgabe lesen · Logistik", isNew: false },
    { text: "Nicht verfügbare Aktion", isNew: false },
  ]);
  expectNoCode(words);
});

test("a finding the checker reports once per page reads once (P6 v01: two pages without a check)", () => {
  for (const locale of ["de", "en"]) {
    const words = describeCodeCheckWords(
      { diagnostics: [], warnings: [{ code: "code_route_unchecked" }, { code: "code_route_unchecked" }], permissions: [] },
      locale,
    );
    expect(words.notices).toHaveLength(1);
    expect(words.notices[0]?.text).toBe(
      locale === "de" ? "Diese Seite prüft die angemeldete Person nicht." : "This page does not check the signed-in person.",
    );
  }
});

test("a run that never got to its examples says so with its consequence", () => {
  const words = describeCodeTestWords(
    { version: 1, mode: "test", ok: false, error: "code_test_runner_unavailable", diagnostics: [], cases: [] } as unknown as CodeTestResult,
    "de",
  );
  expect(words.examples).toBeUndefined();
  expect(words.notices).toEqual([
    {
      severity: "warning",
      text: "Die Beispiele konnten nicht laufen.",
      consequence: "An der Automation hat sich nichts geändert; Gustav kann sie noch einmal ausprobieren.",
    },
  ]);
});
