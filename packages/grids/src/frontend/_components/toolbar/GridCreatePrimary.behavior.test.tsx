import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicForm } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const timestamp = "2026-01-01T00:00:00.000Z";
const title: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Title",
  description: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: true,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const form: PublicForm = {
  id: "FORM01",
  tableId: "TABLE1",
  name: "Order intake",
  config: { fields: [] },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The head's server link, as AppWorkspace.Head renders it, and the records view's takeover beside it. */
const mount = async (forms: PublicForm[], url = "/app/grids/BASE01/table/TABLE1") => {
  const dom = createDomTestHarness();
  window.history.replaceState(null, "", url);
  const { GridCreatePrimary } = await import("./GridCreateActions");
  const { dialogCore } = await import("@k2b/ui");
  const link = dom.document.createElement("a");
  link.setAttribute("data-workspace-primary", "");
  link.setAttribute("href", "/app/grids/BASE01/table/TABLE1?new=1");
  link.textContent = "Add record";
  dom.root.append(link);
  const host = dom.document.createElement("div");
  dom.root.append(host);
  const dispose = render(
    () =>
      createComponent(GridCreatePrimary, {
        param: "new",
        baseId: "BASE01",
        tableId: "TABLE1",
        tableName: "Orders",
        disableDirectInsert: false,
        fields: [title],
        forms,
        canWrite: true,
        canDirectWrite: true,
        canSubmitForms: true,
      }),
    host,
  );
  await Promise.resolve();
  return {
    link,
    dialogCore,
    dispose: () => {
      while (dialogCore.isOpen()) dialogCore.close();
      dispose();
      dom.cleanup();
    },
  };
};

domTest("with one way to add, the head's link opens the record dialog in place", async () => {
  const page = await mount([]);
  try {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    page.link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(page.dialogCore.isOpen()).toBe(true);
  } finally {
    page.dispose();
  }
});

// happy-dom has no popover, so the open menu itself is checked in the browser; here the menu adopts the link.
domTest("with a form as a second way, the head's link becomes the trigger of a menu and opens no dialog itself", async () => {
  const page = await mount([form]);
  try {
    const menuId = page.link.getAttribute("aria-controls");
    expect(menuId).toBeTruthy();
    expect(document.getElementById(menuId ?? "")?.getAttribute("role")).toBe("menu");
    page.link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
    expect(page.dialogCore.isOpen()).toBe(false);
  } finally {
    page.dispose();
  }
});

domTest("a page opened with ?new=1 starts adding once and drops the parameter", async () => {
  const page = await mount([], "/app/grids/BASE01/table/TABLE1?q=lamp&new=1");
  try {
    await waitFor(() => page.dialogCore.isOpen());
    expect(`${window.location.pathname}${window.location.search}`).toBe("/app/grids/BASE01/table/TABLE1?q=lamp");
  } finally {
    page.dispose();
  }
});
