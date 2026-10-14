import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
beforeEach(() => {
  dom = createDomTestHarness();
  document.cookie = "theme=system; path=/";
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  dom.cleanup();
});

const installPopoverStub = () => {
  const open = new WeakSet<HTMLElement>();
  const matches = HTMLElement.prototype.matches;
  Object.defineProperty(HTMLElement.prototype, "matches", {
    configurable: true,
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  const toggle = (element: HTMLElement, oldState: string, newState: string) => {
    const event = new Event("toggle");
    Object.defineProperties(event, { oldState: { value: oldState }, newState: { value: newState } });
    element.dispatchEvent(event);
  };
  HTMLElement.prototype.showPopover = function () {
    open.add(this);
    toggle(this, "closed", "open");
  };
  HTMLElement.prototype.hidePopover = function () {
    open.delete(this);
    toggle(this, "open", "closed");
  };
};

const choices = [
  ["Hell", "Dunkel", "ti ti-sun-high"],
  ["Dunkel", "Automatisch", "ti ti-moon"],
  ["Automatisch", "Hell", "ti ti-device-laptop"],
] as const;

test("the profile appearance row cycles in place, keeps the menu open and keeps focus", async () => {
  installPopoverStub();
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ProfilePreferences } = await import("./ProfilePreferences");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ProfilePreferences, { name: "Test user", initialTheme: "system" });
        },
      }),
    dom.root,
  );
  const profile = dom.root.querySelector(".layout-profile-preferences")!;
  const trigger = profile.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
  trigger.click();
  await Promise.resolve();
  const menu = profile.querySelector<HTMLElement>(".k2b-dropdown__menu")!;
  const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(item.textContent).toBe("Automatisch");
  expect(menu.querySelector('[data-divided="true"]')).toBeNull();
  expect(menu.querySelector('[role="menuitemradio"]')).toBeNull();
  expect(profile.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  item.focus();
  for (const [current, next, icon] of choices) {
    item.click();
    await Promise.resolve();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu.matches(":popover-open")).toBe(true);
    expect(menu.querySelector('[role="menuitem"]')).toBe(item);
    expect(item.textContent).toBe(current);
    expect(item.querySelector("i")?.className).toBe(icon);
    expect(item.getAttribute("aria-label")).toBe(`Darstellung: ${current}. Wechselt zu ${next}.`);
    expect(profile.querySelector('[aria-live="polite"]')?.textContent).toBe(`Darstellung: ${current}`);
    expect(document.activeElement).toBe(item);
  }
});

test("the mobile profile menu has one appearance button that cycles", async () => {
  dom.window.innerWidth = 390;
  document.documentElement.lang = "de";
  const { LocaleProvider } = await import("@k2b/ui");
  const { AppLaunchpadButton } = await import("./app-launchpad");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(AppLaunchpadButton, {
            variant: "header",
            apps: [],
            legalLinks: [{ label: "Profile", href: "/me" }],
            profile: { name: "Test user", theme: "system" },
          });
        },
      }),
    dom.root,
  );
  dom.root.querySelector<HTMLButtonElement>("button")!.click();
  try {
    for (let attempt = 0; !document.querySelector("dialog .cloud-mobile-profile") && attempt < 100; attempt++) await Bun.sleep(10);
    const profile = document.querySelector("dialog .cloud-mobile-profile")!;
    expect(profile).not.toBeNull();
    expect(profile.querySelectorAll(".cloud-theme-cycle")).toHaveLength(1);
    expect(profile.querySelector('[role="radio"]')).toBeNull();
    const button = profile.querySelector<HTMLButtonElement>(".cloud-theme-cycle")!;
    for (const [current, next, icon] of choices) {
      button.click();
      expect(profile.querySelector(".cloud-theme-cycle")).toBe(button);
      expect(button.textContent).toBe(current);
      expect(button.querySelector("i")?.className).toBe(icon);
      expect(button.getAttribute("aria-label")).toBe(`Darstellung: ${current}. Wechselt zu ${next}.`);
    }
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    await Bun.sleep(20);
  }
});

test("a controller syncs another controller's choice without announcing it or keeping a stale announcement", async () => {
  const { createPreferenceController } = await import("./preference-controller");
  const { ThemeCycleButton } = await import("./ThemeCycleButton");
  dispose = render(
    () => [
      createComponent(ThemeCycleButton, { preferences: createPreferenceController("system", () => "en"), variant: "ghost" }),
      createComponent(ThemeCycleButton, { preferences: createPreferenceController("system", () => "en"), variant: "ghost" }),
    ],
    dom.root,
  );
  const buttons = dom.root.querySelectorAll<HTMLButtonElement>(".cloud-theme-cycle");
  buttons[0]!.click();
  expect(buttons[1]!.textContent).toBe("Light");
  expect(buttons[1]!.getAttribute("aria-label")).toBe("Appearance: Light. Switches to Dark.");
  const announcements = dom.root.querySelectorAll('[aria-live="polite"]');
  expect(announcements[0]!.textContent).toBe("Appearance: Light");
  expect(announcements[1]!.textContent).toBe("");
  buttons[1]!.click();
  expect(buttons[0]!.textContent).toBe("Dark");
  expect(announcements[0]!.textContent).toBe("");
  expect(announcements[1]!.textContent).toBe("Appearance: Dark");
});
