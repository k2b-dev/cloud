import { expect, test } from "bun:test";
import { mapSaveMessage } from "./map-messages";

test.each(["en", "de"])("save helper codes receive human %s recovery text", (locale) => {
  for (const code of [
    "source_changed",
    "persistence_failed",
    "checkpoint_failed",
    "invalid_checkpoint",
    "invalid_title",
    "save_failed",
    "request_too_large",
    "append_outcome_unknown",
    "create_outcome_unknown",
    "content_changed",
    "note_moved",
    "unexpected_receipt",
    "cancelled",
  ]) {
    const text = mapSaveMessage(locale, code, "Internal detail");
    expect(text).not.toBe("Internal detail");
    expect(text).not.toContain(code);
    expect(text.length).toBeGreaterThan(20);
  }
  expect(mapSaveMessage(locale, "NOTE_LOCKED", "This note is locked by its owner.")).toBe("This note is locked by its owner.");
});
