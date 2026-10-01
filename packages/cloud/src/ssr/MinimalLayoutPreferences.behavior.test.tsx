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

test("the theme button switches the theme and names the next mode", async () => {
  await mount("en");
  const button = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Dark mode")!;

  // Phones show only the icon, so the button carries its name as a label too.
  expect(button.getAttribute("aria-label")).toBe("Dark mode");

  button.click();

  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.cookie).toContain("theme=dark");
  expect([button.textContent?.trim(), button.getAttribute("aria-label")]).toEqual(["Light mode", "Light mode"]);
});
