import { describe, expect, test } from "bun:test";
import { checkNotebooksWsMessages, notebooksWsMessages } from "./ws-messages";

describe("Notebooks WebSocket messages", () => {
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
