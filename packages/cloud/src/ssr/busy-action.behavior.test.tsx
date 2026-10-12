import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

for (const variant of ["rail", "header", "menu"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`the ${variant} launchpad trigger keeps focus and clears its busy state after ${outcome}`, async () => {
      const dom = createDomTestHarness();
      const { AppLaunchpadButton } = await import("./app-launchpad");
      const reload = await import("../browser/reload");
      const surface = await import("./launchpad-surface");
      let opens = 0;
      const opener = spyOn(surface, "openLaunchpadSurface").mockImplementation(() => {
        opens += 1;
      });
      delegateEvents(["click"]);
      const originalLoad = reload.importOnDemand;
      let loads = 0;
      let finish: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const loader = spyOn(reload, "importOnDemand").mockImplementation(async (load) => {
        loads += 1;
        await pending;
        return outcome === "failure" ? undefined : originalLoad(load);
      });
      const dispose = render(() => createComponent(AppLaunchpadButton, { variant, apps: [], legalLinks: [] }), dom.root);
      try {
        const button = dom.root.querySelector<HTMLButtonElement>("button")!;
        const icon = button.querySelector("i")!;
        const originalClass = icon.className;
        button.focus();
        button.click();
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.disabled).toBe(false);
        expect(document.activeElement).toBe(button);
        expect(icon.classList.contains("ti-loader-2")).toBe(true);
        expect(icon.classList.contains("animate-spin")).toBe(true);
        for (const size of ["text-base", "text-lg"]) expect(icon.classList.contains(size)).toBe(originalClass.includes(size));
        button.click();
        expect(loads).toBe(1);
        expect(opens).toBe(0);
        finish();
        for (let attempt = 0; button.hasAttribute("aria-busy") && attempt < 100; attempt += 1) await Bun.sleep(10);
        expect(button.hasAttribute("aria-busy")).toBe(false);
        expect(button.querySelector("i")).toBe(icon);
        expect(icon.className).toBe(originalClass);
        expect(opens).toBe(outcome === "success" ? 1 : 0);
      } finally {
        loader.mockRestore();
        opener.mockRestore();
        dispose();
        dom.cleanup();
      }
    });
  }
}
