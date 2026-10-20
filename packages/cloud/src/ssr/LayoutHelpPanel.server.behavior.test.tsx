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
import { formatHelpDocumentMarkdown } from "./layout-help-markdown";

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
    const context = (app: string | null, help: string[] = []) => {
      dom.document.getElementById(PANEL_CONTEXT_ELEMENT)!.textContent = JSON.stringify(
        app === null
          ? null
          : {
              v: 1,
              seq: 0,
              pageId: "22222222-2222-4222-8222-222222222222",
              app,
              ...(help.length ? { help } : {}),
            },
      );
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
      context(null);
      expect(root.querySelector("[data-help-view]")).toBeNull();
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

  for (const { beforeMount, empty } of [
    { beforeMount: false, empty: false },
    { beforeMount: true, empty: false },
    { beforeMount: true, empty: true },
  ])
    test(`host shortcuts ${beforeMount ? "before" : "after"} mount${empty ? " (empty)" : ""} replace groups and null context restores the seed`, async () => {
      const fixture = await setup();
      const { root, mount, Shortcuts, Search, state, context, shortcuts } = fixture;
      const seed = ["Open global search", "Open shortcut help", "Open or close the panel"];
      const snapshot = [
        { id: "cloud.panel", title: "Open or close the panel", shortcut: "mod+j" },
        { id: "spaces.new", title: "New Space", shortcut: "mod+n" },
      ];
      const titles = (scope: string) =>
        [...root.querySelectorAll(`[data-help-shortcut-group="${scope}"] .help-shortcut-title`)].map((el) => el.textContent);
      context("spaces");
      if (beforeMount) shortcuts(empty ? [] : snapshot);
      try {
        mount("shortcuts", () => createComponent(Shortcuts, { appName: "Spaces", platform: "apple" }));
        mount("search", () => createComponent(Search, {}));
        if (!beforeMount) {
          expect(titles("everywhere")).toEqual(seed);
          // A received empty snapshot can arrive with only the context event.
          const element = document.getElementById(PANEL_SHORTCUTS_ELEMENT)!;
          element.textContent = "[]";
          element.setAttribute("data-received", "");
          context("spaces");
          expect(titles("everywhere")).toEqual([]);
          shortcuts(snapshot);
        }
        expect(titles("everywhere")).toEqual(empty ? [] : ["Open or close the panel"]);
        expect(titles("app")).toEqual(empty ? [] : ["New Space"]);
        if (empty) expect(root.querySelectorAll(".help-shortcut")).toHaveLength(0);
        shortcuts([]);
        expect(titles("everywhere")).toEqual([]);
        expect(titles("app")).toEqual([]);
        const input = root.querySelector<HTMLInputElement>("[data-help-search]")!;
        input.value = "Article";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await until(() => state.query() === "Article");
        expect(root.querySelector<HTMLElement>("[data-help-start-content]")!.hidden).toBe(true);
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(root.querySelector<HTMLElement>("[data-help-start-content]")!.hidden).toBe(false);
        expect(root.querySelectorAll(".help-shortcut")).toHaveLength(0);
        context(null);
        expect(titles("everywhere")).toEqual(seed);
        expect(titles("app")).toEqual([]);
        expect(root.querySelector(".k2b-kbd__keys")?.textContent).toBe("⌘K");
        context("spaces");
        shortcuts([
          ...seed.map((title, i) => ({
            id: ["cloud.search", "cloud.help", "cloud.panel"][i],
            title,
            shortcut: ["mod+k", "shift+/", "mod+j"][i],
          })),
          ...snapshot.slice(1),
          { id: "spaces.delete", title: "Delete selected", shortcut: "delete", scope: "selection" },
        ]);
        expect(titles("everywhere")).toEqual(seed);
        expect(root.querySelector('[data-help-shortcut-group="app"]')?.textContent).toContain("In Spaces");
        expect(root.querySelector('[data-help-shortcut-group="selection"]')?.textContent).toContain("With a selection");
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
      const editableSlash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      field.dispatchEvent(editableSlash);
      expect(editableSlash.defaultPrevented).toBe(false);
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
    const { root, mount, Article, Back, Search, Menu, state } = fixture;
    Object.assign(fixture.dom.window.happyDOM.settings.navigation, {
      disableMainFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    });
    const push = spyOn(history, "pushState");
    const replace = spyOn(history, "replaceState");
    const menuWrapper = document.createElement("solid-island");
    menuWrapper.dataset.part = "menu";
    root.querySelector("header")!.append(menuWrapper);
    try {
      mount("article", () => createComponent(Article, {}));
      mount("menu", () => createComponent(Menu, {}));
      mount("back", () => createComponent(Back, { back: false, tile: "ti ti-box" }));
      mount("search", () => createComponent(Search, {}));
      root.querySelector<HTMLButtonElement>('[data-help-topic="roles"]')!.click();
      await until(() => !!root.querySelector(".help-document a"));
      expect(state.activeId()).toBe("roles");
      expect(state.view()).toBe("article");
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      const before = location.href;
      const link = root.querySelector<HTMLAnchorElement>(".help-document a")!;
      const follow = (href: string) => {
        link.setAttribute("href", href);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(follow("/help/apps/mail/mail-share")).toBe(false);
      expect(follow("/app/spaces")).toBe(false);
      expect(follow("/help/apps/spaces/share")).toBe(true);
      await until(() => state.activeId() === "share" && !!root.querySelector(".help-document a"));
      expect(location.href).toBe(before);
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!root.querySelector('[role="menuitem"][href]'));
      expect(root.querySelector('[role="menuitem"][href]')?.getAttribute("href")).toBe("/help/apps/spaces/share");
      state.changeQuery("roles");
      expect(state.view()).toBe("hub");
      state.changeQuery("");
      expect(state.view()).toBe("article");
      expect(state.activeId()).toBe("share");
      root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      expect(state.view()).toBe("hub");
      expect(root.querySelector<HTMLElement>("[data-help-results]")!.hidden).toBe(false);
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    } finally {
      push.mockRestore();
      replace.mockRestore();
      fixture.cleanup();
    }
  });
  test("returning from a search keeps the article's place and does not replay its section jump", async () => {
    const fixture = await setup();
    const { root, mount, Article, Search, state } = fixture;
    // The scroll area has no layout here; keep its position as the browser would.
    const scroller = root.querySelector<HTMLElement>("[data-scroll-fade-mode]")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (value: number) => (top = value), configurable: true });
    const jumps = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      mount("article", () => createComponent(Article, {}));
      mount("search", () => createComponent(Search, {}));
      state.open("roles", "invite");
      await until(() => jumps.mock.calls.length === 1);
      top = 240;
      state.changeQuery("roles");
      top = 0;
      state.changeQuery("");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(state.view()).toBe("article");
      expect(top).toBe(240);
      expect(jumps).toHaveBeenCalledTimes(1);
    } finally {
      jumps.mockRestore();
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

  test("a failed menu chunk offers Reload and reloads the page", async () => {
    const fixture = await setup();
    const { root, mount, Menu } = fixture;
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    const load = spyOn(helpPanelModules, "menu").mockRejectedValue(new Error("Menu chunk unavailable"));
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    const wrapper = document.createElement("solid-island");
    wrapper.dataset.part = "menu";
    root.querySelector("header")!.append(wrapper);
    try {
      mount("menu", () => createComponent(Menu, {}));
      root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => wrapper.textContent!.includes("Help could not be loaded"));
      const recovery = [...wrapper.querySelectorAll("button")].find((button) => button.textContent === "Reload");
      expect(recovery).toBeDefined();
      recovery!.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
      reload.mockRestore();
      fixture.cleanup();
    }
  });

  test("a failed article document fetch offers Try again and refetches", async () => {
    const fixture = await setup();
    const { root, mount, Article, fetcher } = fixture;
    fetcher.mockRejectedValueOnce(new Error("Document network unavailable"));
    try {
      mount("article", () => createComponent(Article, {}));
      root.querySelector<HTMLButtonElement>('[data-help-topic="roles"]')!.click();
      await until(() => !!root.querySelector(".help-article")?.textContent?.includes("Document network unavailable"));
      const recovery = [...root.querySelectorAll<HTMLButtonElement>(".help-article button")].find(
        (button) => button.textContent === "Try again",
      );
      expect(recovery).toBeDefined();
      expect(root.querySelector(".help-article")!.textContent).not.toContain("Reload");
      recovery!.click();
      await until(() => !!root.querySelector(".help-document a"));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      fixture.cleanup();
    }
  });

  test("a failed search warm-up stays silent until typing, then offers Reload", async () => {
    const fixture = await setup();
    const { root, mount, Search } = fixture;
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    const load = spyOn(helpPanelModules, "search").mockRejectedValue(new Error("Search chunk unavailable"));
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    try {
      mount("search", () => createComponent(Search, {}));
      const field = root.querySelector<HTMLInputElement>("[data-help-search]")!;
      field.focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(root.textContent).not.toContain("Help could not be loaded");
      field.value = "Roles";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await until(() => root.textContent!.includes("Help could not be loaded"));
      const recovery = [...root.querySelectorAll("button")].find((button) => button.textContent === "Reload");
      expect(recovery).toBeDefined();
      recovery!.click();
      expect(reload).toHaveBeenCalledTimes(1);
      // Clearing the field by any means shows the start again.
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      expect(root.textContent).not.toContain("Help could not be loaded");
      expect(root.querySelector<HTMLElement>("[data-help-start-content]")!.hidden).toBe(false);
    } finally {
      load.mockRestore();
      reload.mockRestore();
      fixture.cleanup();
    }
  });

  test.each(["reader", "document"] as const)("a failed article %s chunk offers Reload", async (chunk) => {
    const fixture = await setup();
    const { root, mount, Article } = fixture;
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    const load = spyOn(helpPanelModules, chunk).mockRejectedValue(new Error("Article chunk unavailable"));
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    try {
      mount("article", () => createComponent(Article, {}));
      root.querySelector<HTMLButtonElement>('[data-help-topic="roles"]')!.click();
      await until(() => !!root.querySelector(".help-article")?.textContent?.includes("Article chunk unavailable"));
      const recovery = [...root.querySelectorAll<HTMLButtonElement>(".help-article button")].find(
        (button) => button.textContent === "Reload",
      );
      expect(recovery).toBeDefined();
      recovery!.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
      reload.mockRestore();
      fixture.cleanup();
    }
  });

  test("a failed section-menu warm-up stays silent until activation, then offers Reload", async () => {
    const fixture = await setup(true);
    const { root, mount, Article } = fixture;
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    const load = spyOn(helpPanelModules, "reader").mockRejectedValue(new Error("Section chunk unavailable"));
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    const tools = document.createElement("div");
    tools.innerHTML = "<button data-help-sections>On this page</button>";
    root.querySelector("[data-help-server-article]")!.append(tools);
    const trigger = tools.querySelector("button")!;
    try {
      mount("article", () => createComponent(Article, {}));
      trigger.focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(root.textContent).not.toContain("Section chunk unavailable");
      trigger.click();
      await until(() => root.textContent!.includes("Section chunk unavailable"));
      const recovery = [...root.querySelectorAll("button")].find((button) => button.textContent === "Reload");
      expect(recovery).toBeDefined();
      recovery!.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
      reload.mockRestore();
      fixture.cleanup();
    }
  });

  test("a delayed menu activation preserves focus moved to the search field and leaves the menu closed", async () => {
    const fixture = await setup();
    const { root, mount, Menu } = fixture;
    const menu = await import("./layout-help-panel-menu");
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    let release: (() => void) | undefined;
    const load = spyOn(helpPanelModules, "menu").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(menu);
        }),
    );
    const wrapper = document.createElement("solid-island");
    wrapper.dataset.part = "menu";
    root.querySelector("header")!.append(wrapper);
    try {
      mount("menu", () => createComponent(Menu, {}));
      const trigger = root.querySelector<HTMLButtonElement>("[data-help-menu]")!;
      trigger.focus();
      trigger.click();
      const field = root.querySelector<HTMLInputElement>("[data-help-search]")!;
      field.focus();
      await until(() => !!release);
      release!();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(field);
      expect(root.querySelector('[role="menu"]')).toBeNull();
      expect(root.querySelector("[data-help-menu]")).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    } finally {
      load.mockRestore();
      fixture.cleanup();
    }
  });

  test("a click on the light menu trigger opens the menu while focus stays in the search field, as in Safari", async () => {
    const fixture = await setup();
    const { root, mount, Menu } = fixture;
    const menu = await import("./layout-help-panel-menu");
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    let release: (() => void) | undefined;
    const load = spyOn(helpPanelModules, "menu").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(menu);
        }),
    );
    const wrapper = document.createElement("solid-island");
    wrapper.dataset.part = "menu";
    root.querySelector("header")!.append(wrapper);
    try {
      mount("menu", () => createComponent(Menu, {}));
      const field = root.querySelector<HTMLInputElement>("[data-help-search]")!;
      field.focus();
      // Safari does not focus a clicked button, so focus stays in the field.
      root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!release);
      release!();
      // The real Dropdown replaced the light trigger; the DOM test has no popover top layer to read focus or "open" from.
      await until(() => !!root.querySelector('[role="menu"] [role="menuitem"]'));
    } finally {
      load.mockRestore();
      fixture.cleanup();
    }
  });

  test("a delayed section-menu activation preserves focus moved to the search field and leaves the menu closed", async () => {
    const fixture = await setup(true);
    const { root, mount, Article } = fixture;
    const reader = await import("./layout-help-panel-reader");
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    let release: (() => void) | undefined;
    const load = spyOn(helpPanelModules, "reader").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(reader);
        }),
    );
    const tools = document.createElement("div");
    tools.innerHTML = "<button data-help-sections>On this page</button>";
    root.querySelector("[data-help-server-article]")!.append(tools);
    const trigger = tools.querySelector("button")!;
    try {
      mount("article", () => createComponent(Article, {}));
      trigger.focus();
      trigger.click();
      const field = root.querySelector<HTMLInputElement>("[data-help-search]")!;
      field.focus();
      await until(() => !!release);
      release!();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(field);
      expect(root.querySelector('[role="menu"]')).toBeNull();
      expect(tools.querySelector("button")).toBe(trigger);
    } finally {
      load.mockRestore();
      fixture.cleanup();
    }
  });

  test("a section-menu activation still loading when the reader goes Back opens no menu on the hidden article", async () => {
    const fixture = await setup(true);
    const { root, mount, Article, Back, state } = fixture;
    const reader = await import("./layout-help-panel-reader");
    const { helpPanelModules } = await import("./layout-help-panel-modules");
    let release: (() => void) | undefined;
    const load = spyOn(helpPanelModules, "reader").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(reader);
        }),
    );
    const tools = document.createElement("div");
    tools.innerHTML = "<button data-help-sections>On this page</button>";
    root.querySelector("[data-help-server-article]")!.append(tools);
    const trigger = tools.querySelector("button")!;
    try {
      mount("article", () => createComponent(Article, {}));
      mount("back", () => createComponent(Back, { back: true, tile: "ti ti-box" }));
      trigger.focus();
      trigger.click();
      await until(() => !!release);
      root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      expect(state.view()).toBe("hub");
      (document.activeElement as HTMLElement | null)?.blur();
      release!();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(root.querySelector('[role="menu"]')).toBeNull();
      expect(tools.querySelector("button")).toBe(trigger);
      expect(trigger.contains(document.activeElement)).toBe(false);
    } finally {
      load.mockRestore();
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
    const before = serverArticle.innerHTML;
    try {
      mount("article", () => createComponent(Article, {}));
      mount("back", () => createComponent(Back, { back: true, tile: "ti ti-box" }));
      mount("menu", () => createComponent(Menu, {}));
      root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      expect(serverArticle.hidden).toBe(true);
      state.open("share");
      expect(serverArticle.hidden).toBe(false);
      expect(root.querySelector("[data-help-server-article]")).toBe(serverArticle);
      expect(serverArticle.innerHTML).toBe(before);
      root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!root.querySelector('[role="menuitem"] .ti-markdown'));
      const copy = root.querySelector('[role="menuitem"] .ti-markdown')!.closest<HTMLButtonElement>("button")!;
      copy.click();
      const topic = state.data.documents.find((topic) => topic.id === "share")!;
      expect(write).toHaveBeenCalledWith(formatHelpDocumentMarkdown({ ...topic, markdown: state.data.article!.markdown }));
      expect(fetcher).not.toHaveBeenCalled();
      await until(() => !!root.querySelector("[data-help-announcement]")?.textContent);
      await until(() => root.querySelector("[data-help-menu]")?.getAttribute("aria-expanded") !== "true");
    } finally {
      write.mockRestore();
      fixture.cleanup();
    }
  });
}
