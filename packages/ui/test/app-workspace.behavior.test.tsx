import { describe, expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui AppWorkspace behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("fades only scrollable sidebar content and clears the hint at the end", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const dispose = render(() => <AppWorkspace.SidebarBody scrollFade><div>Chats</div></AppWorkspace.SidebarBody>, dom.root);
    try {
      const body = dom.root.firstElementChild as HTMLElement;
      Object.defineProperties(body, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { value: 200 } });
      body.dispatchEvent(new Event("scroll"));
      expect(body.dataset.scrollFade).toBe("bottom");
      body.scrollTop = 300;
      body.dispatchEvent(new Event("scroll"));
      expect(body.dataset.scrollFade).toBe("top");
      body.scrollTop = 0;
      Object.defineProperty(body, "scrollHeight", { value: 200 });
      body.dispatchEvent(new Event("scroll"));
      expect(body.dataset.scrollFade).toBeUndefined();
    } finally { dispose(); dom.cleanup(); }
  });

  test("keeps main pane content mounted when visibility inputs and mobile selection change", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const [count, setCount] = createSignal(1);
    const [mobile, setMobile] = createSignal("chat");
    const [chatOpen, setChatOpen] = createSignal(true);
    let mounts = 0;
    const Content = () => { mounts++; return <input aria-label="Draft" />; };
    const dispose = render(() => <AppWorkspace.Main mobilePane={mobile()}>
      <AppWorkspace.MainPane id="chat" label="Chat" open={chatOpen()}><div>Chat</div></AppWorkspace.MainPane>
      <AppWorkspace.MainPane id="workspace" label="Workspace" open={count() > 0}><Content /></AppWorkspace.MainPane>
    </AppWorkspace.Main>, dom.root);
    try {
      const input = dom.root.querySelector<HTMLInputElement>("input")!;
      input.value = "Keep my draft";
      setCount(2);
      setMobile("workspace");
      expect(mounts).toBe(1);
      expect(dom.root.querySelector("input")).toBe(input);
      expect(input.value).toBe("Keep my draft");
      expect(dom.root.querySelector('[data-workspace-main-region="workspace"]')?.getAttribute("data-workspace-mobile-active")).toBe("true");
      setChatOpen(false);
      expect(dom.root.querySelector("input")).toBe(input);
      expect(dom.root.querySelector('[data-workspace-main-region="workspace"]')?.classList.contains("is-primary")).toBe(true);
      expect(dom.root.querySelectorAll('[role="separator"]').length).toBe(0);
      setChatOpen(true);
      expect(dom.root.querySelector("input")).toBe(input);
      expect(dom.root.querySelectorAll('[role="separator"]').length).toBe(1);
      setCount(0);
      expect(dom.root.querySelector("input")).toBeNull();
      setCount(1);
      expect(mounts).toBe(2);
    } finally { dispose(); dom.cleanup(); }
  });

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

  test("updates compound slots and preview content without replacing focused controls", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const [title, setTitle] = createSignal("Import");
    const [status, setStatus] = createSignal("Reading");
    const [count, setCount] = createSignal(1);
    const [disabled, setDisabled] = createSignal(false);
    let selections = 0;
    const openings: boolean[] = [];
    const dispose = render(() => <AppWorkspace.SidebarItem variant="card" context={status()} contextMeta={count()} description={status()}
      preview={{ label: "Details", viewportSize: "compact", onOpenChange: open => openings.push(open), content: <input aria-label="Preview note" value={status()} /> }}>
      <AppWorkspace.SidebarItemIcon icon={count() === 1 ? "ti ti-clock" : "ti ti-check"} />
      <AppWorkspace.SidebarItemLabel>{title()}</AppWorkspace.SidebarItemLabel>
      <AppWorkspace.SidebarItemMeta>{count()}</AppWorkspace.SidebarItemMeta>
      <AppWorkspace.SidebarItemAction label={status()} icon="ti ti-check" disabled={disabled()} onSelect={() => { selections++; }} />
    </AppWorkspace.SidebarItem>, dom.root);
    try {
      const control = dom.root.querySelector<HTMLButtonElement>('[aria-label="Reading"]')!;
      const note = dom.root.querySelector<HTMLInputElement>('[aria-label="Preview note"]')!;
      control.focus();
      setTitle("Stock import"); setStatus("Verified"); setCount(3);
      expect(dom.root.textContent).toContain("Stock import");
      expect(dom.root.querySelector(".k2b-app-workspace__sidebar-item-meta")?.textContent).toBe("3");
      expect(dom.root.querySelector(".k2b-app-workspace__sidebar-item-icon i")?.className).toBe("ti ti-check");
      expect(control.getAttribute("aria-label")).toBe("Verified");
      expect(dom.document.activeElement).toBe(control);
      expect(dom.root.querySelector('[aria-label="Preview note"]')).toBe(note);
      expect(note.value).toBe("Verified");
      expect(dom.root.querySelector('[data-variant="card"]')).not.toBeNull();
      expect(dom.root.querySelector('.k2b-app-workspace__sidebar-item-context-label')?.textContent).toBe("Verified");
      expect(dom.root.querySelector('.k2b-app-workspace__sidebar-item-context-meta')?.textContent).toBe("3");
      expect(dom.root.querySelector('.k2b-app-workspace__sidebar-item-label')?.getAttribute("data-marquee")).toBe("false");
      setDisabled(true);
      expect(control.disabled).toBe(true);
      control.click();
      expect(selections).toBe(0);
      setDisabled(false);
      control.click();
      expect(selections).toBe(1);
      expect(openings).toEqual([]);
      const panel = dom.root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-preview")!;
      expect(panel.querySelector(".k2b-scroll-area")?.getAttribute("data-viewport-size")).toBe("compact");
      for (const newState of ["open", "closed"]) {
        const event = new Event("toggle");
        Object.defineProperty(event, "newState", { value: newState });
        panel.dispatchEvent(event);
      }
      expect(openings).toEqual([true, false]);
    } finally { dispose(); dom.cleanup(); }
  });

  test("collapsible sections keep content mounted and count reactive", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const [count, setCount] = createSignal(0);
    const dispose = render(() => <AppWorkspace.SidebarSection title="Done" count={count()} collapsible defaultOpen={false}>
      <input aria-label="Retained value" />
    </AppWorkspace.SidebarSection>, dom.root);
    try {
      const toggle = dom.root.querySelector<HTMLButtonElement>("button")!;
      const content = dom.root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-section-content")!;
      const input = dom.root.querySelector<HTMLInputElement>("input")!;
      input.value = "Keep";
      expect(content.hidden).toBe(true);
      setCount(2); toggle.click();
      expect(toggle.textContent).toContain("2");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(content.hidden).toBe(false);
      toggle.click();
      expect(content.hidden).toBe(true);
      expect(input.value).toBe("Keep");
    } finally { dispose(); dom.cleanup(); }
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
