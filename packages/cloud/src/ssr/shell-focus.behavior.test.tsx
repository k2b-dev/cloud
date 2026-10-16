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

const mount = async (apple = false, wide = true, hidden = false) => {
  const dom = createDomTestHarness();
  Object.defineProperty(dom.window.navigator, "platform", { configurable: true, value: apple ? "MacIntel" : "Linux x86_64" });
  const media = dom.window.matchMedia("(min-width: 768px)");
  let matches = wide;
  Object.defineProperty(media, "matches", { get: () => matches });
  const matchMedia = spyOn(dom.window, "matchMedia").mockImplementation(() => media);
  dom.root.innerHTML = `<div class="cloud-app-canvas" data-layout-authenticated="true" ${hidden ? 'data-shell-focus="true"' : ""}>
    <button data-cloud-shell-focus-toggle="hide"><i></i>Hide sidebar</button>
    <div class="cloud-shell-show"><button data-cloud-shell-focus-toggle="show">Show sidebar</button></div>
    <textarea></textarea><div class="cm-content" contenteditable="true" tabindex="0"></div>
    <div data-cloud-shell-reveal></div></div><div id="runtime"></div>`;
  const canvas = dom.root.querySelector<HTMLElement>(".cloud-app-canvas")!;
  const hide = dom.root.querySelector<HTMLButtonElement>('[data-cloud-shell-focus-toggle="hide"]')!;
  const show = dom.root.querySelector<HTMLButtonElement>('[data-cloud-shell-focus-toggle="show"]')!;
  const textarea = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  const editor = dom.root.querySelector<HTMLElement>(".cm-content")!;
  // happy-dom has no layout. These editors remain rendered in the real shell.
  const rects = [textarea, editor].map((element) =>
    spyOn(element, "getClientRects").mockReturnValue(Object.assign([new dom.window.DOMRect(0, 0, 100, 20)], { item: () => null })),
  );
  const { contextCommandsWithShortcuts } = await import("../browser/command-shortcuts");
  const { setShellFocus, SHELL_FOCUS_CHANGE_EVENT } = await import("../browser/shell-focus");
  const dispose = render(
    () => createComponent(ShellRuntime!, { focus: true, commands: { searchResources: false } }),
    dom.root.querySelector("#runtime")!,
  );
  return {
    ...dom,
    canvas,
    hide,
    show,
    textarea,
    editor,
    setShellFocus,
    SHELL_FOCUS_CHANGE_EVENT,
    command: () => contextCommandsWithShortcuts().find((command) => command.id === "cloud.shell.focus"),
    width: (value: boolean) => {
      matches = value;
      media.dispatchEvent(new dom.window.Event("change"));
    },
    key: async (target: Element = canvas, shiftKey = false) => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "\\",
          code: "Backslash",
          bubbles: true,
          cancelable: true,
          metaKey: apple,
          ctrlKey: !apple,
          shiftKey,
        }),
      );
      // The real dispatcher loads and executes the context-aware command asynchronously.
      await Bun.sleep(30);
    },
    pointer: (type: string, x: number, y: number, pointerType = "touch", pointerId = 1, strip = false) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId, pointerType, clientX: x, clientY: y });
      (strip ? dom.root.querySelector("[data-cloud-shell-reveal]")! : window).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    },
    unmount: dispose,
    dispose: () => {
      dispose();
      matchMedia.mockRestore();
      for (const rect of rects) rect.mockRestore();
      dom.cleanup();
    },
  };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  for (const apple of [false, true]) {
    test(`${apple ? "Meta" : "Ctrl"}+\\ toggles through the registered command, including editors`, async () => {
      const page = await mount(apple);
      try {
        expect((await import("@k2b/ui")).formatShortcut("mod+\\", { platform: apple ? "apple" : "other", locale: "en" }).label).toBe(
          apple ? "⌘\\" : "Ctrl+\\",
        );
        expect(page.command()).toMatchObject({ title: "Hide sidebar", shortcut: "mod+\\", icon: "ti ti-layout-sidebar-left-collapse" });
        await page.key();
        expect(page.canvas.dataset.shellFocus).toBe("true");
        expect(document.cookie).toContain("cloud_shell_focus=1");
        expect(page.command()).toMatchObject({ title: "Show sidebar", shortcut: "mod+\\", icon: "ti ti-layout-sidebar-left-expand" });
        await page.key();
        expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);
        expect(document.cookie).not.toContain("cloud_shell_focus");
        for (const editor of [page.textarea, page.editor]) {
          editor.focus();
          await page.key(editor);
          expect(page.canvas.dataset.shellFocus).toBe("true");
          expect(document.activeElement).toBe(editor);
          await page.key(editor, true);
          expect(page.canvas.dataset.shellFocus).toBe("true");
          await page.key(editor);
          expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);
          expect(document.activeElement).toBe(editor);
        }
      } finally {
        page.dispose();
      }
    });
  }
  test("the command starts from the server-rendered state", async () => {
    const page = await mount(false, true, true);
    try {
      expect(page.command()).toMatchObject({ title: "Show sidebar", shortcut: "mod+\\" });
      await page.key();
      expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);
      expect(page.command()?.title).toBe("Hide sidebar");
    } finally {
      page.dispose();
    }
  });
  test("delegated buttons move focus to the other button and publish the state", async () => {
    const page = await mount();
    const states: boolean[] = [];
    const listener = (event: Event) => states.push((event as CustomEvent<{ hidden: boolean }>).detail.hidden);
    window.addEventListener(page.SHELL_FOCUS_CHANGE_EVENT, listener);
    try {
      page.hide.focus();
      page.hide.querySelector<HTMLElement>("i")!.click();
      expect(document.activeElement).toBe(page.show);
      expect(page.canvas.dataset.shellFocus).toBe("true");
      page.show.click();
      expect(document.activeElement).toBe(page.hide);
      expect(states).toEqual([true, false]);
      expect(page.command()?.title).toBe("Hide sidebar");
      // A sidebar link or an element removed by another state listener cannot retain focus.
      page.editor.focus();
      const rects = spyOn(page.editor, "getClientRects").mockReturnValue(Object.assign([], { item: () => null }));
      page.setShellFocus(true);
      expect(document.activeElement).toBe(page.show);
      rects.mockRestore();
    } finally {
      window.removeEventListener(page.SHELL_FOCUS_CHANGE_EVENT, listener);
      page.dispose();
    }
  });
  test("only a horizontal non-mouse edge drag reaching 40 px restores once; cancellation and pointer identity matter", async () => {
    const page = await mount();
    try {
      for (const [dx, dy, type, restores] of [
        [30, 0, "touch", false],
        [40, 50, "touch", false],
        [60, 0, "mouse", false],
        [40, 0, "touch", true],
        [50, 5, "pen", true],
      ] as const) {
        page.setShellFocus(true);
        page.pointer("pointerdown", 5, 100, type, 1, true);
        page.pointer("pointermove", 5 + dx, 100 + dy, type);
        expect(page.canvas.hasAttribute("data-shell-focus")).toBe(!restores);
        page.pointer("pointerup", 5 + dx, 100 + dy, type);
      }
      for (const stop of ["pointerup", "pointercancel"]) {
        page.setShellFocus(true);
        page.pointer("pointerdown", 5, 100, "touch", 1, true);
        page.pointer("pointermove", 100, 100, "touch", 2);
        expect(page.canvas.dataset.shellFocus).toBe("true");
        page.pointer(stop, 5, 100);
        page.pointer("pointermove", 100, 100);
        expect(page.canvas.dataset.shellFocus).toBe("true");
      }
      page.pointer("pointerdown", 5, 100, "touch", 1, true);
      page.pointer("pointermove", 45, 100);
      page.setShellFocus(true);
      page.pointer("pointermove", 90, 100);
      expect(page.canvas.dataset.shellFocus).toBe("true");
    } finally {
      page.dispose();
    }
  });
  test("phone widths have no command or focus transfer and follow viewport changes", async () => {
    const page = await mount(false, false, true);
    try {
      expect(page.command()).toBeUndefined();
      await page.key();
      expect(page.canvas.dataset.shellFocus).toBe("true");
      page.textarea.focus();
      page.setShellFocus(false);
      expect(document.activeElement).toBe(page.textarea);
      page.width(true);
      expect(page.command()?.title).toBe("Hide sidebar");
      page.setShellFocus(true);
      expect(page.command()?.title).toBe("Show sidebar");
      page.width(false);
      expect(page.command()).toBeUndefined();
    } finally {
      page.dispose();
    }
  });
  test("disposal removes commands, click and pointer listeners; no canvas means no state change", async () => {
    const page = await mount();
    try {
      page.pointer("pointerdown", 5, 100, "touch", 1, true);
      page.unmount();
      expect(page.command()).toBeUndefined();
      page.hide.click();
      expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);
      page.canvas.dataset.shellFocus = "true";
      page.pointer("pointermove", 100, 100);
      expect(page.canvas.dataset.shellFocus).toBe("true");
    } finally {
      page.dispose();
    }
    const dom = createDomTestHarness();
    const { setShellFocus, attachShellFocusControls } = await import("../browser/shell-focus");
    try {
      setShellFocus(true);
      expect(document.cookie).not.toContain("cloud_shell_focus");
      dom.root.innerHTML =
        '<div class="cloud-app-canvas" data-layout-authenticated="true"><button data-cloud-shell-focus-toggle="hide"></button><div data-cloud-shell-reveal></div></div>';
      const dispose = attachShellFocusControls();
      dispose();
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      expect(document.cookie).not.toContain("cloud_shell_focus");
    } finally {
      dom.cleanup();
    }
  });
}
