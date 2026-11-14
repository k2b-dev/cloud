import { expect, test } from "bun:test";
import { codeSurfaceFindings } from "./code-no-source";

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
