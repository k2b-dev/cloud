import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { SenderChoice } from "../../contracts";

const audience = { memberCount: 8, guestCount: 1, serviceAccountCount: 0, public: false, authenticated: false };
const choice: SenderChoice = {
  id: "sender",
  label: "Support",
  fromAddress: "support@example.test",
  status: "verified",
  replyTo: "replies@example.test",
  defaultCc: [{ name: null, address: "copy@example.test" }],
  defaultBcc: [{ name: null, address: "blind@example.test" }],
  signatureName: "Team signature",
  audience,
  assignedReaders: false,
};

if (!isServer)
  test("sender consequences recover from errors and keep unverified senders visible and disabled", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let mode: "error" | "ready" | "empty" | "denied" = "error";
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls++;
        return mode === "error"
          ? Response.json({ message: "Unavailable" }, { status: 503 })
          : mode === "denied"
            ? Response.json({ message: "Denied" }, { status: 403 })
            : Response.json(mode === "empty" ? [] : [choice, { ...choice, id: "pending", label: "Pending", status: "unverified" }]);
      },
      { preconnect: originalFetch.preconnect },
    );
    const prototype = dom.window.HTMLElement.prototype;
    const originalShow = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const originalHide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
    const { default: SenderSelect } = await import("./MailSenderSelect");
    delegateEvents(["click", "pointermove", "focusin"]);
    const selections: string[] = [];
    const [mailbox, setMailbox] = createSignal("Box001");
    const [creatingDraft, setCreatingDraft] = createSignal(true);
    const dispose = render(
      () => (
        <SenderSelect
          mailboxId={mailbox()}
          identities={[]}
          value={null}
          showRecipientDefaults={creatingDraft()}
          onChange={(id) => selections.push(id)}
        />
      ),
      dom.root,
    );
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Bun.sleep(5);
    };
    const button = (text: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text));
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      trigger.click();
      expect(dom.root.textContent).toContain("Loading options");
      await flush();
      expect(button("Retry")).toBeDefined();
      mode = "ready";
      button("Retry")!.click();
      await flush();
      const rows = [...dom.root.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(rows.map((row) => row.textContent)).toEqual(["Supportsupport@example.test", "PendingNot yet enabled"]);
      expect(rows[1]!.getAttribute("aria-disabled")).toBe("true");
      rows[1]!.click();
      expect(selections).toEqual([]);
      rows[0]!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      rows[0]!.focus();
      await flush();
      expect(dom.root.textContent).toContain("8 members");
      expect(dom.root.textContent).toContain("replies@example.test");
      expect(dom.root.textContent).toContain("copy@example.test");
      expect(dom.root.textContent).toContain("blind@example.test");
      expect(dom.root.textContent).toContain("Team signature");
      setCreatingDraft(false);
      await flush();
      expect(dom.root.textContent).not.toContain("copy@example.test");
      expect(dom.root.textContent).not.toContain("blind@example.test");
      expect(dom.root.textContent).toContain("replies@example.test");
      rows[0]!.click();
      expect(selections).toEqual(["sender"]);
      expect(calls).toBe(2);
      mode = "empty";
      setMailbox("Box002");
      trigger.click();
      await flush();
      expect(dom.root.textContent).toContain("No sender addresses available.");
      expect(dom.root.querySelectorAll('[role="option"]')).toHaveLength(0);
      mode = "denied";
      setMailbox("Box003");
      await flush();
      expect(dom.root.textContent).toContain("No write access");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      if (originalShow) Object.defineProperty(prototype, "showPopover", originalShow);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (originalHide) Object.defineProperty(prototype, "hidePopover", originalHide);
      else Reflect.deleteProperty(prototype, "hidePopover");
      dom.cleanup();
    }
  });
