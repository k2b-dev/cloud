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
  for (const coalesce of [false, true]) {
    test(`waits for a real prompt dialog to close${coalesce ? " and coalesces other reload keys" : ""}`, async () => {
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
        expect(reloads).toBe(0);
        closeDialog();
        await dialog;
        await Bun.sleep(10);
        expect(reloads).toBe(1);
      } finally {
        closeDialog();
        await dialog;
        await Bun.sleep(10);
        dom.cleanup();
      }
    });
  }

  test("lets the code that waited for a confirmation start its request before the reload", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    const order: string[] = [];
    Object.assign(dom.window.location, {
      reload: () => {
        order.push("reload");
      },
    });
    let answer: (ok: boolean) => void = () => {};
    const confirmed = ui.prompts
      .dialog<boolean>((close) => {
        answer = close;
        return "Delete the item?";
      })
      .then((ok) => {
        if (ok) order.push("delete request");
      });
    try {
      expect(reload.reloadOnce("confirm")).toBe(true);
      answer(true);
      await confirmed;
      await Bun.sleep(10);
      expect(order).toEqual(["delete request", "reload"]);
    } finally {
      answer(false);
      await confirmed;
      await Bun.sleep(10);
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

  test("keeps waiting after the dialog closes while a draft the caller names is open", async () => {
    const { reload } = modules!;
    const dom = createDomTestHarness();
    let reloads = 0;
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    const dialog = dom.document.createElement("dialog");
    dialog.setAttribute("open", "");
    const editor = dom.document.createElement("div");
    dom.document.body.append(dialog, editor);
    try {
      expect(reload.reloadOnce("draft", { waitWhile: '[data-draft="true"]' })).toBe(true);
      // A modeless window leaves the page usable, so an editor can open while the reload waits.
      editor.setAttribute("data-draft", "true");
      dialog.remove();
      await Bun.sleep(10);
      expect(reloads).toBe(0);
      editor.setAttribute("data-draft", "false");
      await Bun.sleep(10);
      expect(reloads).toBe(1);
    } finally {
      dialog.remove();
      editor.remove();
      await Bun.sleep(10);
      dom.cleanup();
    }
  });

  for (const storageFails of [false, true]) {
    test(`waits for the last dialog and ${storageFails ? "reloads even if storage later fails" : "starts the window at the deferred reload"}`, async () => {
      const { reload } = modules!;
      const dom = createDomTestHarness();
      let reloads = 0;
      let now = 1_000_000;
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
      let write: ReturnType<typeof spyOn> | undefined;
      try {
        expect(reload.reloadOnce("last-dialog")).toBe(true);
        expect(dom.window.sessionStorage.getItem("cloud.reload.last-dialog")).toBe(String(now));
        first.removeAttribute("open");
        await Bun.sleep(10);
        expect(reloads).toBe(0);
        now += reload.AUTOMATIC_RELOAD_WINDOW_MS;
        if (storageFails)
          write = spyOn(dom.window.sessionStorage, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
          });
        second.remove();
        await Bun.sleep(10);
        expect(reloads).toBe(1);
        if (!storageFails) expect(dom.window.sessionStorage.getItem("cloud.reload.last-dialog")).toBe(String(now));
      } finally {
        first.remove();
        second.remove();
        await Bun.sleep(10);
        write?.mockRestore();
        clock.mockRestore();
        dom.cleanup();
      }
    });
  }

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
