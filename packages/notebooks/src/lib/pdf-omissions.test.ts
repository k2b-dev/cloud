import { describe, expect, test } from "bun:test";
import { notePdfOmissionText } from "./book-renderer-messages";
import {
  decodeNotePdfOmissions,
  encodeNotePdfOmissions,
  NOTE_PDF_OMISSION_CODES,
  NOTE_PDF_OMISSION_KINDS,
  NOTE_PDF_OMISSIONS_HEADER_MAX_BYTES,
  type NotePdfOmission,
  notePdfOmissionLabel,
} from "./pdf-omissions";

// Independently encode the wire format, including malformed input for decoder tests.
const wire = (value: unknown) =>
  btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

describe("PDF omission header", () => {
  test("packs the maximal document prefix within 2048 ASCII bytes", () => {
    const items: NotePdfOmission[] = Array.from({ length: 200 }, (_, index) => ({
      code: "not_rendered",
      kind: index % 2 ? "diagram" : "image",
      label: ["a", "ä", "😀"][index % 3]!.repeat(80),
    }));
    const encoded = encodeNotePdfOmissions(items)!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(NOTE_PDF_OMISSIONS_HEADER_MAX_BYTES);
    const decoded = decodeNotePdfOmissions(encoded)!;
    expect(decoded).toEqual({ items: items.slice(0, decoded.items.length), more: 200 - decoded.items.length });
    expect(decoded.more + decoded.items.length).toBe(200);
    expect(wire({ items: items.slice(0, decoded.items.length + 1), more: decoded.more - 1 }).length).toBeGreaterThan(2048);
    expect(encodeNotePdfOmissions([])).toBeNull();
  });

  test("normalizes controls and whitespace and truncates at Unicode code points", () => {
    expect(notePdfOmissionLabel(" \tFloor\u0000\u0085 plan\r\n next\u200bword ")).toBe("Floor plan next word");
    for (const char of ["a", "ä", "😀"]) {
      const label = notePdfOmissionLabel(char.repeat(81));
      expect(Array.from(label)).toHaveLength(80);
      expect(label).toBe(`${char.repeat(79)}…`);
      expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      const item: NotePdfOmission = { code: "invalid_block", kind: "math", label: `\n${char.repeat(81)}\t` };
      expect(decodeNotePdfOmissions(encodeNotePdfOmissions([item]))).toEqual({ items: [{ ...item, label }], more: 0 });
    }
    expect(notePdfOmissionLabel("😀".repeat(80))).toBe("😀".repeat(80));
  });

  test("rejects malformed envelopes and drops unknown codes and kinds", () => {
    for (const value of [
      null,
      undefined,
      "",
      "a",
      "+++",
      "abc=",
      " aaaa",
      "eA",
      "_w",
      wire(null),
      wire([]),
      wire({}),
      wire({ items: {} }),
      wire({ items: [null] }),
      wire({ items: [{ code: 1, kind: "image", label: "x" }] }),
      wire({ items: [{ code: "not_rendered", kind: "image" }] }),
    ]) {
      expect(decodeNotePdfOmissions(value)).toBeNull();
    }
    const item: NotePdfOmission = { code: "not_rendered", kind: "image", label: "😀".repeat(90) };
    for (const more of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      expect(decodeNotePdfOmissions(wire({ items: [{ ...item, code: "future" }, { ...item, kind: "future" }, item], more }))).toEqual({
        items: [{ ...item, label: `${"😀".repeat(79)}…` }],
        more: 0,
      });
    }
    expect(decodeNotePdfOmissions(wire({ items: [], more: Number.MAX_SAFE_INTEGER }))).toEqual({
      items: [],
      more: Number.MAX_SAFE_INTEGER,
    });
  });

  test("provides localized kinds, reasons and recovery for every combination", () => {
    for (const locale of ["en", "de"]) {
      for (const kind of NOTE_PDF_OMISSION_KINDS) {
        for (const code of NOTE_PDF_OMISSION_CODES) {
          const copy = notePdfOmissionText({ code, kind, label: "" }, locale);
          expect(copy.kind.length).toBeGreaterThan(0);
          expect(copy.reason.length).toBeGreaterThan(0);
          expect(copy.hint.length).toBeGreaterThan(0);
        }
      }
    }
    expect(notePdfOmissionText({ code: "not_rendered", kind: "image", label: "" }, "de-DE")).toEqual({
      kind: "Bild",
      reason: "Es wird noch nicht im PDF gedruckt.",
      hint: "Das PDF zeigt die Beschreibung. Öffne die Notiz, um das Bild anzusehen.",
    });
    expect(notePdfOmissionText({ code: "not_rendered", kind: "query", label: "" }, "en").hint).toContain("Book");
    expect(notePdfOmissionText({ code: "not_rendered", kind: "diagram", label: "" }, "en").hint).toContain("source");
    expect(notePdfOmissionText({ code: "invalid_block", kind: "chart", label: "" }, "de").kind).toBe("Datendiagramm");
  });
});
