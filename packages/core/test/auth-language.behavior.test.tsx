import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("auth footer language", () => {
  if (isServer) {
    test.skip("requires browser conditions and DOM preload", () => {});
    return;
  }
  test.each(["en", "de-CH"])("uses the request locale %s and persists the other language without changing the URL", async (locale) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = locale;
    dom.window.history.replaceState(null, "", "/auth/login?method=ipa&redirectTo=%2Fme#test");
    const href = dom.window.location.href;
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    const { default: Footer } = await import("../src/pages/auth/AuthFooter");
    const dispose = render(() => createComponent(Footer, { links: [] }), dom.root);
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
      expect(trigger.textContent).toContain(locale === "en" ? "English" : "Deutsch");
      trigger.click();
      expect(reload).not.toHaveBeenCalled();
      const other = dom.document.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="false"]')!;
      expect(other).not.toBeNull();
      other.click();
      expect(dom.document.cookie).toContain(`cloud.locale=${locale === "en" ? "de" : "en"}`);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(dom.window.location.href).toBe(href);
    } finally {
      reload.mockRestore();
      dispose();
      dom.cleanup();
    }
  });
});
