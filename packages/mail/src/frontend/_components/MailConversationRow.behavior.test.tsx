import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { mailTestRow } from "./mail-list-test-fixtures";

beforeEach(() => setSystemTime(new Date("2026-10-14T10:00:00.000Z")));
afterEach(() => setSystemTime());

test.skipIf(isServer)("shares the row context projection across rendering and reactive updates", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationRow } = await import("./MailConversationRow");
  const [selected, setSelected] = createSignal(false);
  const [canWrite, setCanWrite] = createSignal(true);
  const [spamAction, setSpamAction] = createSignal<"junk" | "not_spam">("junk");
  let projections = 0;
  const dispose = render(
    () =>
      createComponent(MailConversationRow, {
        item: mailTestRow("Conv01"),
        requestUrl: new URL("https://cloud.test/app/mail/Box001"),
        get state() {
          projections += 1;
          return {
            selectedConversationId: selected() ? "Conv01" : null,
            selectedMessageId: null,
            selectedConversationIds: new Set<string>(),
            selectionMode: false,
            canWrite: canWrite(),
            spamAction: spamAction(),
            dateConfig: { locale: "en", timeZone: "UTC" },
          };
        },
        actions: { navigate: () => {}, toggleSelection: () => {}, itemAction: () => {}, manageTags: () => {} },
      }),
    dom.root,
  );
  const entry = () => dom.root.querySelector(".mail-list-entry")!;
  const actions = () => [...entry().querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
  try {
    // The actual list's projection resolves folders. Repeating it for each state
    // field multiplied that work even though its inputs had not changed.
    expect(projections).toBe(1);
    expect(entry().classList.contains("mail-list-entry-active")).toBe(false);
    expect(entry().querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
    expect(actions()).toContain("Move to Junk");
    expect(actions()).not.toContain("Not spam");
    setSelected(true);
    expect(entry().classList.contains("mail-list-entry-active")).toBe(true);
    expect(projections).toBe(2);
    setSpamAction("not_spam");
    expect(actions()).toContain("Not spam");
    expect(actions()).not.toContain("Move to Junk");
    expect(projections).toBe(3);
    setCanWrite(false);
    expect(entry().querySelector('button[aria-haspopup="menu"]')).toBeNull();
    expect(projections).toBe(4);
    setCanWrite(true);
    expect(entry().querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
    expect(actions()).toContain("Not spam");
    expect(actions()).not.toContain("Move to Junk");
    expect(projections).toBe(5);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("keeps menu rows through selection and callback changes, but uses the current actions", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationRow } = await import("./MailConversationRow");
  const [selected, setSelected] = createSignal(false);
  const [spamAction, setSpamAction] = createSignal<"junk" | "not_spam">("junk");
  const called: string[] = [];
  const [merge, setMerge] = createSignal<(() => void) | undefined>(() => {
    called.push("old");
  });
  const dispose = render(
    () =>
      createComponent(MailConversationRow, {
        item: mailTestRow("Conv01"),
        requestUrl: new URL("https://cloud.test/app/mail/Box001"),
        get state() {
          return {
            selectedConversationId: selected() ? "Conv01" : null,
            selectedMessageId: null,
            selectedConversationIds: new Set<string>(),
            selectionMode: false,
            canWrite: true,
            spamAction: spamAction(),
            dateConfig: { locale: "en", timeZone: "UTC" },
          };
        },
        get actions() {
          return { navigate: () => {}, toggleSelection: () => {}, itemAction: () => {}, manageTags: () => {}, merge: merge() };
        },
      }),
    dom.root,
  );
  const items = () => [...dom.root.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  try {
    const initial = items();
    expect(initial.length).toBeGreaterThan(0);
    setSelected(true);
    setMerge(() => () => {
      called.push("current");
    });
    const retained = items();
    expect(retained.length).toBe(initial.length);
    for (let i = 0; i < initial.length; i++) expect(retained[i] === initial[i]).toBe(true);
    expect(dom.root.querySelector(".mail-list-entry-active")).not.toBeNull();
    retained.find((item) => item.textContent?.includes("Merge"))!.click();
    expect(called).toEqual(["current"]);
    setMerge(undefined);
    expect(items().some((item) => item.textContent?.includes("Merge"))).toBe(false);
    setSpamAction("not_spam");
    expect(items().map((item) => item.textContent?.trim())).toContain("Not spam");
    expect(items().map((item) => item.textContent?.trim())).not.toContain("Move to Junk");
  } finally {
    dispose();
    dom.cleanup();
  }
});
