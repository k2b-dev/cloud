import { describe, expect, test } from "bun:test";
import { parseDateInput } from "./date-input";
import { resolveDateInputMessages } from "./date-input-messages";
import {
  draftStatusText,
  errorText,
  limitErrorText,
  rangeStatusText,
  restStatusText,
  spokenDateText,
  typingStatusText,
} from "./date-input-status";

// Monday, 2 November 2026; the status line never reads the clock itself.
const today = "2026-11-02";
const de = resolveDateInputMessages("de-DE");
const en = resolveDateInputMessages("en-US");
const draft = (text: string, locale = "de-DE", t = de) => {
  const result = parseDateInput(text, { today, locale });
  if (result.kind !== "date") throw new Error(`${text} is not a date`);
  return draftStatusText(result.date, result.note, locale, t);
};
const failure = (text: string) => {
  const result = parseDateInput(text, { today, locale: "de-DE" });
  if (result.kind !== "error") throw new Error(`${text} is a date`);
  return result.error;
};

describe("status line", () => {
  test("messages resolve by language from a regional locale", () => {
    expect(de.required).toBe("Bitte ein Datum eingeben.");
    expect(resolveDateInputMessages("fr-FR").required).toBe("Enter a date.");
  });

  test("at rest it names the weekday and the distance", () => {
    expect(restStatusText("2026-11-11", today, "de-DE")).toBe("Mittwoch, in 9 Tagen");
    expect(restStatusText("2026-11-03", today, "de-DE")).toBe("Dienstag, morgen");
    expect(restStatusText("2026-11-01", today, "en-US")).toBe("Sunday, yesterday");
  });

  test("while typing it shows the absolute date and what the words meant", () => {
    expect(draft("mi")).toBe("→ Mi., 4. Nov. 2026 · nächster Mittwoch");
    expect(draft("mo")).toBe("→ Mo., 9. Nov. 2026 · nächste Woche");
    expect(draft("morgen")).toBe("→ Di., 3. Nov. 2026 · morgen");
    expect(draft("gestern + 34")).toBe("→ Sa., 5. Dez. 2026 · gestern + 34 Tage");
    expect(draft("+2w")).toBe("→ Mo., 16. Nov. 2026 · heute + 2 Wochen");
    expect(draft("11.11. -3")).toBe("→ So., 8. Nov. 2026 · 11.11.2026 − 3 Tage");
    expect(draft("11.11.2026")).toBe("→ Mi., 11. Nov. 2026");
    expect(draft("wed", "en-US", en)).toBe("→ Wed, Nov 4, 2026 · next Wednesday");
  });

  test("an unfinished entry stays calm, a definite mistake names the reason", () => {
    expect(typingStatusText(failure("111"), "de-DE", de, today)).toBe("…");
    expect(typingStatusText(failure("abc"), "de-DE", de, today)).toBe("Noch kein Datum");
    expect(typingStatusText(failure("31.02.2026"), "de-DE", de, today)).toBe("Der Februar 2026 hat nur 28 Tage.");
  });

  test("errors after a commit", () => {
    expect(errorText(failure("abc"), "de-DE", de, today)).toBe("Kein Datum. Beispiel: 11.11., mi oder +14");
    expect(errorText(failure("12.13.2026"), "de-DE", de, today)).toBe("Einen 13. Monat gibt es nicht.");
    expect(errorText(failure("11.11.202"), "de-DE", de, today)).toBe("Jahr unvollständig, z. B. 2026.");
    expect(errorText(failure("+2x"), "de-DE", de, today)).toBe("Einheit unbekannt. Möglich: t, w, m, j");
    expect(errorText(failure("ab"), "en-US", en, today)).toBe("Not a date. Example: 11/11, wed or +14");
  });

  test("min and max refuse with the nearest allowed day", () => {
    const limits = { min: "2026-11-02", max: "2026-11-30" };
    expect(limitErrorText("2026-11-01", limits, "de-DE", de)).toBe("Frühestens am 02.11.2026.");
    expect(limitErrorText("2026-12-01", limits, "de-DE", de)).toBe("Spätestens am 30.11.2026.");
    expect(limitErrorText("2026-11-15", limits, "de-DE", de)).toBeUndefined();
  });

  test("ranges show both days and the length", () => {
    expect(rangeStatusText({ start: "2026-11-11", end: "2026-11-14" }, "de-DE", de)).toBe(
      "Mi., 11. Nov. 2026 – Sa., 14. Nov. 2026 · 4 Tage",
    );
    expect(rangeStatusText({ start: "2026-11-11", end: null }, "de-DE", de)).toBe("Mi., 11. Nov. 2026 · Ende fehlt");
    expect(rangeStatusText({ start: null, end: null }, "de-DE", de)).toBe("");
  });

  test("the live region reads the date in words", () => {
    expect(spokenDateText("2026-11-04", { kind: "weekday", weekday: 2, nextWeek: false }, "de-DE", de)).toBe(
      "Mittwoch, 4. November 2026, nächster Mittwoch",
    );
  });
});
