import { describe, expect, test } from "bun:test";
import { normalizeMailUserPreferences } from "./MailSettingsStore";
import {
  createDefaultMailComposerPanesLayout,
  normalizeMailComposerPanes,
  readMailComposerPanesFromCookieHeader,
  reconcileMailComposerPanes,
} from "./mail-composer-panes";
import {
  MAIL_USER_PREFERENCES_COOKIE,
  MAIL_USER_PREFERENCES_COOKIE_BUDGET,
  readMailUserPreferencesFromCookieHeader,
  type StoredMailUserPreferences,
  storeMailUserPreferences,
} from "./mail-user-preferences";

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
      dismissedFolderHints: [],
    });
    expect(readMailUserPreferencesFromCookieHeader(`settings-app-mail=${value}`, "mailboxB").readingFormat).toBe("automatic");
  });

  test("keeps each dismissed folder hint once and ignores anything else", () => {
    expect(normalizeMailUserPreferences({ dismissedFolderHints: ["Fold01", 7, "Fold02", "Fold01", null] }).dismissedFolderHints).toEqual([
      "Fold01",
      "Fold02",
    ]);
    expect(normalizeMailUserPreferences({ dismissedFolderHints: "Fold01" }).dismissedFolderHints).toEqual([]);
  });
});

describe("Mail preferences cookie", () => {
  const bytes = (stored: StoredMailUserPreferences) =>
    `${MAIL_USER_PREFERENCES_COOKIE}=${encodeURIComponent(JSON.stringify(stored))}`.length;
  const preferences = (overrides: Partial<ReturnType<typeof normalizeMailUserPreferences>> = {}) => ({
    ...normalizeMailUserPreferences(undefined),
    ...overrides,
  });
  const hints = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(10, "0")}`);
  // Invented mailbox IDs of the length Mail uses.
  const mailboxId = (index: number) => `Mbx${String(index).padStart(12, "0")}`;

  test("stores only what differs from the defaults and moves the changed mailbox last", () => {
    let stored: StoredMailUserPreferences = { mailboxes: {} };
    stored = storeMailUserPreferences(stored, "MbxA", preferences({ readingFormat: "plain" }));
    stored = storeMailUserPreferences(stored, "MbxB", preferences());
    stored = storeMailUserPreferences(stored, "MbxA", preferences({ readingFormat: "plain", dismissedFolderHints: ["Fold01"] }));

    expect(stored).toEqual({ mailboxes: { MbxA: { readingFormat: "plain", dismissedFolderHints: ["Fold01"] } } });
    stored = storeMailUserPreferences(stored, "MbxB", preferences({ undoSeconds: 5 }));
    expect(Object.keys(stored.mailboxes)).toEqual(["MbxA", "MbxB"]);
  });

  test("stays within the budget: other mailboxes' hints go first, then this mailbox's oldest, then the oldest mailboxes", () => {
    let stored: StoredMailUserPreferences = { mailboxes: {} };
    for (let index = 0; index < 40; index += 1) {
      stored = storeMailUserPreferences(
        stored,
        mailboxId(index),
        preferences({ readingFormat: "html", dismissedFolderHints: hints(`H${index}x`, 3) }),
      );
      expect(bytes(stored)).toBeLessThanOrEqual(MAIL_USER_PREFERENCES_COOKIE_BUDGET);
    }
    // Every mailbox keeps its reading preference; only the oldest dismissed hints are gone.
    expect(Object.keys(stored.mailboxes)).toHaveLength(40);
    expect(Object.values(stored.mailboxes).every((entry) => normalizeMailUserPreferences(entry).readingFormat === "html")).toBe(true);
    expect(stored.mailboxes[mailboxId(39)]).toEqual({ readingFormat: "html", dismissedFolderHints: hints("H39x", 3) });
    expect(stored.mailboxes[mailboxId(0)]).toEqual({ readingFormat: "html" });

    // One mailbox with more dismissals than fit keeps its newest ones.
    const many = hints("F", 400);
    const crowded = storeMailUserPreferences({ mailboxes: {} }, mailboxId(1), preferences({ dismissedFolderHints: many }));
    expect(bytes(crowded)).toBeLessThanOrEqual(MAIL_USER_PREFERENCES_COOKIE_BUDGET);
    const kept = normalizeMailUserPreferences(crowded.mailboxes[mailboxId(1)]).dismissedFolderHints;
    expect(kept.at(-1)).toBe(many.at(-1));
    expect(kept.length).toBeGreaterThan(100);

    // When even the preferences alone outgrow it, the least recently changed mailboxes go.
    let full: StoredMailUserPreferences = { mailboxes: {} };
    for (let index = 0; index < 200; index += 1) {
      full = storeMailUserPreferences(
        full,
        mailboxId(index),
        preferences({ readingFormat: "plain", composeFormat: "plain", undoSeconds: 7 }),
      );
    }
    expect(bytes(full)).toBeLessThanOrEqual(MAIL_USER_PREFERENCES_COOKIE_BUDGET);
    expect(Object.keys(full.mailboxes).at(-1)).toBe(mailboxId(199));
    expect(full.mailboxes[mailboxId(0)]).toBeUndefined();
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
