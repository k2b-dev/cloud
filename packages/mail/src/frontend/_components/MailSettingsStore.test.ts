import { describe, expect, test } from "bun:test";
import { normalizeMailUserPreferences } from "./MailSettingsStore";
import {
  createDefaultMailComposerPanesLayout,
  normalizeMailComposerPanes,
  readMailComposerPanesFromCookieHeader,
  reconcileMailComposerPanes,
} from "./mail-composer-panes";
import { readMailUserPreferencesFromCookieHeader } from "./mail-user-preferences";

describe("Mail reading preferences", () => {
  test("defaults to automatic display and accepts explicit format preferences", () => {
    expect(normalizeMailUserPreferences(undefined)).toMatchObject({
      composeFormat: "markdown",
      readingFormat: "automatic",
      undoSeconds: 20,
    });
    expect(normalizeMailUserPreferences({ readingFormat: "html" })).toMatchObject({ readingFormat: "html" });
    expect(normalizeMailUserPreferences({ readingFormat: "plain" })).toMatchObject({ readingFormat: "plain" });
    expect(normalizeMailUserPreferences({ readingFormat: "invalid" })).toMatchObject({ readingFormat: "automatic" });
  });

  test("reads the mailbox preference from the request cookie for SSR", () => {
    const value = encodeURIComponent(
      JSON.stringify({
        mailboxes: {
          mailboxA: { readingFormat: "plain", composeFormat: "plain", undoSeconds: 20 },
        },
      }),
    );
    expect(readMailUserPreferencesFromCookieHeader(`other=1; settings-app-mail=${value}`, "mailboxA")).toEqual({
      readingFormat: "plain",
      composeFormat: "plain",
      undoSeconds: 20,
    });
    expect(readMailUserPreferencesFromCookieHeader(`settings-app-mail=${value}`, "mailboxB").readingFormat).toBe("automatic");
  });
});

describe("Mail composer pane preferences", () => {
  test("keeps a valid v2 horizontal split layout", () => {
    const value = {
      version: 2 as const,
      root: {
        type: "split" as const,
        direction: "horizontal" as const,
        ratio: 0.6,
        first: { type: "group" as const, items: ["editor"], active: "editor" },
        second: { type: "group" as const, items: ["preview"], active: "preview" },
      },
    };

    expect(normalizeMailComposerPanes(value)).toEqual(value);
  });

  test("rejects v1, malformed, vertical, unknown, and editor-less layouts", () => {
    const fallback = createDefaultMailComposerPanesLayout();
    for (const value of [
      { root: { type: "leaf", elementIds: ["editor"] } },
      { version: 2, root: { type: "split" } },
      {
        version: 2,
        root: {
          type: "split",
          direction: "vertical",
          ratio: 0.5,
          first: { type: "group", items: ["editor"], active: "editor" },
          second: { type: "group", items: ["preview"], active: "preview" },
        },
      },
      { version: 2, root: { type: "group", items: ["editor", "unknown"], active: "editor" } },
      { version: 2, root: { type: "group", items: ["history"], active: "history" } },
      { version: 2, root: null },
    ]) {
      expect(normalizeMailComposerPanes(value)).toEqual(fallback);
    }
  });

  test("reads the strict v2 layout from an SSR cookie header", () => {
    const value = { version: 2 as const, root: { type: "group" as const, items: ["editor", "history"], active: "history" } };
    const encoded = encodeURIComponent(JSON.stringify(value));
    expect(readMailComposerPanesFromCookieHeader(`other=1; settings-app-mail-composer-panes=${encoded}`)).toEqual(value);
    expect(readMailComposerPanesFromCookieHeader("settings-app-mail-composer-panes=%7Bbroken")).toEqual(
      createDefaultMailComposerPanesLayout(),
    );
  });

  test("reconciles the persisted layout with the current composer inventory", () => {
    const all = createDefaultMailComposerPanesLayout();
    const plain = reconcileMailComposerPanes(all, "plain", false);
    expect(plain).toEqual({ version: 2, root: { type: "group", items: ["editor"], active: "editor" } });
    expect(reconcileMailComposerPanes(plain, "markdown", true)).toEqual({
      version: 2,
      root: { type: "group", items: ["editor", "preview", "history"], active: "editor" },
    });
  });
});
