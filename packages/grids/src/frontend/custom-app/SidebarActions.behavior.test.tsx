import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { CustomAppRenderedSidebarAction } from "./SidebarActions.island";

const domTest = isServer ? test.skip : test;
const action: CustomAppRenderedSidebarAction = {
  id: "new",
  kind: "form",
  label: "New invoice",
  tone: "default",
  submitUrl: "/submit",
  form: { id: "FORM01", name: "Invoice", config: { fields: [] } },
  fields: [],
  inlineTargetFields: {},
  dateConfig: { locale: "en", timeZone: "UTC" },
};

domTest("sidebar opens the shared form only on activation and guards repeated loading", async () => {
  const dom = createDomTestHarness();
  const { default: SidebarActions } = await import("./SidebarActions.island");
  const sidebar = await import("./sidebar-form");
  const { dialogCore } = await import("@k2b/ui");
  const open = spyOn(sidebar, "openCustomAppSidebarForm");
  const dispose = render(() => <SidebarActions actions={[action]} />, dom.root);
  try {
    expect(open).not.toHaveBeenCalled();
    expect(dialogCore.isOpen()).toBe(false);
    const button = dom.root.querySelector("button")!;
    button.click();
    expect(button.disabled).toBe(true);
    button.click();
    await Bun.sleep(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(dialogCore.isOpen()).toBe(true);
    expect(dom.document.querySelector("form")).not.toBeNull();
    expect(button.disabled).toBe(false);
  } finally {
    dialogCore.close();
    open.mockRestore();
    dispose();
    dom.cleanup();
  }
});

domTest("failed form opening reports an error and leaves the action retryable", async () => {
  const dom = createDomTestHarness();
  const { default: SidebarActions } = await import("./SidebarActions.island");
  const sidebar = await import("./sidebar-form");
  const { toast } = await import("@k2b/ui");
  const open = spyOn(sidebar, "openCustomAppSidebarForm").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const dispose = render(() => <SidebarActions actions={[action]} />, dom.root);
  try {
    const button = dom.root.querySelector("button")!;
    button.click();
    await Bun.sleep(0);
    expect(error).toHaveBeenCalledWith("Form unavailable");
    expect(button.disabled).toBe(false);
    button.click();
    await Bun.sleep(0);
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    error.mockRestore();
    open.mockRestore();
    dispose();
    dom.cleanup();
  }
});

domTest("navigation away while the form module loads does not open a stale dialog", async () => {
  const dom = createDomTestHarness();
  const { default: SidebarActions } = await import("./SidebarActions.island");
  const sidebar = await import("./sidebar-form");
  const open = spyOn(sidebar, "openCustomAppSidebarForm");
  const dispose = render(() => <SidebarActions actions={[action]} />, dom.root);
  dom.root.querySelector("button")!.click();
  dispose();
  try {
    await Bun.sleep(0);
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    dom.cleanup();
  }
});

domTest("workspace navigation preserves links and opens forms through controller activation", async () => {
  const dom = createDomTestHarness();
  const { default: CustomAppNavigation } = await import("./CustomAppNavigation.island");
  const { readWorkspaceNavigation } = await import("../../../../cloud/src/ssr/workspace-navigation");
  const { dialogCore } = await import("@k2b/ui");
  const dispose = render(
    () => (
      <CustomAppNavigation
        name="Billing"
        appId="APP001"
        pageId="invoices"
        pages={[
          { id: "invoices", title: "Invoices", icon: "receipt" },
          { id: "balances", title: "Balances" },
        ]}
        actions={[action]}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    const navigation = readWorkspaceNavigation()!.navigation;
    expect(navigation.items().find((item) => item.id === "balances")).toMatchObject({ href: "/apps/APP001/balances", active: false });
    expect(navigation.items().find((item) => item.id === "invoices")).toMatchObject({ active: true });
    const opened = navigation.activate("action:new");
    expect(navigation.items()[0]?.disabled).toBe(true);
    await Bun.sleep(0);
    expect(dialogCore.isOpen()).toBe(true);
    dialogCore.close();
    await opened;
    expect(navigation.items()[0]?.disabled).toBe(false);
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});
