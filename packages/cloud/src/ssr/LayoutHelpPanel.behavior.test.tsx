import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PanelRequest } from "../browser/panel";
import {
  PANEL_CONTEXT_CHANGED,
  PANEL_CONTEXT_ELEMENT,
  PANEL_SHORTCUTS_CHANGED,
  PANEL_SHORTCUTS_ELEMENT,
  type PanelState,
} from "../browser/panel-context-bridge";
import type { HelpDocumentManifest } from "../shared/help";

const documents: HelpDocumentManifest[] = ["first", "second"].map((id) => ({
  id,
  title: `Article ${id}`,
  order: 1,
  url: `/api/help/${id}`,
  searchUrl: "/api/help/search",
}));
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Help did not reach the expected state");
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const setup = async () => {
    const dom = createDomTestHarness();
    const help = await import("./LayoutHelp");
    const { default: Trigger } = await import("./LayoutHelpTrigger");
    const { default: ShellRuntime } = await import("./ShellRuntime.island");
    const { prompts } = await import("@k2b/ui");
    const dialog = spyOn(prompts, "dialog").mockImplementation(async () => undefined);
    return {
      dom,
      help,
      Trigger,
      ShellRuntime,
      dialog,
      cleanup: () => {
        dialog.mockRestore();
        dom.cleanup();
      },
    };
  };

  for (const variant of ["rail", "header"] as const)
    test(`${variant} Help toggles only its provider and follows slot aria state`, async () => {
      const fixture = await setup();
      const { dom, Trigger, dialog } = fixture;
      const requests: PanelRequest[] = [];
      let accepted = true;
      const request = (event: CustomEvent<PanelRequest>) => {
        requests.push({ ...event.detail });
        if (event.detail.action === "open") event.detail.accepted = accepted;
      };
      window.addEventListener("cloud.panel.request", request);
      const dispose = render(() => createComponent(Trigger, { variant, panel: true, helpOpen: false }), dom.root);
      const button = dom.root.querySelector<HTMLButtonElement>("button")!;
      const state = (provider: string, open: boolean) =>
        window.dispatchEvent(
          new CustomEvent<PanelState>("cloud.panel.state", {
            detail: { provider, open, appName: "Fixture", consent: false, allowed: true, saving: false },
          }),
        );
      try {
        expect(button.getAttribute("aria-controls")).toBe("cloud-panel");
        expect(button.getAttribute("aria-expanded")).toBe("false");
        button.click();
        expect(requests.at(-1)).toMatchObject({ action: "open", provider: "core" });
        state("core", true);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        button.click();
        expect(requests.at(-1)).toEqual({ action: "close" });
        state("other", true);
        expect(button.getAttribute("aria-expanded")).toBe("false");
        button.click();
        expect(requests.at(-1)).toMatchObject({ action: "open", provider: "core" });
        expect(dialog).not.toHaveBeenCalled();
        accepted = false;
        state("core", false);
        button.click();
        await until(() => dialog.mock.calls.length === 1);
      } finally {
        dispose();
        window.removeEventListener("cloud.panel.request", request);
        fixture.cleanup();
      }
    });

  test("Help's public opener and cloud.help open core and fall back only when unaccepted", async () => {
    const fixture = await setup();
    const { dom, help, ShellRuntime, Trigger, dialog } = fixture;
    dom.document.cookie = `cloud.timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}; Path=/`;
    const { collectContextAwareCommands } = await import("../browser/command-bridge");
    const { runContextAwareCommand } = await import("../browser/commands");
    let accepted = true;
    const requests: PanelRequest[] = [];
    const request = (event: CustomEvent<PanelRequest>) => {
      requests.push({ ...event.detail });
      if (event.detail.action === "open") event.detail.accepted = accepted;
    };
    window.addEventListener("cloud.panel.request", request);
    const dispose = render(
      () => (
        <>
          <ShellRuntime commands={{ searchResources: false }} />
          <Trigger variant="rail" />
        </>
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector("button")?.hasAttribute("aria-expanded")).toBe(false);
      const command = collectContextAwareCommands().find((command) => command.id === "cloud.help");
      if (!command) throw new Error("Missing cloud.help");
      help.openLayoutHelpDialog();
      await runContextAwareCommand(command);
      expect(requests).toHaveLength(2);
      for (const entry of requests) expect(entry).toMatchObject({ action: "open", provider: "core" });
      expect(dialog).not.toHaveBeenCalled();
      accepted = false;
      help.openLayoutHelpDialog();
      expect(dialog).toHaveBeenCalledTimes(1);
      await runContextAwareCommand(command);
      expect(dialog).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      window.removeEventListener("cloud.panel.request", request);
      fixture.cleanup();
    }
  });

  test("panel articles stay in Help without history writes; cross-app links keep native navigation", async () => {
    const fixture = await setup();
    const { dom, help } = fixture;
    Object.assign(dom.window.happyDOM.settings.navigation, {
      disableMainFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo) => {
          const id = String(input).split("/").at(-1);
          return Response.json({
            id,
            locale: "en",
            title: `Article ${id}`,
            markdown: "Help",
            kind: "task",
            related: [],
            html: '<h2 id="steps">Steps</h2><a href="/help/apps/spaces/second">Same app</a><a href="/help/apps/mail/mail-share">Other app</a>',
          });
        },
        { preconnect: () => {} },
      ),
    );
    const push = spyOn(history, "pushState");
    const replace = spyOn(history, "replaceState");
    const dispose = render(
      () => (
        <help.LayoutHelpPanel
          documents={documents}
          app={{ id: "spaces", name: "Spaces" }}
          initialTopic="first"
          pageBase="/help/apps/spaces"
          platform="other"
        />
      ),
      dom.root,
    );
    try {
      await until(() => !!dom.root.querySelector(".help-document a"));
      const follow = (href: string) => {
        const anchor = dom.root.querySelector<HTMLAnchorElement>(`.help-document a[href="${href}"]`);
        if (!anchor) throw new Error(`Missing Help link ${href}`);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
        anchor.dispatchEvent(event);
        return event;
      };
      expect(follow("/help/apps/mail/mail-share").defaultPrevented).toBe(false);
      expect(follow("/help/apps/spaces/second").defaultPrevented).toBe(true);
      await until(
        () => dom.root.querySelector("article h3")?.textContent === "Article second" && !!dom.root.querySelector(".help-document a"),
      );
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      dom.root.querySelector<HTMLButtonElement>("[data-help-menu]")!.click();
      await until(() => !!dom.document.querySelector('[role="menuitem"][href]'));
      expect(dom.document.querySelector('[role="menuitem"][href]')?.getAttribute("href")).toBe("/help/apps/spaces/second");
    } finally {
      dispose();
      fetch.mockRestore();
      push.mockRestore();
      replace.mockRestore();
      fixture.cleanup();
    }
  });

  test("the panel uses its SSR view then live context and Core shortcuts, with search keyboard handling", async () => {
    const fixture = await setup();
    const { dom, help } = fixture;
    const script = (id: string, value: unknown) => {
      let element = dom.document.getElementById(id);
      if (!element) {
        element = dom.document.createElement("script");
        element.id = id;
        element.setAttribute("type", "application/json");
        dom.root.append(element);
      }
      element.textContent = JSON.stringify(value);
    };
    const context = (app: string, ids: string[]) => ({ v: 1, seq: 1, pageId: "22222222-2222-4222-8222-222222222222", app, help: ids });
    script(PANEL_CONTEXT_ELEMENT, context("spaces", ["second"]));
    const dispose = render(
      () => (
        <help.LayoutHelpPanel
          documents={documents}
          app={{ id: "spaces", name: "Spaces", icon: "ti ti-box" }}
          view={["first"]}
          platform="apple"
          pageBase="/help/apps/spaces"
        />
      ),
      dom.root,
    );
    const view = () => dom.root.querySelector("[data-help-view]")?.textContent;
    const update = (value: unknown) => {
      script(PANEL_CONTEXT_ELEMENT, value);
      window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
    };
    try {
      expect(view()).toContain("Article first");
      expect(view()).not.toContain("Article second");
      expect(dom.root.querySelector("#layout-help-title")?.textContent).toBe("Spaces");
      update(context("spaces", ["second", "unknown-id"]));
      expect(view()).toContain("Article second");
      expect(view()).not.toContain("unknown-id");
      update(context("other", ["first"]));
      expect(view()).toBeUndefined();
      update(context("spaces", ["first"]));
      update(null);
      expect(view()).toBeUndefined();
      update(context("spaces", ["first"]));
      // These are the exact snapshot element and event written by the validated context receiver.
      script(PANEL_SHORTCUTS_ELEMENT, [
        { id: "cloud.search", title: "Open global search", shortcut: "mod+k" },
        { id: "cloud.help", title: "Open shortcut help", shortcut: "shift+/" },
        { id: "cloud.panel", title: "Open or close the panel", shortcut: "mod+j" },
        { id: "spaces.new", title: "New Space", shortcut: "mod+n" },
        { id: "spaces.delete", title: "Delete selected", shortcut: "delete", scope: "selection" },
      ]);
      window.dispatchEvent(new Event(PANEL_SHORTCUTS_CHANGED));
      expect(dom.root.querySelector('[data-help-shortcut-group="app"]')?.textContent).toContain("In Spaces");
      expect(dom.root.querySelector('[data-help-shortcut-group="selection"]')?.textContent).toContain("With a selection");
      const titles = [...dom.root.querySelectorAll('[data-help-shortcut-group="everywhere"] .help-shortcut-title')].map(
        (el) => el.textContent,
      );
      expect(titles).toEqual(["Open global search", "Open shortcut help", "Open or close the panel"]);
      expect(dom.root.querySelector(".k2b-kbd__keys")?.textContent).toBe("⌘K");
      const input = dom.root.querySelector<HTMLInputElement>("[data-help-search]")!;
      const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      dom.document.body.dispatchEvent(slash);
      expect(slash.defaultPrevented).toBe(true);
      expect(dom.document.activeElement).toBe(input);
      const editableSlash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      input.dispatchEvent(editableSlash);
      expect(editableSlash.defaultPrevented).toBe(false);
      input.value = "Article";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const escape = () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
      };
      expect(escape().defaultPrevented).toBe(true);
      expect(input.value).toBe("");
      expect(escape().defaultPrevented).toBe(false);
    } finally {
      dispose();
      fixture.cleanup();
    }
  });

  for (const beforeMount of [false, true])
    test(`panel shortcuts use the host snapshot ${beforeMount ? "received before mount" : "after mount"} and restore the seed for null context`, async () => {
      const fixture = await setup();
      const { dom, help } = fixture;
      const script = (id: string, value: unknown) => {
        let element = dom.document.getElementById(id);
        if (!element) {
          element = dom.document.createElement("script");
          element.id = id;
          element.setAttribute("type", "application/json");
          dom.document.body.append(element);
        }
        element.textContent = JSON.stringify(value);
      };
      const context = { v: 1, seq: 1, pageId: "22222222-2222-4222-8222-222222222222", app: "spaces" };
      const snapshot = [
        { id: "cloud.panel", title: "Open or close the panel", shortcut: "mod+j" },
        { id: "spaces.new", title: "New Space", shortcut: "mod+n" },
      ];
      const titles = (scope: string) =>
        [...dom.root.querySelectorAll(`[data-help-shortcut-group="${scope}"] .help-shortcut-title`)].map((el) => el.textContent);
      const seed = ["Open global search", "Open shortcut help", "Open or close the panel"];
      script(PANEL_CONTEXT_ELEMENT, context);
      script(PANEL_SHORTCUTS_ELEMENT, beforeMount ? snapshot : []);
      const dispose = render(
        () => <help.LayoutHelpPanel documents={documents} app={{ id: "spaces", name: "Spaces" }} platform="other" />,
        dom.root,
      );
      try {
        if (!beforeMount) {
          expect(titles("everywhere")).toEqual(seed);
          // An accepted empty snapshot can emit only the context event.
          window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
          expect(titles("everywhere")).toEqual([]);
          script(PANEL_SHORTCUTS_ELEMENT, snapshot);
          window.dispatchEvent(new Event(PANEL_SHORTCUTS_CHANGED));
        }
        expect(titles("everywhere")).toEqual(["Open or close the panel"]);
        expect(titles("app")).toEqual(["New Space"]);

        script(PANEL_SHORTCUTS_ELEMENT, []);
        window.dispatchEvent(new Event(PANEL_SHORTCUTS_CHANGED));
        expect(titles("everywhere")).toEqual([]);
        expect(titles("app")).toEqual([]);

        script(PANEL_CONTEXT_ELEMENT, null);
        window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
        expect(titles("everywhere")).toEqual(seed);
        expect(titles("app")).toEqual([]);
      } finally {
        dispose();
        fixture.cleanup();
      }
    });
}
