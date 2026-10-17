import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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

  beforeEach(() => setSystemTime(new Date("2026-10-17T12:00:00.000Z")));
  afterEach(() => setSystemTime());

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
      dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__close")?.click();
      await Bun.sleep(10);
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  for (const failReload of [false, true]) {
    test(`a level change keeps its chip through reload${failReload ? " and offers retry after failure" : ""}`, async () => {
      const dom = createDomTestHarness();
      installPopoverApi(dom);
      let saved = manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace", { permission: "read" });
      let finishReload!: (response: Response) => void;
      let reads = 0;
      let writes = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            writes += 1;
            saved = { ...saved, permission: "write" };
            return new Response(null, { status: 204 });
          }
          reads += 1;
          if (reads === 2)
            return new Promise<Response>((resolve) => {
              finishReload = resolve;
            });
          return Response.json([saved]);
        },
        { preconnect: originalFetch.preconnect },
      );
      const { default: AdminBookActions } = await import("./AdminBookActions.island");
      delegateEvents(["click"], dom.document);
      const dispose = render(() => <AdminBookActions bookId="book-1" bookName="Suppliers" />, dom.root);
      const waitFor = async (condition: () => boolean) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (condition()) return;
          await Bun.sleep(10);
        }
        throw new Error("Timed out waiting for access reconciliation");
      };
      const chip = () => dom.document.querySelector<HTMLButtonElement>("button.k2b-select-chip");
      try {
        dom.root.querySelector<HTMLButtonElement>('button[aria-label="Manage permissions for Suppliers"]')!.click();
        Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .find((node) => node.textContent?.includes("Permissions"))!
          .click();
        await waitFor(() => chip() !== null);
        const original = chip()!;
        Array.from(dom.document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"))
          .find((item) => item.textContent?.startsWith("Edit"))!
          .click();
        await waitFor(() => reads === 2);
        expect(writes).toBe(1);
        expect(chip() === original).toBe(true);
        expect(original.disabled).toBe(true);
        expect(original.textContent).toBe("Edit");
        expect(original.closest(".group\\/access-row")!.getAttribute("aria-busy")).toBe("true");
        // canEdit remains true: the picker and add form survive, with the editor owning the busy state.
        expect(dom.document.querySelector("input[role=combobox]")).not.toBeNull();
        expect(dom.document.querySelector(".group\\/access-row span.cursor-default")).toBeNull();
        finishReload(failReload ? Response.json({ message: "offline" }, { status: 503 }) : Response.json([saved]));
        await waitFor(() => dom.document.querySelector(".group\\/access-row[aria-busy]") === null);
        if (failReload) {
          expect(dom.document.body.textContent).toContain("The change was saved, but contact book access could not be reloaded.");
          expect(chip()).toBeNull();
          expect(dom.document.querySelector(".group\\/access-row span.cursor-default")?.textContent).toBe("Edit");
          const retry = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Retry reload",
          )!;
          expect(retry).toBeDefined();
          retry.click();
          await waitFor(() => chip() !== null);
          expect(reads).toBe(3);
          expect(dom.document.body.textContent).not.toContain("The change was saved, but contact book access could not be reloaded.");
        } else {
          expect(chip() === original).toBe(true);
          expect(original.disabled).toBe(false);
        }
        expect(chip()!.textContent).toBe("Edit");
      } finally {
        dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__close")?.click();
        await Bun.sleep(10);
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }
});
