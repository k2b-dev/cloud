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
  const setup = async (surface: "modal" | "page" | "embedded", initialTopic?: string) => {
    const dom = createDomTestHarness();
    Object.assign(dom.window.happyDOM.settings.navigation, {
      disableMainFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    });
    dom.window.happyDOM.setURL("http://localhost/help/apps/spaces/first");
    history.replaceState(null, "", "/help/apps/spaces/first");
    const { LayoutHelpPage, openLayoutHelpDialog } = await import("./LayoutHelp");
    const { dialogCore } = await import("@k2b/ui");
    const { LayoutHelpDocuments } = await import("./layout-help-registry");
    const { ShellDataProvider } = await import("./shell-data");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo) => {
          const id = String(input).split("/").at(-1) ?? "first";
          return Response.json({ id, locale: "en", title: `Article ${id}`, markdown: "Steps", html });
        },
        { preconnect: () => {} },
      ),
    );
    // The shell data's script carries the current app to the dialog, which renders outside this tree.
    const dispose = render(
      () => (
        <ShellDataProvider data={{ apps: [], legalLinks: [], searchLinks: {}, theme: "light", appId: "spaces", accent: "#16a34a" }}>
          {surface === "modal" ? (
            <LayoutHelpDocuments documents={documents} pageBase="/app/spaces/help" />
          ) : (
            <LayoutHelpPage
              documents={documents}
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
    const title = () => dom.document.querySelector("article h3, dialog #layout-help-title")?.textContent ?? "";
    return {
      dom,
      button,
      clickLink,
      title,
      cleanup: async () => {
        dialogCore.close();
        await Bun.sleep(20);
        dispose();
        fetch.mockRestore();
        dom.cleanup();
      },
    };
  };

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
        expect(reader.clickLink("Third").defaultPrevented).toBe(true);
        await until(() => reader.title() === "Article third" && !!reader.dom.document.querySelector("#steps"));
        if (surface !== "page") expect(location.href).toBe(initialHref);
        else expect(location.hash).toBe("#steps");
        expect(reader.clickLink("Section").defaultPrevented).toBe(true);
        if (surface !== "page") expect(location.href).toBe(initialHref);
        expect(reader.clickLink("Hub").defaultPrevented).toBe(true);
        await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
        if (surface === "page") expect(location.pathname).toBe("/app/spaces/help");
      } finally {
        await reader.cleanup();
      }
    });
  }

  for (const surface of ["modal", "page"] as const) {
    test(`${surface}: Search help in Shortcuts focuses the hub input`, async () => {
      const reader = await setup(surface, "shortcuts");
      try {
        if (surface === "modal") {
          await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
          reader.button("Shortcuts").click();
        }
        await until(() => reader.title() === "Shortcuts");
        reader.button("Search help").click();
        await until(() => !!reader.dom.document.querySelector("[data-help-search]"));
        await until(() => document.activeElement === reader.dom.document.querySelector("[data-help-search]"));
        expect(document.activeElement).toBe(reader.dom.document.querySelector("[data-help-search]"));
        expect(reader.dom.document.querySelectorAll("dialog")).toHaveLength(surface === "modal" ? 1 : 0);
        if (surface === "page") expect(location.pathname).toBe("/app/spaces/help");
      } finally {
        await reader.cleanup();
      }
    });
  }
}
