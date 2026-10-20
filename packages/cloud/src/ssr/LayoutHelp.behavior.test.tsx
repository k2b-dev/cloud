import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { HelpDocumentManifest } from "../shared/help";

const documents: HelpDocumentManifest[] = ["first", "second", "third"].map((id, order) => ({
  id,
  title: `Article ${id}`,
  order,
  url: `/api/help/${id}`,
  searchUrl: "/api/help/search",
}));
const html =
  '<h2 id="steps">Steps</h2><a href="/app/spaces/help/second">Second</a><a href="/help/apps/spaces/third#steps">Third</a><a href="#steps">Section</a><a href="https://other.test/help">External</a><a href="/app/spaces/help/missing">Unknown</a><a href="/app/spaces/help">Hub</a>';
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Help did not reach the expected state");
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const setup = async (
    surface: "modal" | "page" | "embedded",
    initialTopic?: string,
    path = "/help/apps/spaces/first",
    articleHtml = html,
    options: { documents?: HelpDocumentManifest[]; help?: string[]; searchFails?: boolean; helpFailed?: boolean } = {},
  ) => {
    const dom = createDomTestHarness();
    Object.assign(dom.window.happyDOM.settings.navigation, {
      disableMainFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    });
    // A query string, such as a campaign tag from a mail, must not keep Back from showing this article again.
    dom.window.happyDOM.setURL(`http://localhost${path}?source=mail`);
    history.replaceState(null, "", `${path}?source=mail`);
    const { LayoutHelpPage, openLayoutHelpDialog } = await import("./LayoutHelp");
    const { dialogCore } = await import("@k2b/ui");
    const { LayoutHelpDocuments } = await import("./layout-help-registry");
    const { ShellDataProvider } = await import("./shell-data");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo) => {
          if (String(input).includes("/search?"))
            return options.searchFails ? new Response("Unavailable", { status: 503 }) : Response.json({ ids: ["second"] });
          const id = String(input).split("/").at(-1) ?? "first";
          const link = (appId: string, documentId: string) => ({
            appId,
            appName: appId,
            documentId,
            title: `Article ${documentId}`,
            url: `/help/apps/${appId}/${documentId}`,
          });
          return Response.json({
            id,
            locale: "en",
            title: `Article ${id}`,
            markdown: "Steps",
            html: articleHtml,
            kind: "task",
            needs: "edit",
            next: link("spaces", "second"),
            related: [link("spaces", "third"), link("mail", "mail-share")],
          });
        },
        { preconnect: () => {} },
      ),
    );
    // The shell data's script carries the current app to the dialog, which renders outside this tree.
    const dispose = render(
      () => (
        <ShellDataProvider
          data={{
            apps: [
              { id: "spaces", label: "Spaces", iconClass: "ti ti-box", href: "/app/spaces", match: "/app/spaces", defaultVisible: true },
            ],
            legalLinks: [],
            searchLinks: {},
            theme: "light",
            appId: "spaces",
            accent: "#16a34a",
            help: options.help,
            ...(options.helpFailed ? { helpFailed: true as const } : {}),
          }}
        >
          {surface === "modal" ? (
            <LayoutHelpDocuments documents={options.documents ?? documents} pageBase="/app/spaces/help" />
          ) : (
            <LayoutHelpPage
              documents={options.documents ?? documents}
              initialTopic={initialTopic}
              embedded={surface === "embedded"}
              pageBase="/app/spaces/help"
            />
          )}
        </ShellDataProvider>
      ),
      dom.root,
    );
    if (surface === "modal") openLayoutHelpDialog();
    const button = (text: string) => {
      const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
      if (!found) throw new Error(`Missing Help button: ${text}`);
      return found;
    };
    const clickLink = (text: string, options: MouseEventInit = {}) => {
      const anchor = [...dom.document.querySelectorAll<HTMLAnchorElement>(".help-document a")].find(
        (anchor) => anchor.textContent === text,
      );
      if (!anchor) throw new Error(`Missing Help link: ${text}`);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
      anchor.dispatchEvent(event);
      return event;
    };
    const title = () => dom.document.querySelector("article h3")?.textContent ?? "";
    return {
      dom,
      button,
      clickLink,
      title,
      fetch,
      cleanup: async () => {
        dialogCore.close();
        await Bun.sleep(20);
        dispose();
        fetch.mockRestore();
        dom.cleanup();
      },
    };
  };

  test("same-article section links open every enclosing details element", async () => {
    const reader = await setup(
      "page",
      "first",
      "/help/apps/spaces/first",
      '<a href="#hidden">Hidden section</a><details><summary>Outer</summary><details><summary>Inner</summary><h2 id="hidden">Hidden</h2></details></details>',
    );
    try {
      await until(() => !!reader.dom.document.querySelector(".help-document a"));
      const details = [...reader.dom.document.querySelectorAll<HTMLDetailsElement>(".help-document details")];
      expect(details).toHaveLength(2);
      expect(details.every((element) => !element.open)).toBe(true);
      expect(reader.clickLink("Hidden section").defaultPrevented).toBe(true);
      await until(() => details.every((element) => element.open));
      expect(details.map((element) => element.open)).toEqual([true, true]);
    } finally {
      await reader.cleanup();
    }
  });

  for (const surface of ["modal", "page", "embedded"] as const) {
    test(`${surface}: same-app article and section links stay in Help; modified and external links keep native behavior`, async () => {
      const reader = await setup(surface, "first");
      try {
        if (surface === "modal") {
          await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
          reader.button("Article first").click();
        }
        await until(() => !!reader.dom.document.querySelector(".help-document a"));
        const initialHref = location.href;
        for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
          expect(reader.clickLink("Second", options).defaultPrevented).toBe(false);
        expect(reader.clickLink("External").defaultPrevented).toBe(false);
        expect(reader.clickLink("Unknown").defaultPrevented).toBe(false);
        const external = reader.dom.document.querySelector<HTMLAnchorElement>('.help-document a[href="https://other.test/help"]');
        expect(external).not.toBeNull();
        expect(reader.clickLink("Second").defaultPrevented).toBe(true);
        await until(() => reader.title() === "Article second" && !!reader.dom.document.querySelector(".help-document a"));
        if (surface !== "page") expect(location.href).toBe(initialHref);
        else {
          expect(location.pathname).toBe("/app/spaces/help/second");
          history.back();
          await until(() => reader.title() === "Article first");
          expect(location.pathname).toBe("/help/apps/spaces/first");
        }
        const scrolled: string[] = [];
        const scroll = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
          scrolled.push(this.id);
        });
        expect(reader.clickLink("Third").defaultPrevented).toBe(true);
        await until(() => reader.title() === "Article third" && scrolled.includes("steps"));
        scroll.mockRestore();
        if (surface !== "page") expect(location.href).toBe(initialHref);
        else expect(location.hash).toBe("#steps");
        expect(reader.clickLink("Section").defaultPrevented).toBe(true);
        if (surface !== "page") expect(location.href).toBe(initialHref);
        expect(reader.clickLink("Hub").defaultPrevented).toBe(true);
        await until(() => !!reader.dom.document.querySelector("[data-help-results]"));
        if (surface === "page") expect(location.pathname).toBe("/app/spaces/help");
      } finally {
        await reader.cleanup();
      }
    });
  }

  for (const surface of ["modal", "page"] as const) {
    test(`${surface}: Back reveals shortcuts beside the persistent, usable search`, async () => {
      const reader = await setup(surface, "first");
      const { registerContextAwareCommand } = await import("../browser/command-bridge");
      const unregister = registerContextAwareCommand({
        id: "test.keys",
        title: "Test shortcut",
        description: "Test keys",
        shortcut: "mod+k",
        action() {},
      });
      try {
        if (surface === "modal") {
          await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
          reader.button("Article first").click();
        }
        await until(() => reader.title() === "Article first");
        const input = search(reader);
        const back = reader.dom.document.querySelector<HTMLButtonElement>(".help-head-back");
        expect(back).not.toBeNull();
        back!.click();
        await until(() => !!reader.dom.document.querySelector("[data-help-shortcuts] .k2b-kbd__key"));
        input.focus();
        expect(document.activeElement).toBe(input);
        expect(search(reader)).toBe(input);
        expect(reader.dom.document.querySelectorAll("dialog")).toHaveLength(surface === "modal" ? 1 : 0);
        if (surface === "page") expect(location.pathname).toBe("/app/spaces/help");
      } finally {
        unregister();
        await reader.cleanup();
      }
    });
  }

  // The phone menu and dialogs with a history entry push the page's own address and go back from it.
  const leaveSameAddressEntry = async () => {
    let popped = false;
    window.addEventListener("popstate", () => (popped = true), { once: true });
    history.pushState({ cloudMobileMenu: true }, "");
    history.back();
    await until(() => popped);
    await Bun.sleep(30);
  };
  const search = (reader: { dom: ReturnType<typeof createDomTestHarness> }) => {
    const input = reader.dom.document.querySelector<HTMLInputElement>("[data-help-search]");
    if (!input) throw new Error("Missing Help search");
    return input;
  };
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  test("page: a history entry on the same address leaves the open article where the reader is", async () => {
    const reader = await setup("page", "first");
    try {
      await until(() => !!reader.dom.document.querySelector(".help-document a"));
      await Bun.sleep(50);
      const scroller = reader.dom.document.scrollingElement;
      if (!scroller) throw new Error("Missing page scroller");
      scroller.scrollTop = 640;
      const scroll = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
      await leaveSameAddressEntry();
      expect(scroller.scrollTop).toBe(640);
      // A section in the address is not opened again either.
      reader.clickLink("Section");
      expect(location.hash).toBe("#steps");
      scroll.mockClear();
      await leaveSameAddressEntry();
      expect(scroll).not.toHaveBeenCalled();
      expect(scroller.scrollTop).toBe(640);
      expect(reader.title()).toBe("Article first");
      scroll.mockRestore();
    } finally {
      await reader.cleanup();
    }
  });

  test("page: the hub keeps a typed search on a same-address entry and on browser Back from a result", async () => {
    const reader = await setup("page", undefined, "/app/spaces/help");
    try {
      await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
      type(search(reader), "second");
      await leaveSameAddressEntry();
      expect(search(reader).value).toBe("second");
      reader.button("Article second").click();
      await until(() => reader.title() === "Article second");
      expect(location.pathname).toBe("/app/spaces/help/second");
      history.back();
      await until(() => !!reader.dom.document.querySelector("[data-help-results]"));
      expect(location.pathname).toBe("/app/spaces/help");
      expect(search(reader).value).toBe("second");
    } finally {
      await reader.cleanup();
    }
  });

  test("page: browser Back to an unknown topic shows the hub, as a reload does", async () => {
    const reader = await setup("page", undefined, "/help/apps/spaces/does-not-exist");
    try {
      await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
      reader.button("Article first").click();
      await until(() => reader.title() === "Article first");
      history.back();
      await until(() => !!reader.dom.document.querySelector("[data-help-results]"));
      expect(location.pathname).toBe("/help/apps/spaces/does-not-exist");
      expect(reader.dom.document.querySelector("article h3")).toBeNull();
    } finally {
      await reader.cleanup();
    }
  });

  test("page: Next and a related article of the same app open in place; another app's article navigates", async () => {
    const reader = await setup("page", "first");
    try {
      await until(() => !!reader.dom.document.querySelector(".help-article-next"));
      const click = (selector: string) => {
        const anchor = reader.dom.document.querySelector<HTMLAnchorElement>(selector);
        if (!anchor) throw new Error(`Missing ${selector}`);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
        anchor.dispatchEvent(event);
        return event;
      };
      expect(reader.dom.document.querySelector(".help-article-fact")?.textContent).toBe("You need Edit");
      expect(click('.help-article-related-link[href="/help/apps/mail/mail-share"]').defaultPrevented).toBe(false);
      expect(click(".help-article-next").defaultPrevented).toBe(true);
      await until(() => reader.title() === "Article second");
      expect(location.pathname).toBe("/app/spaces/help/second");
      await until(() => !!reader.dom.document.querySelector(".help-article-related-link"));
      expect(click('.help-article-related-link[href="/help/apps/spaces/third"]').defaultPrevented).toBe(true);
      await until(() => reader.title() === "Article third");
    } finally {
      await reader.cleanup();
    }
  });

  const topicIds = (reader: Awaited<ReturnType<typeof setup>>, selector: string) =>
    [...reader.dom.document.querySelectorAll(`${selector} [data-help-topic]`)].map((element) => element.getAttribute("data-help-topic"));

  const startDocuments: HelpDocumentManifest[] = [
    // Reverse input order, and put the omitted kind among the tiles.
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${9 - index}`,
      order: index * 10,
      ...(index === 2 ? {} : { kind: "task" as const }),
      url: `/api/help/task-${index}`,
      searchUrl: "/api/help/search",
    })).reverse(),
    ...(["troubleshoot", "reference", "start"] as const).flatMap((kind) =>
      [2, 1].map((order) => ({
        id: `${kind}-${order}`,
        title: `${kind} ${order}`,
        kind,
        order,
        url: `/api/help/${kind}-${order}`,
        searchUrl: "/api/help/search",
      })),
    ),
  ];

  test("hub and related article icons use shared tiles with app ink and no inline styles", async () => {
    const reader = await setup("page", undefined, "/app/spaces/help", html, { documents: startDocuments });
    try {
      const expectTiles = (selector: string) => {
        const icons = reader.dom.document.querySelectorAll(selector);
        expect(icons.length, selector).toBeGreaterThan(0);
        for (const icon of icons) {
          expect(icon.classList.contains("k2b-icon-tile"), selector).toBe(true);
          expect(icon.classList.contains("app-accent-text"), selector).toBe(true);
          expect(icon.hasAttribute("style"), selector).toBe(false);
        }
      };
      expectTiles(".help-start-tile-icon");
      expectTiles(".help-start-row-icon");
      reader.button("Task 9").click();
      await until(() => !!reader.dom.document.querySelector(".help-article-related-icon"));
      expectTiles(".help-article-related-icon");
    } finally {
      await reader.cleanup();
    }
  });

  test("start: only task articles become eight ordered tiles; every remaining task follows in the overflow list", async () => {
    const reader = await setup("page", undefined, "/app/spaces/help", html, { documents: startDocuments });
    try {
      const tiles = topicIds(reader, "[data-help-tiles]");
      const overflow = topicIds(reader, "[data-help-more-tasks]");
      expect(tiles).toEqual(Array.from({ length: 8 }, (_, index) => `task-${index}`));
      expect(overflow).toEqual(["task-8", "task-9"]);
      expect([...tiles, ...overflow]).toEqual(Array.from({ length: 10 }, (_, index) => `task-${index}`));
    } finally {
      await reader.cleanup();
    }
  });

  for (const reference of [true, false]) {
    test(`start: kind groups keep their fixed order and ordered articles (reference=${reference})`, async () => {
      const reader = await setup("page", undefined, "/app/spaces/help", html, {
        documents: startDocuments.filter((document) => reference || document.kind !== "reference"),
      });
      try {
        const groups = [...reader.dom.document.querySelectorAll("[data-help-group]")];
        const kinds = reference ? ["start", "reference", "troubleshoot"] : ["start", "troubleshoot"];
        expect(groups.map((group) => group.getAttribute("data-help-group"))).toEqual(kinds);
        expect(groups.map((group) => group.querySelector("h3")?.textContent?.trim())).toEqual(
          reference ? ["Get started", "Look up", "Solve problems"] : ["Get started", "Solve problems"],
        );
        for (const kind of kinds) expect(topicIds(reader, `[data-help-group="${kind}"]`)).toEqual([`${kind}-1`, `${kind}-2`]);
        if (!reference) expect(reader.dom.document.querySelector('[data-help-group="reference"]')).toBeNull();
      } finally {
        await reader.cleanup();
      }
    });
  }

  for (const surface of ["modal", "page"] as const) {
    test(`${surface}: For this view uses declared shell ids only in the modal`, async () => {
      const reader = await setup(surface, undefined, "/app/spaces/help", html, { help: ["third", "missing", "first", "second"] });
      try {
        await until(() => !!reader.dom.document.querySelector("[data-help-results]"));
        expect(reader.dom.document.querySelector("#layout-help-title")?.textContent).toBe("Help for Spaces");
        expect(topicIds(reader, "[data-help-view]")).toEqual(surface === "modal" ? ["third", "first", "second"] : []);
        if (surface === "modal")
          expect(reader.dom.document.querySelector("[data-help-view] h3")?.textContent?.trim()).toBe("For this view");
        else expect(reader.dom.document.querySelector("[data-help-view]")).toBeNull();
      } finally {
        await reader.cleanup();
      }
    });
  }

  test("start: registered shortcuts group by scope with shell search and help first", async () => {
    const reader = await setup("page", undefined, "/app/spaces/help");
    const { registerContextAwareCommand } = await import("../browser/command-bridge");
    const unregister = [
      { id: "spaces.complete", title: "Complete selected", shortcut: "x", scope: "selection" as const },
      { id: "spaces.new", title: "New task", shortcut: "n" },
      { id: "cloud.shell.focus", title: "Hide sidebar", shortcut: "mod+\\" },
      { id: "cloud.help", title: "Open shortcut help", shortcut: "shift+/" },
      { id: "cloud.search", title: "Open global search", shortcut: "mod+k" },
      { id: "spaces.no-shortcut", title: "No shortcut" },
    ].map((command) => registerContextAwareCommand({ ...command, description: "", action() {} }));
    try {
      await until(() => reader.dom.document.querySelectorAll("[data-help-shortcut-group]").length === 3);
      const groups = [...reader.dom.document.querySelectorAll("[data-help-shortcut-group]")];
      expect(groups.map((group) => group.getAttribute("data-help-shortcut-group"))).toEqual(["everywhere", "app", "selection"]);
      expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Everywhere", "In Spaces", "With a selection"]);
      expect(groups.map((group) => [...group.querySelectorAll(".help-shortcut-title")].map((row) => row.textContent))).toEqual([
        ["Open global search", "Open shortcut help", "Hide sidebar"],
        ["New task"],
        ["Complete selected"],
      ]);
      expect(reader.dom.document.querySelector("[data-help-results]")?.lastElementChild?.hasAttribute("data-help-shortcuts")).toBe(true);
    } finally {
      unregister.forEach((dispose) => dispose());
      await reader.cleanup();
    }
  });

  for (const surface of ["modal", "page"] as const) {
    test(`${surface}: searching from an article and clearing returns to the same article and input`, async () => {
      const reader = await setup(surface, "first");
      try {
        if (surface === "modal") {
          await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
          reader.button("Article first").click();
        }
        await until(() => !!reader.dom.document.querySelector(".help-document a"));
        const input = search(reader);
        type(input, "second");
        await until(() => !!reader.dom.document.querySelector("[data-help-search-results]"));
        expect(reader.dom.document.querySelector(".help-article")).toBeNull();
        expect(topicIds(reader, "[data-help-search-results]")).toEqual(["second"]);
        expect(search(reader)).toBe(input);
        type(input, "");
        await until(() => reader.title() === "Article first" && !!reader.dom.document.querySelector(".help-document a"));
        expect(reader.dom.document.querySelector("[data-help-results]")).toBeNull();
        expect(search(reader)).toBe(input);
      } finally {
        await reader.cleanup();
      }
    });

    test(`${surface}: More Help actions offers Markdown copy and a modal-only page link for the current view`, async () => {
      const reader = await setup(surface, undefined, "/app/spaces/help");
      const openMenu = async (expectedHref = "/app/spaces/help") => {
        reader.dom.document.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
        await until(() => !!reader.dom.document.querySelector('[role="menuitem"]'));
        const items = [...reader.dom.document.querySelectorAll('[role="menuitem"]')];
        expect(items.map((item) => item.textContent?.trim())).toEqual(
          surface === "modal" ? ["Copy as Markdown", "Open as page"] : ["Copy as Markdown"],
        );
        const link = items.find((item) => item.textContent?.includes("Open as page"));
        if (surface === "modal") expect(link?.getAttribute("href")).toBe(expectedHref);
      };
      try {
        await until(() => !!reader.dom.document.querySelector("[data-help-menu]"));
        await openMenu();
        reader.dom.document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        reader.button("Article first").click();
        await until(() => !!reader.dom.document.querySelector(".help-document a"));
        await openMenu("/app/spaces/help/first");
      } finally {
        await reader.cleanup();
      }
    });
  }

  test("copy: a refused clipboard write ends in an error toast with Try again, never in a success", async () => {
    const reader = await setup("modal", undefined, "/app/spaces/help");
    const writes: string[] = [];
    const clipboard = {
      writeText: async (text: string) => {
        writes.push(text);
        throw new DOMException("Denied", "NotAllowedError");
      },
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    try {
      await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
      reader.button("Article first").click();
      await until(() => !!reader.dom.document.querySelector(".help-document a"));
      reader.dom.document.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!reader.dom.document.querySelector('[role="menuitem"]'));
      [...reader.dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Copy as Markdown"))!
        .click();
      await until(() => reader.dom.document.body.textContent?.includes("Could not copy the article") ?? false);
      expect(writes).toHaveLength(1);
      expect(reader.dom.document.body.textContent).not.toContain("Article copied as Markdown");
      [...reader.dom.document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Try again")!
        .click();
      await until(() => writes.length === 2);
    } finally {
      await reader.cleanup();
    }
  });

  test("search: a failed full-text request says so in the results line and Try again repeats the request", async () => {
    const reader = await setup("page", undefined, "/app/spaces/help", html, { searchFails: true });
    try {
      type(search(reader), "second");
      await until(() => !!reader.dom.document.querySelector("[data-help-search-failed]"));
      const warning = reader.dom.document.querySelector("[data-help-search-failed]")!;
      expect(warning.textContent).toContain("Full-text search is not available right now");
      expect(topicIds(reader, "[data-help-search-results]")).toEqual(["second"]);
      // The warning sits in the count's line, so the results below it do not move when it arrives.
      expect(warning.closest(".help-start-status")).not.toBeNull();
      const requests = () => reader.fetch.mock.calls.filter(([input]) => String(input).includes("/search?q=second"));
      expect(requests()).toHaveLength(1);
      reader.button("Try again").click();
      await until(() => requests().length === 2 && !!reader.dom.document.querySelector("[data-help-search-failed]"));
      expect(requests()).toHaveLength(2);
    } finally {
      await reader.cleanup();
    }
  });

  test("embedded: the host's chrome names the reader, so an article has no Help head and the start keeps only its search", async () => {
    const reader = await setup("embedded", "first");
    try {
      await until(() => !!reader.dom.document.querySelector(".help-document a"));
      expect(reader.dom.document.querySelector("[data-help-head]")).toBeNull();
      expect(reader.clickLink("Hub").defaultPrevented).toBe(true);
      await until(() => !!reader.dom.document.querySelector("[data-help-results]"));
      expect(reader.dom.document.querySelector("[data-help-search]")).not.toBeNull();
      expect(reader.dom.document.querySelector(".help-head-title, .help-head-tile, [data-help-menu]")).toBeNull();
    } finally {
      await reader.cleanup();
    }
  });

  test("modal: slash focuses search and Escape clears only a nonempty query", async () => {
    const reader = await setup("modal", undefined, "/app/spaces");
    try {
      await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
      const input = search(reader);
      const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      reader.dom.document.body.dispatchEvent(slash);
      expect(slash.defaultPrevented).toBe(true);
      expect(reader.dom.document.activeElement).toBe(input);
      type(input, "second");
      const composingEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
      input.dispatchEvent(composingEscape);
      expect(input.value).toBe("second");
      expect(composingEscape.defaultPrevented).toBe(false);
      const preventedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      preventedEscape.preventDefault();
      input.dispatchEvent(preventedEscape);
      expect(input.value).toBe("second");
      const escape = () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
      };
      expect(escape().defaultPrevented).toBe(true);
      expect(input.value).toBe("");
      expect(escape().defaultPrevented).toBe(false);
    } finally {
      await reader.cleanup();
    }
  });

  for (const helpFailed of [false, true]) {
    test(`modal: an app without articles ${helpFailed ? "offers a reload after a failed Help read" : "says so without a reload"}`, async () => {
      const reader = await setup("modal", undefined, "/app/spaces", html, { documents: [], helpFailed });
      try {
        await until(() => !!reader.dom.document.querySelector("[data-help-shortcuts]"));
        const text = reader.dom.document.body.textContent ?? "";
        const reload = [...reader.dom.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Reload");
        expect(reload).toBe(helpFailed);
        expect(!!reader.dom.document.querySelector("[data-help-unavailable]")).toBe(helpFailed);
        expect(text.includes("This app has not published Help yet.")).toBe(!helpFailed);
      } finally {
        await reader.cleanup();
      }
    });
  }
}
