import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ...(await import("./MailboxMenu")), ...(await import("./mail-sidebar.fixture")) };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
for (const permission of ["writer", "reader", "admin", "assigned-only"] as const) {
  test.skipIf(isServer)(`mailbox menu respects ${permission} access`, () => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const m = modules!;
    let details = 0;
    const dispose = render(() => {
      const menu = m.createMailboxMenu(() =>
        m.mailboxMenuOptions({
          canWrite: permission !== "reader",
          canAdmin: permission === "admin",
          assignedOnly: permission === "assigned-only",
          onOpenDetails: () => {
            details += 1;
          },
        }),
      );
      expect(menu.sections().flatMap((section) => section.items.map((item) => item.id))).toEqual(
        permission === "assigned-only"
          ? []
          : [
              "details",
              ...(permission === "admin" ? ["sync", "health"] : []),
              "automations",
              "mailing-lists",
              "remote-images",
              ...(permission === "admin" ? ["shared-links"] : []),
              "email-links",
              "settings",
            ],
      );
      return createComponent(m.MailboxMenuButton, { menu, label: "Options for Support" });
    }, dom.root);
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Options for Support"]');
      if (permission === "assigned-only") {
        expect(trigger).toBeNull();
        return;
      }
      expect(trigger).not.toBeNull();
      trigger!.click();
      const entries = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const detail = entries.find((item) => item.textContent?.includes(permission === "reader" ? "About this mailbox" : "Mailbox details"));
      expect(detail).toBeDefined();
      detail!.click();
      expect(details).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
test.skipIf(isServer)("sync waits until the mailbox has a connection", () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const m = modules!;
  const [needsConnection, setNeedsConnection] = createSignal(true);
  const dispose = render(
    () =>
      createComponent(m.MailboxMenuButton, {
        menu: m.createMailboxMenu(() => m.mailboxMenuOptions({ needsConnection: needsConnection() })),
        label: "Options for Support",
      }),
    dom.root,
  );
  try {
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Options for Support"]')!.click();
    const sync = () => [...dom.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes("Sync mailbox"));
    expect(sync()?.getAttribute("aria-disabled")).toBe("true");
    setNeedsConnection(false);
    expect(sync()?.getAttribute("aria-disabled")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
