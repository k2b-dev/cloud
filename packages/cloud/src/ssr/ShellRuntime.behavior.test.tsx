import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./ShellRuntime.island")).default;
  } finally {
    dom.cleanup();
  }
};
const ShellRuntime = isServer ? undefined : await load();

const mount = () => {
  const dom = createDomTestHarness();
  let reloads = 0;
  // The island reads the global `sessionStorage`, which the harness does not install.
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  Object.assign(dom.window.location, {
    reload: () => {
      reloads += 1;
    },
  });
  const dispose = render(() => createComponent(ShellRuntime!, {}), dom.root);
  return {
    cookie: () => dom.document.cookie,
    reloads: () => reloads,
    dispose: () => {
      dispose();
      Reflect.deleteProperty(globalThis, "sessionStorage");
      dom.cleanup();
    },
  };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("records input mode on every shell variant and stops after disposal", () => {
    const dom = createDomTestHarness();
    const html = dom.document.documentElement;
    // Avoid timezone reload work so this test isolates the unconditional controller.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    dom.document.cookie = `cloud.timezone=${encodeURIComponent(zone)}; Path=/`;
    const dispose = render(() => createComponent(ShellRuntime!, {}), dom.root);
    const pointer = (type: string, pointerType: string) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      dom.window.document.dispatchEvent(event);
    };
    try {
      expect(html.hasAttribute("data-k2b-input")).toBe(false);
      expect(html.hasAttribute("data-k2b-kbd")).toBe(false);
      pointer("pointerdown", "touch");
      expect(html.getAttribute("data-k2b-input")).toBe("touch");
      pointer("pointermove", "mouse");
      expect(html.getAttribute("data-k2b-input")).toBe("trackpad");
      dispose();
      pointer("pointerdown", "touch");
      dom.document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(html.getAttribute("data-k2b-input")).toBe("trackpad");
      expect(html.hasAttribute("data-k2b-kbd")).toBe(false);
    } finally {
      dispose();
      html.removeAttribute("data-k2b-input");
      html.removeAttribute("data-k2b-kbd");
      dom.cleanup();
    }
  });
  test("Help opens once when invoked twice while its module is loading", async () => {
    const dom = createDomTestHarness();
    const reload = await import("../browser/reload");
    const help = await import("./LayoutHelp");
    const { collectContextAwareCommands } = await import("../browser/command-bridge");
    const { runContextAwareCommand } = await import("../browser/commands");
    const pending = Promise.withResolvers<void>();
    const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
      await pending.promise;
      return loader();
    });
    const open = spyOn(help, "openLayoutHelpDialog").mockImplementation(() => {});
    const dispose = render(() => createComponent(ShellRuntime!, { commands: { searchResources: false } }), dom.root);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      const command = collectContextAwareCommands().find((command) => command.id === "cloud.help")!;
      first = runContextAwareCommand(command);
      await Bun.sleep(10);
      second = runContextAwareCommand(command);
      await Bun.sleep(10);
      expect(load).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      pending.resolve();
      await Promise.all([first, second]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith();
    } finally {
      pending.resolve();
      await Promise.all([first, second]);
      dispose();
      load.mockRestore();
      open.mockRestore();
      dom.cleanup();
    }
  });

  test("stores a changed timezone and reloads once", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const page = mount();
    try {
      expect(page.cookie()).toContain(encodeURIComponent(zone));
      expect(page.reloads()).toBe(1);
    } finally {
      page.dispose();
    }
  });
  test("banner dismissal merges the current cookie and removes the last empty list", async () => {
    const dom = createDomTestHarness();
    const { parseAnnouncementCookieHeader, serializeAnnouncementCookieState } = await import("../contracts/announcement-cookie");
    dom.document.cookie = `cloud_announcements=${serializeAnnouncementCookieState({ seenAnnouncementVersion: 9, dismissedBannerVersions: [2] })}; Path=/`;
    dom.root.innerHTML =
      '<div id="banners"><div class="cloud-announcement"><button data-cloud-announcement-dismiss="4"><i></i></button></div><div class="cloud-announcement"><button data-cloud-announcement-dismiss="5"></button></div></div>';
    const runtimeRoot = dom.document.createElement("div");
    dom.root.append(runtimeRoot);
    const dispose = render(() => createComponent(ShellRuntime!, { banners: true }), runtimeRoot);
    try {
      dom.root.querySelector<HTMLElement>("[data-cloud-announcement-dismiss='4'] i")!.click();
      expect(parseAnnouncementCookieHeader(document.cookie)).toEqual({ seenAnnouncementVersion: 9, dismissedBannerVersions: [4, 2] });
      expect(document.querySelectorAll(".cloud-announcement")).toHaveLength(1);
      expect(document.getElementById("banners")).not.toBeNull();
      // A dialog or another banner can write between clicks; dismissal reads that current cookie.
      dom.document.cookie = `cloud_announcements=${serializeAnnouncementCookieState({ seenAnnouncementVersion: 12, dismissedBannerVersions: [7, 4, 2] })}; Path=/`;
      dom.root.querySelector<HTMLButtonElement>("[data-cloud-announcement-dismiss='5']")!.click();
      expect(parseAnnouncementCookieHeader(document.cookie)).toEqual({
        seenAnnouncementVersion: 12,
        dismissedBannerVersions: [7, 5, 4, 2],
      });
      expect(document.querySelector(".cloud-announcement")).toBeNull();
      expect(document.getElementById("banners")).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("refreshes the browser push endpoint only when push is requested", async () => {
    const dom = createDomTestHarness();
    const { browserNotificationClient } = await import("../browser/notifications");
    const refresh = spyOn(browserNotificationClient, "refreshExisting").mockResolvedValue({
      supported: true,
      permission: "granted",
      enabled: true,
    });
    try {
      for (const push of [undefined, false, true]) {
        const dispose = render(() => createComponent(ShellRuntime!, { push }), dom.root);
        try {
          await Bun.sleep(10);
          expect(refresh).toHaveBeenCalledTimes(push ? 1 : 0);
        } finally {
          dispose();
        }
      }
    } finally {
      refresh.mockRestore();
      dom.cleanup();
    }
  });
  test("closing lazy announcements preserves banners dismissed while the dialog was open", async () => {
    const dom = createDomTestHarness();
    const { dialogCore } = await import("@k2b/ui");
    const { parseAnnouncementCookieHeader, serializeAnnouncementCookieState } = await import("../contracts/announcement-cookie");
    const entry = {
      id: "22222222-2222-4222-8222-222222222222",
      version: 10,
      kind: "announcement" as const,
      tone: "info" as const,
      title: "New tools",
      bodyHtml: "<p>Tools for your daily work.</p>",
      publishedAt: "2026-10-01T10:00:00Z",
      expiresAt: null,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      createdBy: null,
      updatedBy: null,
    };
    dom.root.innerHTML =
      '<div id="banners"><div class="cloud-announcement"><button data-cloud-announcement-dismiss="4"></button></div></div>';
    const runtimeRoot = dom.document.createElement("div");
    dom.root.append(runtimeRoot);
    const dispose = render(
      () => createComponent(ShellRuntime!, { banners: true, announcements: { entries: [entry], latestVersion: 10 } }),
      runtimeRoot,
    );
    try {
      for (let attempt = 0; !document.querySelector("dialog") && attempt < 100; attempt += 1) await Bun.sleep(10);
      expect(document.querySelector("dialog")?.textContent).toContain("New tools");
      dom.root.querySelector<HTMLButtonElement>("[data-cloud-announcement-dismiss]")!.click();
      // Another writer can also acknowledge a newer announcement before this dialog closes.
      document.cookie = `cloud_announcements=${serializeAnnouncementCookieState({ seenAnnouncementVersion: 12, dismissedBannerVersions: [4] })}; Path=/`;
      dialogCore.close();
      await Promise.resolve();
      expect(parseAnnouncementCookieHeader(document.cookie)).toEqual({ seenAnnouncementVersion: 12, dismissedBannerVersions: [4] });
    } finally {
      dialogCore.close();
      await Bun.sleep(20);
      dispose();
      dom.cleanup();
    }
  });
  test("the runtime keeps the static fallback row current and owns Help and commands once", async () => {
    const dom = createDomTestHarness();
    const { layout } = await import("./layout-runtime");
    const { contextCommandsWithShortcuts } = await import("../browser/command-shortcuts");
    dom.window.history.replaceState(null, "", "/app/inventory/projects/one");
    dom.root.innerHTML =
      '<div class="cloud-app-canvas" data-app-base="/app/inventory"><script type="application/json" data-k2b-page-trail>{"title":"Overview","ancestors":[]}</script><div class="layout-page-head" data-trail="title"><div class="k2b-page-title" data-k2b-server data-fallback><div class="k2b-page-title__copy"><p class="k2b-page-title__title"><span class="k2b-page-title__text">Overview</span></p></div></div></div></div>';
    const runtimeRoot = dom.document.createElement("div");
    dom.root.append(runtimeRoot);
    const help = {
      pageBase: "/help/apps/inventory",
      documents: [{ id: "inventory-start", title: "Getting started", order: 1, searchUrl: "/api/help/search", url: "/api/help/start" }],
    };
    const dispose = render(
      () => createComponent(ShellRuntime!, { pageTrail: true, help, commands: { searchResources: false } }),
      runtimeRoot,
    );
    try {
      expect(window.__cloudLayoutHelpTopics?.has("inventory-start")).toBe(true);
      expect(window.__cloudLayoutHelpPageBase).toBe(help.pageBase);
      for (const id of ["cloud.search", "cloud.help"])
        expect(contextCommandsWithShortcuts().filter((command) => command.id === id)).toHaveLength(1);
      layout.update({
        breadcrumbs: [
          { title: "Inventory", href: "/app/inventory" },
          { title: "Projects", href: "/app/inventory/projects" },
          { title: "One" },
        ],
      });
      const row = document.querySelector<HTMLElement>(".layout-page-head")!;
      expect(row.dataset.trail).toBe("up");
      expect(row.querySelector(".k2b-page-title__text")?.textContent).toBe("One");
      expect(row.querySelector("[data-k2b-page-trail-up]")?.getAttribute("href")).toBe("/app/inventory/projects");
      layout.update({ breadcrumbs: [{ title: "Inventory", href: "/app/inventory" }] });
      expect(row.dataset.trail).toBe("title");
      expect(row.querySelector(".k2b-page-title__text")?.textContent).toBe("Inventory");
    } finally {
      dispose();
      expect(window.__cloudLayoutHelpTopics?.has("inventory-start")).toBe(false);
      for (const id of ["cloud.search", "cloud.help"])
        expect(contextCommandsWithShortcuts().filter((command) => command.id === id)).toHaveLength(0);
      dom.cleanup();
    }
  });
}
