import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailboxDeleteOutcome } from "./MailboxDeleteDialog";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { MailboxDeleteDialog } = await import("./MailboxDeleteDialog");
    const { LocaleProvider } = await import("@k2b/ui");
    return { MailboxDeleteDialog, LocaleProvider };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

describe.skipIf(isServer)("Delete a mailbox", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  const mount = (remove: () => Promise<MailboxDeleteOutcome>, code: { exists: boolean; automations: number; access: { title: string; count: number }[] } | null) => {
    const dom = createDomTestHarness();
    const { MailboxDeleteDialog, LocaleProvider } = modules!;
    const closed: boolean[] = [];
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(MailboxDeleteDialog, {
              address: "info@example.test",
              mails: 4812,
              folders: 6,
              accessEntries: 5,
              code,
              remove,
              close: (deleted: boolean) => closed.push(deleted),
            });
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const submit = () => dom.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const type = (value: string) => {
      const input = dom.document.querySelector<HTMLInputElement>("input")!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const text = () => dom.document.body.textContent ?? "";
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { closed, submit, type, text, settle };
  };
  const code = { exists: true, automations: 2, access: [{ title: "Space", count: 1 }] };

  test("names the numbers and stays locked until the address is typed", () => {
    const view = mount(async () => "deleted", code);
    expect(view.text()).toContain("4.812 Mails in 6 Ordnern");
    expect(view.text()).toContain("5 Personen und Gruppen");
    expect(view.text()).toContain("2 Automationen, Zugriff auf 1 Space");
    expect(view.submit().disabled).toBe(true);
    view.type("info@");
    expect(view.submit().disabled).toBe(true);
    view.type(" Info@Example.test ");
    expect(view.submit().disabled).toBe(false);
  });

  test("says nothing was deleted on a refusal and keeps the address for another try", async () => {
    const outcomes: MailboxDeleteOutcome[] = ["refused", "unknown", "deleted"];
    const view = mount(async () => outcomes.shift()!, code);
    view.type("info@example.test");
    view.submit().click();
    await view.settle();
    expect(view.text()).toContain("Es wurde nichts gelöscht");
    expect(view.closed).toEqual([]);
    expect(view.submit().disabled).toBe(false);
    // A lost answer may follow a committed delete, so it never claims that nothing changed.
    view.submit().click();
    await view.settle();
    expect(view.text()).not.toContain("Es wurde nichts gelöscht");
    expect(view.text()).toContain("vielleicht schon gelöscht");
    view.submit().click();
    await view.settle();
    expect(view.closed).toEqual([true]);
  });

  test("leaves the Code line out without Code, and speaks without numbers when Core did not answer", () => {
    expect(mount(async () => "deleted", { exists: false, automations: 0, access: [] }).text()).not.toContain("Code dieses Postfachs");
    cleanup?.();
    expect(mount(async () => "deleted", null).text()).toContain("falls es welchen gibt");
  });
});
