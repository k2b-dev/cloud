import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  dom.cleanup();
});

const mount = async (locale: string) => {
  // @k2b/ui and the island touch the DOM on import, so load them after the harness exists.
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: MinimalLayoutPreferences } = await import("./MinimalLayoutPreferences.island");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(MinimalLayoutPreferences, { initialTheme: "light" });
        },
      }),
    dom.root,
  );
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const choose = (name: string) =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find((item) => item.textContent?.trim() === name)!
      .click();
  return { reload, choose };
};

const localeCookie = () => /(?:^|; )cloud\.locale=([^;]*)/.exec(document.cookie)?.[1];

test("choosing the other language stores it and reloads the page", async () => {
  const { reload, choose } = await mount("en");
  expect(dom.root.querySelector("[aria-haspopup]")?.getAttribute("aria-label")).toBe("Language: English");

  choose("Deutsch");

  expect(localeCookie()).toBe("de");
  expect(reload).toHaveBeenCalledTimes(1);
});

test("choosing the current language keeps a regional locale without a reload", async () => {
  const { reload, choose } = await mount("en-GB");

  choose("English");

  expect(localeCookie()).toBeUndefined();
  expect(reload).not.toHaveBeenCalled();
});

test("a visitor on an unsupported locale can still choose the English fallback", async () => {
  const { reload, choose } = await mount("fr-FR");
  expect(dom.root.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.trim()).toBe("English");

  choose("English");

  expect(localeCookie()).toBe("en");
  expect(reload).toHaveBeenCalledTimes(1);
});

for (const [locale, labels, appearance] of [
  ["en", ["Light", "Dark", "Automatic"], "Appearance"],
  ["de", ["Hell", "Dunkel", "Automatisch"], "Darstellung"],
] as const) {
  test(`the appearance menu persists all three choices (${locale})`, async () => {
    const media = spyOn(window, "matchMedia").mockImplementation(() => ({
      matches: true,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }));
    try {
      const { choose } = await mount(locale);
      const radios = Array.from(dom.root.querySelectorAll('[role="menuitemradio"]')).slice(2);
      expect(radios.map((item) => item.textContent?.trim())).toEqual([...labels]);
      const trigger = dom.root.querySelectorAll("[aria-haspopup]")[1]!;
      expect(trigger.getAttribute("aria-label")).toBe(`${appearance}: ${labels[2]}`);
      let changes = 0;
      window.addEventListener("cloud:theme-preference", () => changes++);

      choose(labels[2]);
      expect(document.cookie).toContain("theme=system");
      expect(document.documentElement.className).toBe("dark");
      expect(radios[2]!.getAttribute("aria-checked")).toBe("true");

      choose(labels[1]);
      expect(document.cookie).toContain("theme=dark");
      expect(document.documentElement.className).toBe("dark");
      expect(trigger.getAttribute("aria-label")).toBe(`${appearance}: ${labels[1]}`);
      expect(changes).toBe(2);

      choose(labels[0]);
      expect(document.cookie).toContain("theme=light");
      expect(document.documentElement.className).toBe("light");
    } finally {
      media.mockRestore();
    }
  });
}
