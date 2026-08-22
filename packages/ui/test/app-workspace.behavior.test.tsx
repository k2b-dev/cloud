import { describe, expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui AppWorkspace behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps sidebar active state and aria-current reactive", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const [active, setActive] = createSignal<"items" | "recent">("items");
    const dispose = render(
      () => (
        <div>
          <AppWorkspace.SidebarItem href="/items" navigation="document" active={active() === "items"}>
            Items
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem href="/recent" navigation="document" active={active() === "recent"}>
            Recent
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarIconAction icon="ti ti-history" label="Recent rail" active={active() === "recent"} />
        </div>
      ),
      dom.root,
    );

    const items = dom.root.querySelector<HTMLAnchorElement>('a[href="/items"]');
    const recent = dom.root.querySelector<HTMLAnchorElement>('a[href="/recent"]');
    const rail = dom.root.querySelector<HTMLButtonElement>('[aria-label="Recent rail"]');
    expect(items?.classList.contains("is-active")).toBe(true);
    expect(items?.getAttribute("aria-current")).toBe("page");
    expect(recent?.classList.contains("is-active")).toBe(false);
    expect(recent?.getAttribute("aria-current")).toBeNull();
    expect(rail?.classList.contains("is-active")).toBe(false);

    setActive("recent");
    expect(items?.classList.contains("is-active")).toBe(false);
    expect(items?.getAttribute("aria-current")).toBeNull();
    expect(recent?.classList.contains("is-active")).toBe(true);
    expect(recent?.getAttribute("aria-current")).toBe("page");
    expect(rail?.classList.contains("is-active")).toBe(true);

    dispose();
    dom.cleanup();
  });

  test("renders grouped actions beside the row control", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    let actionClicks = 0;
    const action = dom.document.createElement("button");
    action.type = "button";
    action.setAttribute("aria-label", "Grouped action");
    action.addEventListener("click", () => actionClicks++);

    const dispose = render(
      () => (
        <AppWorkspace.SidebarItem actions={<AppWorkspace.SidebarItemActions visibility="hover">{action}</AppWorkspace.SidebarItemActions>}>
          Item
        </AppWorkspace.SidebarItem>
      ),
      dom.root,
    );

    const row = dom.root.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-item-main");
    const group = dom.root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-actions");
    expect(row).not.toBeNull();
    expect(group?.getAttribute("data-visibility")).toBe("hover");
    expect(row?.contains(action)).toBe(false);

    action.click();
    expect(actionClicks).toBe(1);

    dispose();
    dom.cleanup();
  });

  test("runs progressive navigation only when a sidebar link opts in", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    let documentNavigations = 0;
    let enhancedNavigations = 0;
    const dispose = render(
      () => (
        <div>
          <AppWorkspace.SidebarItem href="/document" onNavigate={() => void documentNavigations++}>
            Document
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem href="/enhanced" navigation="enhanced" onNavigate={() => void enhancedNavigations++}>
            Enhanced
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarIconAction
            href="/document-icon"
            icon="ti ti-file"
            label="Document icon"
            onNavigate={() => void documentNavigations++}
          />
          <AppWorkspace.SidebarIconAction
            href="/enhanced-icon"
            navigation="enhanced"
            icon="ti ti-bolt"
            label="Enhanced icon"
            onNavigate={() => void enhancedNavigations++}
          />
          <AppWorkspace.NavTree ariaLabel="Navigation modes">
            <AppWorkspace.NavTree.Item
              id="document-tree"
              label="Document tree"
              href="/document-tree"
              onNavigate={() => void documentNavigations++}
            />
            <AppWorkspace.NavTree.Item
              id="enhanced-tree"
              label="Enhanced tree"
              href="/enhanced-tree"
              navigation="enhanced"
              onNavigate={() => void enhancedNavigations++}
            />
          </AppWorkspace.NavTree>
        </div>
      ),
      dom.root,
    );

    for (const href of ["/document", "/document-icon", "/document-tree", "/enhanced", "/enhanced-icon", "/enhanced-tree"])
      dom.root.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)?.click();
    await Promise.resolve();

    expect(documentNavigations).toBe(0);
    expect(enhancedNavigations).toBe(3);

    dispose();
    dom.cleanup();
  });

  test("keeps handlerless enhanced sidebar links on native document navigation", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const pushState = spyOn(window.history, "pushState");
    const dispose = render(
      () => (
        <div>
          <AppWorkspace.SidebarItem href="/handlerless" navigation="enhanced">
            Handlerless
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarIconAction
            href="/handlerless-icon"
            navigation="enhanced"
            icon="ti ti-link"
            label="Handlerless icon"
          />
        </div>
      ),
      dom.root,
    );

    dom.root.querySelector<HTMLAnchorElement>('a[href="/handlerless"]')?.click();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/handlerless-icon"]')?.click();
    expect(pushState).not.toHaveBeenCalled();

    dispose();
    pushState.mockRestore();
    dom.cleanup();
  });
});
