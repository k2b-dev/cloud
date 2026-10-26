import { describe, expect, test } from "bun:test";
import { isPresentationMode, PRESENTATION_MODES, resolvePresentationMode } from "./presentation-mode";

describe("notebook presentation modes", () => {
  test("readers use Book unless they ask for Read, never Write, regardless of default or lock", () => {
    for (const defaultPresentationMode of PRESENTATION_MODES) {
      for (const requestedMode of [undefined, ...PRESENTATION_MODES]) {
        for (const locked of [false, true]) {
          expect(resolvePresentationMode({ permission: "read", defaultPresentationMode, requestedMode, locked })).toBe(
            requestedMode === "readonly" ? "readonly" : "book",
          );
          expect(resolvePresentationMode({ permission: "none", defaultPresentationMode, requestedMode, locked })).toBe("book");
        }
      }
    }
  });

  test("authors use the notebook default unless the URL contains a valid selection", () => {
    for (const permission of ["write", "admin"]) {
      for (const defaultPresentationMode of PRESENTATION_MODES) {
        for (const requestedMode of [undefined, null, "", "editor", "READONLY"]) {
          expect(resolvePresentationMode({ permission, defaultPresentationMode, requestedMode })).toBe(defaultPresentationMode);
        }
        for (const requestedMode of PRESENTATION_MODES) {
          expect(resolvePresentationMode({ permission, defaultPresentationMode, requestedMode })).toBe(requestedMode);
        }
      }
    }
  });

  test("locked notes downgrade Write without changing Book or Read-only", () => {
    for (const permission of ["write", "admin"]) {
      for (const mode of PRESENTATION_MODES) {
        expect(resolvePresentationMode({ permission, defaultPresentationMode: mode, locked: true })).toBe(
          mode === "write" ? "readonly" : mode,
        );
        expect(resolvePresentationMode({ permission, defaultPresentationMode: "book", requestedMode: mode, locked: true })).toBe(
          mode === "write" ? "readonly" : mode,
        );
      }
    }
  });

  test("accepts only the closed presentation contract", () => {
    for (const mode of PRESENTATION_MODES) expect(isPresentationMode(mode)).toBe(true);
    for (const value of [null, undefined, 1, {}, "read", "Write", ""]) expect(isPresentationMode(value)).toBe(false);
  });
});
