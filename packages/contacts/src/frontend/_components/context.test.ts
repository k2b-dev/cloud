import { expect, test } from "bun:test";
import { backFromContactDetail, clearSelectedContactInUrl, setSelectedContactInUrl } from "./context";
import { setDesktopDetailVisibility } from "./DesktopDetailLayoutSync.island";

test("opens and closes the AppWorkspace detail through its hidden state", () => {
  const originalDocument = globalThis.document;
  const detail = { hidden: true } as HTMLElement;
  const requestedIds: string[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => {
      requestedIds.push(id);
      return detail;
    },
  };

  try {
    setDesktopDetailVisibility("contacts-detail-panel", true);
    expect(detail.hidden).toBe(false);
    setDesktopDetailVisibility("contacts-detail-panel", false);
    expect(detail.hidden).toBe(true);
    expect(requestedIds).toEqual(["k2b-workspace-detail-contacts-detail-panel", "k2b-workspace-detail-contacts-detail-panel"]);
  } finally {
    (globalThis as unknown as { document: unknown }).document = originalDocument;
  }
});

test("live reconciliation replaces invalid detail history", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalHistory = globalThis.history;
  const calls: string[] = [];
  const target = new EventTarget();
  (globalThis as unknown as { window: unknown }).window = Object.assign(target, {
    location: { href: "http://localhost/app/contacts/book?contact=contact-id&contactBook=book-id" },
  });
  (globalThis as unknown as { document: unknown }).document = {};
  (globalThis as unknown as { history: unknown }).history = {
    pushState: () => calls.push("push"),
    replaceState: () => calls.push("replace"),
  };

  try {
    clearSelectedContactInUrl("replace");
    expect(calls).toEqual(["replace"]);
  } finally {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { document: unknown }).document = originalDocument;
    (globalThis as unknown as { history: unknown }).history = originalHistory;
  }
});

test("selection merges history fields and Back uses only a selection pushed in this document", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHistory = globalThis.history;
  let href = "http://localhost/app/contacts/team?contact=direct&contactBook=team";
  const initialState = { "@k2b/ssr/nav": { page: "page-1", position: 4 }, foreign: "preserve" };
  let state: Record<string, unknown> = initialState;
  const calls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: Object.assign(new EventTarget(), {
      location: {
        get href() {
          return href;
        },
      },
    }),
  });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {} });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    writable: true,
    value: {
      get state() {
        return state;
      },
      pushState: (next: Record<string, unknown>, _title: string, url: string) => {
        calls.push("push");
        state = next;
        href = url;
      },
      replaceState: (next: Record<string, unknown>, _title: string, url: string) => {
        calls.push("replace");
        state = next;
        href = url;
      },
      back: () => calls.push("back"),
      go: (delta: number) => calls.push(`go:${delta}`),
    },
  });
  try {
    backFromContactDetail();
    expect(calls).toEqual(["replace"]);
    setSelectedContactInUrl({ contactId: "ada", bookId: "team" });
    expect(calls).toEqual(["replace", "push"]);
    expect(state.foreign).toBe("preserve");
    expect(state["@k2b/ssr/nav"]).toEqual(initialState["@k2b/ssr/nav"]);
    expect(initialState).not.toHaveProperty("contacts.selection");
    backFromContactDetail();
    expect(calls.at(-1)).toBe("go:-1");
    const firstMarker = state["contacts.selection"];
    expect(firstMarker).toEqual({ doc: expect.any(String), depth: 1 });
    if (!firstMarker || typeof firstMarker !== "object" || !("doc" in firstMarker)) throw new Error("Missing selection marker");
    setSelectedContactInUrl({ contactId: "grace", bookId: "team" });
    expect(state["contacts.selection"]).toEqual({ ...firstMarker, depth: 2 });
    backFromContactDetail();
    expect(calls.at(-1)).toBe("go:-2");
    setSelectedContactInUrl({ contactId: "katherine", bookId: "team", history: "replace" });
    expect(state["contacts.selection"]).toEqual({ ...firstMarker, depth: 2 });
    backFromContactDetail();
    expect(calls.at(-1)).toBe("go:-2");
    clearSelectedContactInUrl("replace");
    expect(state).not.toHaveProperty("contacts.selection");
    expect(state.foreign).toBe("preserve");
    for (const marker of [
      undefined,
      "legacy-document-id",
      { doc: "another-document", depth: 2 },
      ...[undefined, 0, -1, 1.5, NaN, Infinity, "2"].map((depth) => ({ ...firstMarker, depth })),
    ]) {
      href = "http://localhost/app/contacts/team?search=Ada&contact=direct&contactBook=team";
      state = { ...initialState, "contacts.selection": marker };
      backFromContactDetail();
      expect(calls.at(-1)).toBe("replace");
      expect(href).toBe("http://localhost/app/contacts/team?search=Ada");
      expect(state).not.toHaveProperty("contacts.selection");
      expect(state.foreign).toBe("preserve");
    }
    // Opening a related contact from a direct link cannot prove a list entry exists.
    href = "http://localhost/app/contacts/team?contact=direct&contactBook=team";
    setSelectedContactInUrl({ contactId: "related", bookId: "team" });
    expect(state).not.toHaveProperty("contacts.selection");
    backFromContactDetail();
    expect(calls.at(-1)).toBe("replace");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.history = previousHistory;
  }
});
