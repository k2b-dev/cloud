import { describe, expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

/** happy-dom has no Popover API; the actions menu opens through it. */
const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const open = new WeakSet<object>();
  const matches = prototype.matches as (this: Element, selector: string) => boolean;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
    showPopover(this: object) {
      open.add(this);
    },
    hidePopover(this: object) {
      open.delete(this);
    },
    togglePopover(this: object) {
      if (open.has(this)) open.delete(this);
      else open.add(this);
    },
    scrollIntoView() {},
  });
};

const manager = (id: string, principal: AccessEntry["principal"], displayName: string, extra: Partial<AccessEntry> = {}): AccessEntry => ({
  id,
  principal,
  permission: "admin",
  displayName,
  createdAt: "2026-08-10T10:00:00.000Z",
  ...extra,
});

describe("Contacts administration access", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("shows every grant on the book, so a person managing next to an agent is not locked", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const entries = [
      manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace"),
      manager("access-agent", { type: "service_account", serviceAccountId: "agent-1" }, "CRM sync agent", { serviceAccountKind: "agent" }),
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json(entries), { preconnect: originalFetch.preconnect });
    const { default: AdminBookActions } = await import("./AdminBookActions.island");
    delegateEvents(["click"]);
    const dispose = render(() => <AdminBookActions bookId="book-1" bookName="Suppliers" />, dom.root);
    try {
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Manage permissions for Suppliers"]')?.click();
      const item = Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((node) =>
        node.textContent?.includes("Permissions"),
      );
      item?.click();
      const removeButton = (name: string) => dom.document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`);
      for (let attempt = 0; attempt < 200 && !removeButton("Ada Lovelace"); attempt += 1) await Bun.sleep(10);

      expect(removeButton("Ada Lovelace")?.disabled).toBe(false);
      expect(removeButton("CRM sync agent")?.disabled).toBe(false);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
