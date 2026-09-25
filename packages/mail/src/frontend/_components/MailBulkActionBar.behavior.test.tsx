import { expect, test } from "bun:test";
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
  let assigns = 0;
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(MailBulkActionBar, {
            selectedCount: 3,
            selectedInJunk: false,
            busy: false,
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
  const openMenu = async () => {
    dom.root.querySelector<HTMLButtonElement>("button[aria-haspopup]")!.click();
    await settle();
    return Array.from(dom.document.querySelectorAll<HTMLElement>("[role='menuitem']"));
  };
  return {
    dom,
    actions,
    assigns: () => assigns,
    toolbarLabels,
    openMenu,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test.skipIf(isServer)("puts Assign after read and moves flag and trash into the more menu", async () => {
  const bar = await renderBar("en");
  try {
    expect(bar.toolbarLabels()).toEqual([
      "Add tags to 3 selected conversations",
      "Archive 3 selected conversations",
      "Mark as read 3 selected conversations",
      "Assign 3 selected conversations",
      "Move 3 selected conversations",
      "More selected conversation actions",
      "Exit selection",
    ]);
    bar.dom.root.querySelector<HTMLButtonElement>("button[aria-label='Assign 3 selected conversations']")!.click();
    expect(bar.assigns()).toBe(1);

    const items = await bar.openMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Mark as unread",
      "Flag",
      "Remove flag",
      "Mark as junk",
      "Move to Trash",
    ]);
    const trash = items.at(-1)!;
    expect(trash.dataset.danger).toBe("true");
    expect(items.slice(0, -1).every((item) => item.dataset.danger === undefined)).toBeTrue();
    trash.click();
    await settle();
    expect(bar.actions).toEqual(["trash"]);
  } finally {
    bar.cleanup();
  }
});

test.skipIf(isServer)("labels the bar and the more menu in German", async () => {
  const bar = await renderBar("de");
  try {
    expect(bar.toolbarLabels()).toContain("Zuweisen: 3 ausgewählte Unterhaltungen");
    const items = await bar.openMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Als ungelesen markieren",
      "Kennzeichnen",
      "Kennzeichnung entfernen",
      "Als Spam markieren",
      "In den Papierkorb verschieben",
    ]);
  } finally {
    bar.cleanup();
  }
});
