import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (!isServer)
  test.each(["remove", "reorder"] as const)(
    "editing a recipient survives remote %s without replacing a different person",
    async (change) => {
      const dom = createDomTestHarness();
      const { default: MailRecipientInput } = await import("./MailRecipientInput");
      const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
      const { DEFAULT_MAIL_CONTACT_DIRECTORY } = await import("../../contact-directory");
      const [recipients, setRecipients] = createSignal(["Ada <ada@example.test>", "Grace <grace@example.test>"]);
      delegateEvents(["click", "input", "keydown", "focusout"]);
      const dispose = render(
        () => (
          <MailContactDirectoryProvider value={{ ...DEFAULT_MAIL_CONTACT_DIRECTORY, suggest: null }}>
            <MailRecipientInput placeholder="To" value={recipients} onChange={setRecipients} />
          </MailContactDirectoryProvider>
        ),
        dom.root,
      );
      try {
        dom.root.querySelector<HTMLButtonElement>(".mail-recipient-pill")!.click();
        let input = dom.root.querySelector<HTMLInputElement>(".mail-recipient-edit")!;
        input.value = "Ada edited <ada@example.test>";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setRecipients(change === "remove" ? ["Grace <grace@example.test>"] : ["Grace <grace@example.test>", "Ada <ada@example.test>"]);
        await Bun.sleep(0);
        input = dom.root.querySelector<HTMLInputElement>("input")!;
        expect(input.value).toBe("Ada edited <ada@example.test>");
        if (change === "remove") expect(dom.root.textContent).toContain("removed elsewhere");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(recipients()).toContain("Grace <grace@example.test>");
        expect(recipients()).toContain("Ada edited <ada@example.test>");
        expect(recipients()).toHaveLength(2);
      } finally {
        dispose();
        dom.cleanup();
      }
    },
  );
