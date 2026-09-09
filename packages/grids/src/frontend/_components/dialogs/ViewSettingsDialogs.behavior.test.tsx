import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicView } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const settle = () => Bun.sleep(30);
const initialView: PublicView = {
  id: "VIEW01",
  tableId: "TABLE1",
  name: "Original",
  description: null,
  icon: null,
  source: "from table {TABLE1} select *",
  ui: {},
  ownerUserId: null,
  position: 0,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

domTest("view settings preserve dirty drafts and block changes and dismissal during saving", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const { dialogCore } = await import("@k2b/ui");
  const { openViewSettingsDialog } = await import("./ViewSettingsDialogs");
  let complete: ((response: Response) => void) | undefined;
  let writes = 0;
  let savedName = "";
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/views/VIEW01") && init?.method === "PATCH") {
        writes++;
        expect(JSON.parse(String(init.body)).name).toBe("Saved name");
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      if (url.endsWith("compile-view")) return Response.json({ ok: true, source: initialView.source });
      return Response.json({ suggestions: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const result = openViewSettingsDialog({
      baseId: "BASE01",
      tableId: "TABLE1",
      viewId: "VIEW01",
      tableName: "Inventory",
      fields: [],
      initialView,
      onSaved: (view) => {
        savedName = view.name;
      },
    });
    await settle();
    const input = dom.document.querySelector<HTMLInputElement>("fieldset input")!;
    const enter = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const escape = () => dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    enter(" ");
    Array.from(input.closest("fieldset")!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save")!
      .click();
    await settle();
    expect(writes).toBe(0);
    expect(dom.document.querySelectorAll("dialog").length).toBe(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    enter("Saved name");
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    escape();
    await settle();
    expect(dom.document.body.textContent).toContain("Unsaved changes");
    Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button"))
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click();
    await settle();
    expect(input.value).toBe("Saved name");
    Array.from(input.closest("fieldset")!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save")!
      .click();
    await settle();
    expect(writes).toBe(1);
    expect(input.closest("fieldset")!.disabled).toBe(true);
    enter("Must not replace pending payload");
    escape();
    await settle();
    expect(dialogCore.isOpen()).toBe(true);
    expect(dom.document.body.textContent).not.toContain("Unsaved changes");
    complete!(Response.json({ ...initialView, name: "Saved name" }));
    await settle();
    expect(savedName).toBe("Saved name");
    expect(input.closest("fieldset")!.disabled).toBe(false);
    expect(Array.from(input.closest("fieldset")!.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save")).toBe(
      false,
    );
    escape();
    await result;
    expect(dialogCore.isOpen()).toBe(false);
    expect(writes).toBe(1);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("mutation policy stays mounted and its controls are locked until the save completes", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const { dialogCore } = await import("@k2b/ui");
  const { openMutationPolicyDialog } = await import("./MutationPolicyDialog");
  let complete: ((response: Response) => void) | undefined;
  let writes = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("mutation-policy") && init?.method === "PUT") {
        writes++;
        expect(JSON.parse(String(init.body))).toEqual({ policy: { mode: "all" } });
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      return Response.json({ items: [], total: 0, limit: 100, truncated: false, complete: true });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const result = openMutationPolicyDialog({
      tableId: "TABLE1",
      tableName: "Inventory",
      value: { mode: "selected", sources: ["direct"] },
    });
    await settle();
    const all = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    all.click();
    await settle();
    const save = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Save",
    )!;
    save.click();
    await settle();
    expect(writes).toBe(1);
    expect(all.closest("fieldset")!.disabled).toBe(true);
    all.click();
    save.click();
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await settle();
    expect(dialogCore.isOpen()).toBe(true);
    expect(dom.document.body.textContent).not.toContain("Unsaved changes");
    expect(writes).toBe(1);
    complete!(Response.json({ policy: { mode: "all" } }));
    expect(await result).toEqual({ mode: "all" });
    expect(dialogCore.isOpen()).toBe(false);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
