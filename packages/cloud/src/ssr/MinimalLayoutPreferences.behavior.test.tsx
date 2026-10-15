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
          return createComponent(MinimalLayoutPreferences, { initialTheme: "system" });
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

for (const [locale, labels, appearance, switches] of [
  ["en", ["Light", "Dark", "Automatic"], "Appearance", "Switches to"],
  ["de", ["Hell", "Dunkel", "Automatisch"], "Darstellung", "Wechselt zu"],
] as const) {
  test(`the appearance button cycles and persists all three choices (${locale})`, async () => {
    document.cookie = "theme=system; path=/";
    document.documentElement.className = "dark";
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
    let changes = 0;
    const changed = () => changes++;
    window.addEventListener("cloud:theme-preference", changed);
    try {
      await mount(locale);
      expect(dom.root.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
      const button = dom.root.querySelector<HTMLButtonElement>(".cloud-theme-cycle")!;
      expect(button.getAttribute("aria-label")).toBe(`${appearance}: ${labels[2]}. ${switches} ${labels[0]}.`);
      expect(dom.root.querySelector('[aria-live="polite"]')?.textContent).toBe("");
      for (const [index, value, icon, theme] of [
        [0, "light", "ti ti-sun-high", "light"],
        [1, "dark", "ti ti-moon", "dark"],
        [2, "system", "ti ti-device-laptop", "dark"],
      ] as const) {
        button.click();
        expect(document.cookie).toContain(`theme=${value}`);
        expect(document.documentElement.className).toBe(theme);
        expect(button.getAttribute("aria-label")).toBe(`${appearance}: ${labels[index]}. ${switches} ${labels[(index + 1) % 3]}.`);
        expect(button.querySelector(".cloud-theme-cycle__label > span")?.textContent).toBe(labels[index]);
        expect(button.querySelector("i")?.className).toBe(icon);
        expect(dom.root.querySelector('[aria-live="polite"]')?.textContent).toBe(`${appearance}: ${labels[index]}`);
        expect(changes).toBe(index + 1);
        expect(dom.root.querySelector(".cloud-theme-cycle")).toBe(button);
      }
    } finally {
      window.removeEventListener("cloud:theme-preference", changed);
      media.mockRestore();
    }
  });
}
