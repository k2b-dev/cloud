import { expect, test } from "bun:test";
import { memoryLines } from "./ChatContextDetailsV2";

test("a memory stands whole while short, and a long one is three cut lines that keep every word", () => {
  expect(memoryLines("Rechnungen von Steinwerk Nord immer gegen das Angebot prüfen.")).toHaveLength(1);
  const long =
    "Bei Abweichungen zwischen Rechnung und Angebot zuerst die Montagestunden, dann die Anfahrt und zuletzt Materialpreise vergleichen; Rückfragen an Lieferanten freundlich und kurz formulieren.";
  const lines = memoryLines(long);
  expect(lines).toHaveLength(3);
  expect(lines[0].length).toBeLessThanOrEqual(48);
  expect(lines.join(" ").replace(/\s+/g, " ")).toBe(long);
});
