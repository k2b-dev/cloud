import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
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

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
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

  beforeEach(() => setSystemTime(new Date("2026-10-17T12:00:00.000Z")));
  afterEach(() => setSystemTime());

  const setup = async (fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(fetchImpl, { preconnect: originalFetch.preconnect });
    const { prompts } = await import("@k2b/ui");
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const { default: AdminBookActions } = await import("./AdminBookActions.island");
    delegateEvents(["click", "input"], dom.document);
    const dispose = render(() => <AdminBookActions bookId="book-1" bookName="Suppliers" />, dom.root);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Manage permissions for Suppliers"]')!.click();
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((node) => node.textContent?.includes("Permissions"))!
      .click();
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    return {
      dom,
      error,
      dialog,
      button,
      cleanup: async () => {
        if (dialog()) {
          button("Cancel")?.click();
          await waitFor(() => !dialog(), "the dialog to close");
        }
        dispose();
        error.mockRestore();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("opens the access dialog with every grant on the book, so a person managing next to an agent is not locked", async () => {
    const entries = [
      manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace"),
      manager("access-agent", { type: "service_account", serviceAccountId: "agent-1" }, "CRM sync agent", { serviceAccountKind: "agent" }),
    ];
    const ui = await setup(async () => Response.json(entries));
    try {
      const removeButton = (name: string) => ui.dom.document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`);
      await waitFor(() => !!removeButton("Ada Lovelace"), "the access dialog");
      expect(ui.dialog()!.textContent).toContain("Access to Suppliers");
      expect(removeButton("Ada Lovelace")?.disabled).toBe(false);
      expect(removeButton("CRM sync agent")?.disabled).toBe(false);
    } finally {
      await ui.cleanup();
    }
  });

  test("a level change applies on Save, through the admin route", async () => {
    let saved = manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace", { permission: "read" });
    const owner = manager("access-owner", { type: "user", userId: "user-2" }, "Mia Hoffmann");
    const writes: string[] = [];
    const ui = await setup(async (input, init) => {
      if (init?.method === "PATCH") {
        writes.push(String(input));
        saved = { ...saved, permission: "write" };
        return new Response(null, { status: 204 });
      }
      return Response.json([owner, saved]);
    });
    try {
      await waitFor(() => ui.dialog()?.textContent?.includes("Ada Lovelace") === true, "the access dialog");
      const row = Array.from(ui.dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes("Ada Lovelace"))!;
      Array.from(row.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Edit"))!
        .click();
      await waitFor(() => ui.dialog()?.textContent?.includes("1 change") === true, "one change");
      expect(writes).toEqual([]);
      ui.button("Save")!.click();
      await waitFor(() => !ui.dialog(), "the dialog to close");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("/admin/books/book-1/access/access-person");
    } finally {
      await ui.cleanup();
    }
  });

  test("a failed load says why and opens no dialog", async () => {
    const ui = await setup(async () => Response.json({ message: "offline" }, { status: 503 }));
    try {
      await waitFor(() => ui.error.mock.calls.length === 1, "the error");
      expect(ui.error.mock.calls[0]![0]).toBe("offline");
      expect(ui.dialog()).toBeNull();
    } finally {
      await ui.cleanup();
    }
  });
});
