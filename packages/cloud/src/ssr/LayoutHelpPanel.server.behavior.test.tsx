import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { panelFixtureDocuments } from "../../../../scripts/fixtures/help-panel";
import { createDomTestHarness } from "../../../ui/test/dom";
import {
  PANEL_CONTEXT_CHANGED,
  PANEL_CONTEXT_ELEMENT,
  PANEL_SHORTCUTS_CHANGED,
  PANEL_SHORTCUTS_ELEMENT,
} from "../browser/panel-context-bridge";

const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Help panel state did not settle");
    await Bun.sleep(10);
  }
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const setup = async (seeded = false) => {
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: View } = await import("./HelpPanelView.island");
    const { default: Shortcuts } = await import("./HelpPanelShortcuts.island");
    const { default: Search } = await import("./HelpPanelSearch.island");
    const { default: Article } = await import("./HelpPanelArticle.island");
    const { default: Back } = await import("./HelpPanelBack.island");
    const { default: Menu } = await import("./HelpPanelMenu.island");
    const { helpPanelState } = await import("./layout-help-panel-state");
    dom.root.innerHTML = `<script id="${PANEL_CONTEXT_ELEMENT}" type="application/json">null</script><script id="${PANEL_SHORTCUTS_ELEMENT}" type="application/json">[]</script>
      <div class="help-shell" data-surface="panel"><header><solid-island data-part="back"></solid-island><input data-help-search type="search"></header>
      <div data-scroll-fade-mode="both"><div data-help-results><div data-help-start-content><solid-island data-part="view"></solid-island><button data-help-topic="roles">Roles</button><solid-island data-part="shortcuts"></solid-island></div><solid-island data-part="search"></solid-island></div>
      <solid-island data-part="article"></solid-island><span data-help-announcement></span></div><script data-help-panel-data type="application/json"></script></div>`;
    const root = dom.root.querySelector<HTMLElement>(".help-shell")!;
    root.querySelector("[data-help-panel-data]")!.textContent = JSON.stringify({
      documents: panelFixtureDocuments,
      appId: "spaces",
      pageBase: "/help/apps/spaces",
    });
    if (seeded) {
      root.dataset.helpInitialTopic = "share";
      root.querySelector<HTMLElement>("[data-help-results]")!.hidden = true;
      const article = document.createElement("article");
      article.className = "help-article";
      article.setAttribute("data-help-server-article", "");
      article.innerHTML =
        '<h3 class="help-article-title" tabindex="-1">Share a Space</h3><div class="help-document"><p>Seeded article.</p></div>';
      root.querySelector('[data-part="article"]')!.before(article);
      root.querySelector("[data-help-panel-data]")!.textContent = JSON.stringify({
        documents: panelFixtureDocuments,
        appId: "spaces",
        pageBase: "/help/apps/spaces",
        article: { id: "share", title: "Share a Space", locale: "en", kind: "task", markdown: "Seeded **Markdown**.", related: [] },
      });
    }
    const state = helpPanelState(root);
    const cleanups: (() => void)[] = [];
    const mount = (part: string, component: () => ReturnType<typeof createComponent>) => {
      const element = root.querySelector<HTMLElement>(`[data-part="${part}"]`)!;
      const dispose = render(
        () =>
          createComponent(LocaleProvider, {
            locale: "en",
            get children() {
              return component();
            },
          }),
        element,
      );
      cleanups.push(dispose);
      return dispose;
    };
    const context = (app: string, help: string[] = []) => {
      dom.document.getElementById(PANEL_CONTEXT_ELEMENT)!.textContent = JSON.stringify({
        v: 1,
        seq: 0,
        pageId: "22222222-2222-4222-8222-222222222222",
        app,
        help,
      });
      window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
    };
    const shortcuts = (commands: unknown[]) => {
      const element = dom.document.getElementById(PANEL_SHORTCUTS_ELEMENT)!;
      element.textContent = JSON.stringify(commands);
      element.setAttribute("data-received", "");
      window.dispatchEvent(new Event(PANEL_SHORTCUTS_CHANGED));
    };
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/search")) return Response.json({ ids: ["share"] });
          const id = url.split("/").at(-1);
          return Response.json({
            id,
            title: "Fixture",
            locale: "en",
            kind: "task",
            markdown: "Fixture",
            html: '<p>Fixture.</p><h2 id="invite">Invite</h2><details><summary>More</summary><h3 id="hidden">Hidden</h3></details><a href="/help/apps/spaces/roles">Roles</a>',
            related: [],
          });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    return {
      dom,
      root,
      state,
      View,
      Shortcuts,
      Search,
      Article,
      Back,
      Menu,
      mount,
      context,
      shortcuts,
      fetcher,
      cleanup: () => {
        for (const dispose of cleanups.reverse()) dispose();
        fetcher.mockRestore();
        dom.cleanup();
      },
    };
  };

  test("For this view follows authorized context ids and shortcuts honor empty host lists across remount", async () => {
    const fixture = await setup();
    const { root, mount, View, Shortcuts, context, shortcuts } = fixture;
    try {
      mount("view", () => createComponent(View, { topics: [panelFixtureDocuments[0]!] }));
      let disposeShortcuts = mount("shortcuts", () => createComponent(Shortcuts, { appName: "Spaces", platform: "other" }));
      const row = root.querySelector<HTMLButtonElement>('[data-help-view] [data-help-topic="share"]')!;
      row.focus();
      context("spaces", ["share"]);
      expect(root.querySelector('[data-help-view] [data-help-topic="share"]')).toBe(row);
      expect(document.activeElement).toBe(row);
      context("spaces", ["roles", "roles", "unknown", "share", "start", "roles"]);
      expect(
        [...root.querySelectorAll("[data-help-view] [data-help-topic]")].map((element) => element.getAttribute("data-help-topic")),
      ).toEqual(["roles", "share", "start"]);
      context("other", ["share"]);
      expect(root.querySelector("[data-help-view]")).toBeNull();
      context("spaces", ["share"]);
      shortcuts([{ id: "spaces.create", title: "Create Space", shortcut: "mod+n" }]);
      expect(root.querySelector("[data-help-shortcuts]")?.textContent).toContain("Create Space");
      shortcuts([]);
      expect(root.querySelectorAll(".help-shortcut")).toHaveLength(0);
      disposeShortcuts();
      disposeShortcuts = mount("shortcuts", () => createComponent(Shortcuts, { appName: "Spaces", platform: "other" }));
      expect(root.querySelectorAll(".help-shortcut")).toHaveLength(0);
      disposeShortcuts();
    } finally {
      fixture.cleanup();
    }
  });

  test("search adopts early text without replacing the field; slash and Escape preserve panel ownership", async () => {
    const fixture = await setup();
    const { root, mount, Search, state } = fixture;
    const field = root.querySelector<HTMLInputElement>("[data-help-search]")!;
    field.value = "Share";
    field.focus();
    field.setSelectionRange?.(2, 2);
    try {
      mount("search", () => createComponent(Search, {}));
      await until(() => !!root.querySelector("[data-help-search-results]"));
      expect(root.querySelector("[data-help-search]")).toBe(field);
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe("Share");
      const clear = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      field.dispatchEvent(clear);
      expect(clear.defaultPrevented).toBe(true);
      expect(field.value).toBe("");
      const close = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      field.dispatchEvent(close);
      expect(close.defaultPrevented).toBe(false);
      field.value = "Roles";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("[data-help-topic]")!.focus();
      const elsewhere = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(elsewhere);
      expect(elsewhere.defaultPrevented).toBe(false);
      expect(field.value).toBe("Roles");
      const slash = new KeyboardEvent("keydown", { key: "/", shiftKey: true, bubbles: true, cancelable: true });
      root.dispatchEvent(slash);
      expect(slash.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(field);
      // Today's TextInput emits while composing too; only shortcut handling suppresses isComposing.
      field.value = "Share";
      field.dispatchEvent(Object.assign(new Event("input", { bubbles: true }), { isComposing: true }));
      expect(state.query()).toBe("Share");
      const composing = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
      field.dispatchEvent(composing);
      expect(composing.defaultPrevented).toBe(false);
      const modified = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
      root.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("topic buttons, Help links and Back navigate in place and clearing article search returns to the article", async () => {
    const fixture = await setup();
    const { root, mount, Article, Back, Search, state } = fixture;
    try {
      mount("article", () => createComponent(Article, {}));
      mount("back", () => createComponent(Back, { back: false, tile: "ti ti-box" }));
      mount("search", () => createComponent(Search, {}));
      root.querySelector<HTMLButtonElement>('[data-help-topic="roles"]')!.click();
      await until(() => !!root.querySelector(".help-document a"));
      expect(state.activeId()).toBe("roles");
      expect(state.view()).toBe("article");
      const before = location.href;
      const link = root.querySelector<HTMLAnchorElement>(".help-document a")!;
      link.setAttribute("href", "/help/apps/spaces/share");
      link.click();
      await until(() => state.activeId() === "share" && !!root.querySelector(".help-document a"));
      expect(location.href).toBe(before);
      state.changeQuery("roles");
      expect(state.view()).toBe("hub");
      state.changeQuery("");
      expect(state.view()).toBe("article");
      expect(state.activeId()).toBe("share");
      root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      expect(state.view()).toBe("hub");
      expect(root.querySelector<HTMLElement>("[data-help-results]")!.hidden).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
  test("a section chunk never replaces its static trigger during a pointer press", async () => {
    const fixture = await setup(true);
    const { root, mount, Article } = fixture;
    const article = root.querySelector<HTMLElement>("[data-help-server-article]")!;
    const tools = document.createElement("div");
    tools.innerHTML = "<button data-help-sections>On this page</button>";
    article.append(tools);
    const trigger = tools.querySelector("button")!;
    try {
      mount("article", () => createComponent(Article, {}));
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await import("./layout-help-panel-reader");
      await Promise.resolve();
      expect(tools.querySelector("button")).toBe(trigger);
      window.dispatchEvent(new Event("pointerup"));
      await until(() => tools.querySelector("button") !== trigger);
      expect(trigger.isConnected).toBe(false);
      expect(tools.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  test("the server article survives Back and reopening, and menu copy writes synchronously from its shared payload", async () => {
    const fixture = await setup(true);
    const { root, mount, Article, Back, Menu, state, fetcher } = fixture;
    const wrapper = document.createElement("solid-island");
    wrapper.dataset.part = "menu";
    root.querySelector("header")!.append(wrapper);
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const serverArticle = root.querySelector<HTMLElement>("[data-help-server-article]")!;
    try {
      mount("article", () => createComponent(Article, {}));
      mount("back", () => createComponent(Back, { back: true, tile: "ti ti-box" }));
      mount("menu", () => createComponent(Menu, {}));
      root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      expect(serverArticle.hidden).toBe(true);
      state.open("share");
      expect(serverArticle.hidden).toBe(false);
      expect(root.querySelector("[data-help-server-article]")).toBe(serverArticle);
      root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!root.querySelector('[role="menuitem"] .ti-markdown'));
      const copy = root.querySelector('[role="menuitem"] .ti-markdown')!.closest<HTMLButtonElement>("button")!;
      copy.click();
      expect(write.mock.calls[0]?.[0]).toContain("Seeded **Markdown**.");
      expect(fetcher).not.toHaveBeenCalled();
      await until(() => !!root.querySelector("[data-help-announcement]")?.textContent);
    } finally {
      write.mockRestore();
      fixture.cleanup();
    }
  });
}
