import { expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const OPEN_TOAST = "[data-k2b-toast]:not([data-closing])";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), reload: await import("./reload") };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

/** What a browser reports for a chunk that a release removed after the page loaded. */
const missingChunk = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /_ssr/1/chunk-old.js"));

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const notices = () => [...document.querySelectorAll<HTMLElement>(OPEN_TOAST)];

  for (const coalesce of [false, true]) {
    test(`keeps a real prompt dialog and offers the reload once it closes${coalesce ? ", one notice for every key" : ""}`, async () => {
      const { ui, reload } = modules!;
      const dom = createDomTestHarness();
      let reloads = 0;
      Object.assign(dom.window.location, {
        reload: () => {
          reloads += 1;
        },
      });
      let closeDialog = () => {};
      const dialog = ui.prompts.dialog<void>((close) => {
        closeDialog = close;
        return "Space settings";
      });
      try {
        expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
        expect(reload.reloadOnce("x")).toBe(true);
        if (coalesce) expect(reload.reloadOnce("another-key")).toBe(true);
        expect(notices()).toHaveLength(0);
        closeDialog();
        await dialog;
        await Bun.sleep(10);
        // The page never reloads by itself after a dialog: the person may have confirmed work in it.
        expect(reloads).toBe(0);
        expect(notices()).toHaveLength(1);
        expect(notices()[0]!.textContent).toContain("This page changed.");
        notices()[0]!.querySelector<HTMLButtonElement>(".k2b-toast__action")!.click();
        expect(reloads).toBe(1);
      } finally {
        closeDialog();
        await dialog;
        await Bun.sleep(10);
        ui.toast.dismissAll();
        dom.cleanup();
      }
    });
  }

  test("does not cancel the request of work confirmed in the dialog", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    const order: string[] = [];
    Object.assign(dom.window.location, {
      reload: () => {
        order.push("reload");
      },
    });
    const request = Promise.withResolvers<void>();
    let answer: (ok: boolean) => void = () => {};
    const confirmed = ui.prompts
      .dialog<boolean>((close) => {
        answer = close;
        return "Delete the item?";
      })
      .then(async (ok) => {
        if (!ok) return;
        order.push("delete request");
        await request.promise;
        order.push("delete answered");
      });
    try {
      expect(reload.reloadOnce("confirm")).toBe(true);
      answer(true);
      await Bun.sleep(10);
      request.resolve();
      await confirmed;
      await Bun.sleep(10);
      expect(order).toEqual(["delete request", "delete answered"]);
      expect(notices()).toHaveLength(1);
    } finally {
      answer(false);
      request.resolve();
      await confirmed;
      await Bun.sleep(10);
      ui.toast.dismissAll();
      dom.cleanup();
    }
  });

  test("does not wait for a modeless window, which leaves the page usable", async () => {
    const { reload } = modules!;
    const dom = createDomTestHarness();
    let reloads = 0;
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    const search = dom.document.createElement("dialog");
    search.setAttribute("open", "");
    search.setAttribute("aria-modal", "false");
    dom.document.body.append(search);
    try {
      expect(reload.reloadOnce("modeless")).toBe(true);
      expect(reloads).toBe(1);
    } finally {
      search.remove();
      dom.cleanup();
    }
  });

  test("waits for the last dialog, in the page's language, and starts the window at the deferred reload", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    let reloads = 0;
    const now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    const first = dom.document.createElement("dialog");
    const second = dom.document.createElement("dialog");
    first.setAttribute("open", "");
    second.setAttribute("open", "");
    dom.document.body.append(first, second);
    try {
      expect(reload.reloadOnce("last-dialog")).toBe(true);
      expect(dom.window.sessionStorage.getItem("cloud.reload.last-dialog")).toBe(String(now));
      first.removeAttribute("open");
      await Bun.sleep(10);
      expect(notices()).toHaveLength(0);
      second.remove();
      await Bun.sleep(10);
      expect(reloads).toBe(0);
      expect(notices()).toHaveLength(1);
      expect(notices()[0]!.textContent).toContain("Diese Seite hat sich geändert.");
      expect(notices()[0]!.querySelector(".k2b-toast__action")!.textContent).toBe("Neu laden");
      // The same reason within the window does not reload again; the caller offers its own reload.
      expect(reload.reloadOnce("last-dialog")).toBe(false);
    } finally {
      first.remove();
      second.remove();
      await Bun.sleep(10);
      ui.toast.dismissAll();
      clock.mockRestore();
      dom.cleanup();
    }
  });

  test("reloads immediately when no dialog is open", () => {
    const { reload } = modules!;
    const dom = createDomTestHarness();
    let reloads = 0;
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    try {
      expect(reload.reloadOnce("no-dialog")).toBe(true);
      expect(reloads).toBe(1);
    } finally {
      dom.cleanup();
    }
  });

  test("passes the loaded code through without a notice", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    try {
      const code = { openDialog: () => "opened" };
      expect(await reload.importOnDemand(async () => code)).toBe(code);
      expect(dom.document.querySelector(OPEN_TOAST)).toBeNull();
    } finally {
      ui.toast.dismissAll();
      dom.cleanup();
    }
  });

  test("code that cannot load ends the action and offers one reload in the page's language", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    let reloads = 0;
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await reload.importOnDemand(missingChunk)).toBeUndefined();
      expect(await reload.importOnDemand(missingChunk)).toBeUndefined();
      // Every failure has the same remedy, so a second one replaces the first notice.
      const notices = dom.document.querySelectorAll<HTMLElement>(OPEN_TOAST);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.textContent).toContain("Ein Teil dieser Seite konnte nicht geladen werden.");
      const action = notices[0]!.querySelector<HTMLButtonElement>(".k2b-toast__action")!;
      expect(action.textContent).toBe("Neu laden");
      action.click();
      expect(reloads).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      ui.toast.dismissAll();
      dom.cleanup();
    }
  });
}
