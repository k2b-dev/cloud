import { expect, test } from "bun:test";
import { codeSurfaceFindings, compareCodeSourceBaseline } from "./code-no-source";

test("the visible-text guard catches code coordinates, identifiers, result paths and bare statuses", () => {
  for (const text of [
    "code.ts",
    "lib/action.ts:12",
    "code_run_failed",
    "$.calls[0]",
    "test/weekly.json",
    "sp_2lg8",
    "9a4bf7812cdef012",
    "Passt",
    "OK",
    "Gut",
    "Fertig",
  ])
    expect(codeSurfaceFindings("fixture", text).length).toBeGreaterThan(0);
  expect(
    codeSurfaceFindings(
      "fixture",
      "3 von 3 Beispielen erfolgreich\nAufgabe erstellen · Team Logistik\nhttps://status.example:8443\nFertig mit der Auswertung.",
    ),
  ).toEqual([]);
});

test("the source baseline admits only exact existing findings and never exchanges them for new ones", () => {
  const known = { file: "packages/example/view.tsx", message: "de/overview: code.ts" };
  const added = { ...known, message: "de/overview: code_new_diagnostic" };
  const key = JSON.stringify([known.file, known.message]);
  const baseline = new Map([[key, 2]]);
  expect(compareCodeSourceBaseline([known, known], baseline).failures).toEqual([]);
  expect(compareCodeSourceBaseline([known, known, known], baseline).failures).toEqual([known]);
  // The total still equals two; an aggregate file count would miss this regression.
  const exchanged = compareCodeSourceBaseline([known, added], baseline);
  expect(exchanged.failures).toHaveLength(2);
  expect(exchanged.failures).toContainEqual(added);
  expect(exchanged.failures[1]?.file).toBe("scripts/checks/code-no-source.baseline");
});

test("baseline fixes only lower or remove entries and keep reporting new findings", () => {
  const known = { file: "packages/example/view.tsx", message: "de/overview: code.ts" };
  const added = { ...known, message: "en/overview: code.ts" };
  const key = JSON.stringify([known.file, known.message]);
  const baseline = new Map([[key, 2]]);
  const lowered = compareCodeSourceBaseline([known, added], baseline, true);
  expect(lowered.remaining).toEqual(new Map([[key, 1]]));
  expect(lowered.failures).toEqual([added]);
  expect(lowered.lowered).toBe(true);
  expect(baseline.get(key)).toBe(2);
  expect(compareCodeSourceBaseline([], lowered.remaining).failures).toHaveLength(1);
  const empty = compareCodeSourceBaseline([], lowered.remaining, true);
  expect(empty.remaining.size).toBe(0);
  expect(empty.failures).toEqual([]);
});
