import { describe, expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { workStepLine, workStepParts, workSummary } from "./work-summary";

test("a thinking step counts without needing its model text", () => {
  const blocks: AiTurnBlock[] = [{ id: "thought", kind: "thinking", text: "" }];
  expect(workStepParts(blocks, 0, "de").count).toBe("1 Schritt");
  expect(workStepParts(blocks, 0, "en").count).toBe("1 step");
});

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
const tool = (name: string, result: unknown = {}, args: unknown = { codeId: "automation-a" }, extra: Partial<Tool> = {}): Tool => ({
  id: name,
  kind: "tool",
  callId: name,
  name,
  status: "completed",
  args,
  result,
  ...extra,
});

const examples = (passed: number, total: number) => ({
  ok: passed === total,
  words: {
    notices: [],
    examples: {
      passed,
      total,
      summary: "Summary is data, not the work sentence",
      explanation: "Erfolgreich heißt: Die Automation hat getan, was Gustav für den Fall erwartet hat.",
      items: Array.from({ length: total }, (_, index) => ({
        name: `Beispiel ${index + 1}`,
        state: index < passed ? "succeeded" : "failed",
        status: index < passed ? "Erfolgreich" : "Abweichung",
        sentence: "Fiktives Ergebnis",
        differences: [],
      })),
    },
  },
});

const init = () => tool("code_init", { config: { codeId: "automation-a", baseVersionId: null } });
const write = () => tool("code_write");
const check = () => tool("code_check", { words: { mayDo: [{ text: "Aufträge lesen", isNew: false }] } });

describe("work summary from confirmed outcomes", () => {
  test("only reading an automation does not claim it was prepared", () => {
    expect(workSummary([tool("code_pull")], "de")).toBe("Automation gelesen");
    expect(workSummary([tool("code_read")], "en")).toBe("Opened the automation");
  });

  test("a new automation and an existing edit name their untried examples", () => {
    expect(workSummary([init(), write()], "de")).toBe("Automation vorbereitet, noch ohne Beispiele");
    expect(workSummary([tool("code_pull"), write()], "de")).toBe("Automation geändert, noch ohne Beispiele");
    expect(workSummary([write()], "en")).toBe("Changed the automation, no examples yet");
  });

  for (const passed of [3, 2, 0]) {
    test(`${passed} of 3 examples count failed examples too`, () => {
      expect(workSummary([init(), write(), tool("code_test", examples(passed, 3))], "de")).toBe(
        `Automation vorbereitet · ${passed} von 3 Beispielen erfolgreich`,
      );
    });
  }

  test("only the last test of the latest draft supplies numbers", () => {
    expect(workSummary([write(), tool("code_test", examples(3, 3)), tool("code_test", examples(0, 2))], "de")).toBe(
      "Automation geändert · 0 von 2 Beispielen erfolgreich",
    );
    expect(workSummary([write(), tool("code_test", examples(3, 3)), write()], "de")).toBe("Automation geändert, noch ohne Beispiele");
    expect(workSummary([write(), tool("code_test", examples(3, 3)), tool("code_pull")], "de")).toBe("Automation gelesen");
  });

  test("the current persisted test cases are evidence even before readable words are available", () => {
    const result = {
      ok: false,
      cases: [
        { name: "eins", ok: true },
        { name: "zwei", ok: false },
      ],
    };
    expect(workSummary([write(), tool("code_test", result)], "de")).toBe("Automation geändert · 1 von 2 Beispielen erfolgreich");
  });

  test("another automation cannot inherit examples or the prepared wording", () => {
    expect(workSummary([init(), tool("code_test", examples(3, 3)), tool("code_write", {}, { codeId: "automation-b" })], "de")).toBe(
      "Automation geändert, noch ohne Beispiele",
    );
  });

  test("a submitted replacement draft invalidates old examples", () => {
    expect(
      workSummary([write(), tool("code_test", examples(3, 3)), tool("code_submit", {}, { codeId: "automation-a", files: {} })], "de"),
    ).toBe("Noch ohne Beispiele, zur Freigabe eingereicht");
  });

  test("resending the tested files unchanged is not a newer draft", () => {
    const tested = { codeId: "automation-a", files: { "a.ts": "a", "b.ts": "b" }, entry: "a.ts" };
    const submitted = { codeId: "automation-a", files: { "b.ts": "b", "a.ts": "a" }, entry: "a.ts" };
    expect(workSummary([tool("code_test", examples(2, 3), tested), tool("code_submit", {}, submitted)], "de")).toBe(
      "2 von 3 Beispielen erfolgreich, zur Freigabe eingereicht",
    );
    expect(workSummary([tool("code_test", examples(2, 3), tested), tool("code_submit", {}, { ...submitted, entry: "b.ts" })], "de")).toBe(
      "Noch ohne Beispiele, zur Freigabe eingereicht",
    );
  });

  test("editing an already submitted new automation is a change", () => {
    expect(workSummary([init(), tool("code_submit"), write()], "de")).toBe("Automation geändert, noch ohne Beispiele");
  });

  test("the confirmed submission and current examples take priority over lower level work", () => {
    expect(workSummary([init(), write(), check(), tool("code_test", examples(2, 3)), tool("code_submit")], "de")).toBe(
      "2 von 3 Beispielen erfolgreich, zur Freigabe eingereicht",
    );
  });

  test("permission checking requires mayDo; inspection is not a permission check", () => {
    expect(workSummary([check()], "de")).toBe("Geprüft, was sie darf");
    expect(workSummary([tool("code_check")], "de")).toBe("Automation geprüft");
    expect(workSummary([tool("code_inspect", { status: "ok" })], "de")).not.toContain("was sie darf");
  });

  test("missing or invalid example evidence uses general words", () => {
    expect(workSummary([tool("code_test", { ok: true })], "de")).toBe("Automation geprüft");
    for (const [passed, total] of [
      [4, 3],
      [-1, 3],
      [1.5, 3],
      [0, 0],
    ] as const) {
      const result = examples(0, 3);
      result.words.examples.passed = passed;
      result.words.examples.total = total;
      expect(workSummary([tool("code_test", result)], "de")).toBe("Automation geprüft");
    }
  });

  test("a later test without example results cannot leave the earlier success count", () => {
    expect(workSummary([write(), tool("code_test", examples(3, 3)), tool("code_test", { ok: false })], "de")).toBe(
      "Automation geändert, noch ohne Beispiele",
    );
  });

  test("a test call that never returned keeps the count of the unchanged draft", () => {
    expect(
      workSummary(
        [write(), tool("code_test", examples(3, 3)), tool("code_test", "Connection lost", undefined, { status: "failed" })],
        "de",
      ),
    ).toBe("Automation geändert · 3 von 3 Beispielen erfolgreich");
  });

  test("a draft without a saved version is a new automation, even when it was started in an earlier answer", () => {
    const draft = (baseVersionId: string | null) => tool("code_write", { draft: { codeId: "automation-a", baseVersionId } });
    expect(workSummary([draft(null)], "de")).toBe("Automation vorbereitet, noch ohne Beispiele");
    expect(workSummary([draft("11111111-1111-4111-8111-111111111111")], "de")).toBe("Automation geändert, noch ohne Beispiele");
    const pulled = tool("code_pull", { config: { codeId: "automation-a", baseVersionId: null } });
    expect(workSummary([pulled], "de")).toBe("Automation gelesen");
    expect(workSummary([pulled, write()], "de")).toBe("Automation vorbereitet, noch ohne Beispiele");
  });

  test("a simulation that replaces the tested files makes the count stale; one with the same files keeps it", () => {
    const tested = { codeId: "automation-a", files: { "a.ts": "a" } };
    const blocks = [write(), tool("code_test", examples(3, 3), tested)];
    expect(workSummary([...blocks, tool("code_simulate", {}, { ...tested, files: { "a.ts": "b" } })], "de")).toBe(
      "Automation geändert, noch ohne Beispiele",
    );
    expect(workSummary([...blocks, tool("code_simulate", {}, tested)], "de")).toBe("Automation geändert · 3 von 3 Beispielen erfolgreich");
    expect(workSummary([tool("code_simulate")], "de")).toBe("");
  });

  test("calculation without a read is only calculation", () => {
    expect(workSummary([tool("code_run", { status: "completed", output: 42 })], "de")).toBe("Gerechnet");
    expect(workSummary([tool("code_run", { status: "completed", output: 42 })], "en")).toBe("Calculated");
  });

  test("a run that was stopped or lost is no calculation", () => {
    for (const status of ["running", "cancelled", "error", "lost"]) expect(workSummary([tool("code_run", { status })], "de")).toBe("");
  });

  test("the second part keeps its own capitals: nouns stay nouns", () => {
    expect(workSummary([tool("code_pull"), tool("read_file"), tool("code_run", { status: "completed" })], "de")).toBe(
      "Automation gelesen, Datei ausgewertet",
    );
    expect(workSummary([tool("code_run", { status: "completed" }), tool("write_file")], "de")).toBe("Gerechnet, Dateien abgelegt");
    expect(workSummary([tool("code_run", { status: "completed" }), tool("write_file")], "en")).toBe("Calculated, stored files");
  });

  test("file analysis requires a successful preceding file read", () => {
    expect(workSummary([tool("read_file"), tool("code_run", { status: "completed" })], "de")).toBe("Datei ausgewertet");
    expect(workSummary([tool("list_files"), tool("code_run", { status: "completed" })], "de")).toBe("Gerechnet");
    expect(workSummary([tool("code_run", { status: "completed" }), tool("read_file")], "de")).toBe("Gerechnet");
    expect(workSummary([tool("read_file", "denied", {}, { isError: true }), tool("code_run", { status: "completed" })], "de")).toBe(
      "Gerechnet",
    );
  });

  test("unique stored paths count files; append and present do not add files", () => {
    const stored = tool("write_file", { path: "/reports/result.csv", size: 50, mediaType: "text/csv" });
    expect(workSummary([stored], "de")).toBe("1 Tabelle abgelegt");
    expect(workSummary([stored, stored, tool("present", { path: "/reports/result.csv" })], "de")).toBe("1 Tabelle abgelegt");
    expect(workSummary([stored, tool("html_to_pdf", { path: "/reports/result.pdf", mediaType: "application/pdf" })], "de")).toBe(
      "2 Dateien abgelegt",
    );
    expect(workSummary([tool("present", { path: "/uploads/person.csv" })], "de")).toBe("");
    expect(workSummary([tool("write_file")], "de")).toBe("Dateien abgelegt");
  });

  test("failed writes, submissions and calculations do not claim success", () => {
    for (const name of ["code_init", "code_write", "code_submit", "write_file", "code_run"]) {
      expect(workSummary([tool(name, "TIMEOUT", {}, { status: "failed" })], "de")).toBe("");
    }
    expect(workSummary([tool("code_run", { status: "running" })], "de")).toBe("");
    expect(workSummary([tool("code_write", { error: { code: "FORBIDDEN", message: "No access" } })], "de")).toBe("");
    expect(workSummary([tool("code_run", { status: "error" })], "de")).toBe("");
    expect(workSummary([tool("code_test", examples(3, 3), undefined, { isError: true })], "de")).toBe("");
  });

  test("step count and failures stay separate from the summary sentence", () => {
    const blocks = [write(), tool("code_test", examples(2, 3))];
    expect(workStepLine(blocks, 6, "de")).toBe("6 Schritte, 1 fehlgeschlagen");
    expect(workSummary(blocks, "de")).not.toMatch(/Schritte|fehlgeschlagen/);
  });

  test("the sentence has at most two parts even with web, apps, files and automation work", () => {
    const blocks = [tool("web_search"), tool("read_file"), init(), check(), tool("code_test", examples(2, 3)), tool("code_submit")];
    expect(workSummary(blocks, "de")).toBe("2 von 3 Beispielen erfolgreich, zur Freigabe eingereicht");
    expect(workSummary(blocks, "en")).toBe("2 of 3 examples succeeded, submitted for approval");
  });
});

test("Code's own steps never name the code", () => {
  const rework = [tool("code_pull"), tool("code_write"), tool("code_check"), tool("code_submit")];
  expect(workSummary(rework, "de")).not.toMatch(/\bCode\b/);
  expect(workSummary(rework, "en")).not.toMatch(/\bcode\b/i);
});

test("an effect and its counted examples read as one finding; other parts join with a comma (Feinschliff F5)", () => {
  expect(workSummary([init(), write(), tool("code_test", examples(3, 3))], "de")).toBe(
    "Automation vorbereitet · 3 von 3 Beispielen erfolgreich",
  );
  expect(workSummary([init(), write()], "de")).toBe("Automation vorbereitet, noch ohne Beispiele");
  expect(
    workSummary(
      [tool("read_file"), tool("code_run", { status: "completed" }), tool("write_file", { path: "/t.csv", mediaType: "text/csv" })],
      "de",
    ),
  ).toBe("Datei ausgewertet, 1 Tabelle abgelegt");
});

test("what did not go through carries its tone for the meta column", () => {
  const denied = tool("mail.read", { error: { code: "FORBIDDEN" } }, {}, { isError: true });
  const failed = tool("write_file", "TIMEOUT", {}, { status: "failed" });
  expect(workStepParts([denied, failed], 4, "de")).toEqual({
    count: "4 Schritte",
    issues: [
      { text: "1 ohne Zugriff", tone: "warning" },
      { text: "1 fehlgeschlagen", tone: "danger" },
    ],
  });
});

test("an outcome Cloud could not see counts as unclear in warning, until a check settles it", async () => {
  const { workStepParts } = await import("./work-summary");
  const failed = (id: string, name: string, result: string): Extract<AiTurnBlock, { kind: "tool" }> => ({
    id: `tool-${id}`,
    kind: "tool",
    callId: id,
    name,
    args: {},
    status: "failed",
    isError: true,
    result,
  });
  const unclear = (check?: "done" | "not_done"): AiTurnBlock => ({
    ...failed("send", "mail__action__send", "ACTION_OUTCOME_UNKNOWN: The Action response was lost."),
    ...(check ? { check: { state: check, at: "2026-11-15T10:00:00.000Z" } } : {}),
  });
  const denied = failed("read", "files__query__read", "FORBIDDEN: no");
  expect(workStepParts([unclear(), denied], 2, "de").issues).toEqual([
    { text: "1 unklar", tone: "warning" },
    { text: "1 ohne Zugriff", tone: "warning" },
  ]);
  expect(workStepParts([unclear("done")], 1, "de").issues).toEqual([]);
  expect(workStepParts([unclear("not_done")], 1, "en").issues).toEqual([{ text: "1 failed", tone: "danger" }]);
});
