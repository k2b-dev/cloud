import { describe, expect, test } from "bun:test";
import { checkNotebooksWsMessages, notebooksWsMessages } from "./ws-messages";

describe("Notebooks WebSocket messages", () => {
  test("distinguishes admission contention from the pending-message limit in each locale", () => {
    expect(notebooksWsMessages("en").busy).toBe("Document is busy; retrying");
    expect(notebooksWsMessages("de").busy).toBe("Das Dokument ist ausgelastet; wir versuchen es erneut");
    for (const locale of ["en", "de"]) expect(notebooksWsMessages(locale).busy).not.toBe(notebooksWsMessages(locale).tooManyMessages);
  });
  test("resolves concurrent connection locales independently", async () => {
    expect(checkNotebooksWsMessages()).toEqual([]);
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => notebooksWsMessages("en").accessDenied),
      Promise.resolve().then(() => notebooksWsMessages("de-CH").accessDenied),
    ]);
    expect(english).toBe("Access denied");
    expect(german).toBe("Zugriff verweigert");
  });
});
