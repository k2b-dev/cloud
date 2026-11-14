import { expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailActionId } from "./mail-actions";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(20);
};

const renderBar = async (locale: string) => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = locale;
  const [{ default: MailBulkActionBar }, { LocaleProvider }] = await Promise.all([import("./MailBulkActionBar"), import("@k2b/ui")]);
  const actions: MailActionId[] = [];
  const later: string[] = [];
  let assigns = 0;
  let done = 0;
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(MailBulkActionBar, {
            selectedCount: 3,
            selectedInJunk: false,
            selectedFlagged: false,
            busy: false,
            onDone: () => {
              done += 1;
            },
            onLater: (until) => {
              later.push(until);
            },
            onClear: () => {},
            onAddTags: () => {},
            onAssign: () => {
              assigns += 1;
            },
            onAction: (actionId) => {
              actions.push(actionId);
            },
          });
        },
      }),
    dom.root,
  );
  const toolbarLabels = () =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='toolbar'] button[aria-label]")).map((button) =>
      button.getAttribute("aria-label"),
    );
  const openMenu = async (label = "More selected conversation actions") => {
    const trigger = dom.root.querySelector<HTMLButtonElement>(`button[aria-haspopup][aria-label^='${label}']`)!;
    trigger.click();
    await settle();
    // Each menu of the bar keeps its entries; read only the one this trigger opened.
    const menu = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
    return Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"));
  };
  return {
    dom,
    actions,
    later,
    done: () => done,
    assigns: () => assigns,
    toolbarLabels,
    openMenu,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test.skipIf(isServer)("keeps the bulk actions in their three groups and Junk and Flag in the more menu", async () => {
  const bar = await renderBar("en");
  try {
    expect(bar.toolbarLabels()).toEqual([
      "Exit selection",
      "Done 3 selected conversations",
      "Archive 3 selected conversations",
      "Delete 3 selected conversations",
      "Unread 3 selected conversations",
      "Later 3 selected conversations",
      "Assign 3 selected conversations",
      "Move 3 selected conversations",
      "Add tags to 3 selected conversations",
      "More selected conversation actions",
    ]);
    // A group starts with a little more room; the order follows the approved bar.
    const starts = Array.from(bar.dom.root.querySelectorAll<HTMLElement>("[data-section-start]")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(starts).toEqual(["Unread 3 selected conversations", "Move 3 selected conversations"]);
    bar.dom.root.querySelector<HTMLButtonElement>("button[aria-label='Assign 3 selected conversations']")!.click();
    bar.dom.root.querySelector<HTMLButtonElement>("button[aria-label='Done 3 selected conversations']")!.click();
    bar.dom.root.querySelector<HTMLButtonElement>("button[aria-label='Delete 3 selected conversations']")!.click();
    expect(bar.assigns()).toBe(1);
    expect(bar.done()).toBe(1);
    expect(bar.actions).toEqual(["trash"]);

    const later = await bar.openMenu("Later");
    expect(later.map((item) => item.textContent?.trim())).toEqual(["Tomorrow morning", "Monday morning"]);
    // Thursday, 12 November 2026, 15:00 in the browser's zone: tomorrow morning is Friday at 8:00.
    setSystemTime(new Date(2026, 10, 12, 15, 0, 0));
    try {
      later[0]!.click();
      await settle();
    } finally {
      setSystemTime();
    }
    expect(bar.later).toHaveLength(1);
    expect(new Date(bar.later[0]!)).toEqual(new Date(2026, 10, 13, 8, 0, 0));

    const items = await bar.openMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Mark as junk", "Flag", "Mark as read"]);
    items[1]!.click();
    await settle();
    expect(bar.actions).toEqual(["trash", "flag"]);
  } finally {
    bar.cleanup();
  }
});

test.skipIf(isServer)("labels the bar and the more menu in German", async () => {
  const bar = await renderBar("de");
  try {
    expect(bar.toolbarLabels()).toContain("Zuweisen: 3 ausgewählte Unterhaltungen");
    expect(bar.toolbarLabels()).toContain("Erledigt: 3 ausgewählte Unterhaltungen");
    expect(bar.toolbarLabels()).toContain("Später: 3 ausgewählte Unterhaltungen");
    const items = await bar.openMenu("Weitere Aktionen");
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Als Spam markieren", "Kennzeichnen", "Als gelesen markieren"]);
  } finally {
    bar.cleanup();
  }
});

test("Later presets fall on tomorrow and the next Monday at 8:00", async () => {
  const { mailLaterPresets } = await import("./MailBulkActionBar");
  // Thursday, 12 November 2026, 15:00 in the browser's zone.
  const now = new Date(2026, 10, 12, 15, 0, 0);
  const presets = mailLaterPresets(now);
  expect(new Date(presets.tomorrow)).toEqual(new Date(2026, 10, 13, 8, 0, 0));
  expect(new Date(presets.monday)).toEqual(new Date(2026, 10, 16, 8, 0, 0));
  // On a Monday, Monday morning is the next week's.
  expect(new Date(mailLaterPresets(new Date(2026, 10, 16, 7, 0, 0)).monday)).toEqual(new Date(2026, 10, 23, 8, 0, 0));
});
