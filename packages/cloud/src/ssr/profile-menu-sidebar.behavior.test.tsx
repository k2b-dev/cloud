import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
beforeEach(() => {
  dom = createDomTestHarness();
  document.cookie = "cloud_shell_focus=; Max-Age=0; path=/";
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

const mount = async (hidden = false) => {
  installPopoverStub();
  dom.root.innerHTML = `<div class="cloud-app-canvas" data-layout-authenticated="true" ${hidden ? 'data-shell-focus="true"' : ""}></div>`;
  const canvas = dom.root.querySelector<HTMLElement>(".cloud-app-canvas")!;
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ProfilePreferences } = await import("./ProfilePreferences");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ProfilePreferences, { name: "Test user", initialTheme: "system", appHref: "/me/app" });
        },
      }),
    canvas,
  );
  const profile = canvas.querySelector<HTMLElement>(".layout-profile-preferences")!;
  const trigger = profile.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
  const menu = () => profile.querySelector<HTMLElement>(".k2b-dropdown__menu")!;
  const open = async () => {
    trigger.click();
    await Promise.resolve();
    return [...menu().querySelectorAll<HTMLElement>(".k2b-dropdown__section")].map((section) => [
      ...section.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ]);
  };
  const label = (item: Element) => item.querySelector(".k2b-dropdown__copy")!.textContent;
  return { canvas, profile, trigger, menu, open, label };
};

test("the hover menu starts with the sidebar entries and ends with sign-out in the danger tone, each in a section", async () => {
  const page = await mount();
  const sections = [...page.profile.querySelectorAll(".layout-profile-preferences__panel > .layout-profile-preferences__section")];
  expect(sections.map((section) => [...section.querySelectorAll(".menu-item > span")].map((label) => label.textContent))).toEqual([
    ["Seitenleiste ausblenden", "Seitenleiste einblenden"],
    ["Automatisch", "English", "Profileinstellungen", "App"],
    ["Abmelden"],
  ]);
  const [hide, show] = sections[0]!.querySelectorAll<HTMLElement>(".menu-item");
  // The canvas state picks one of the two in CSS; the server's markup carries both and the shortcut.
  expect(hide!.dataset.cloudShellFocusToggle).toBe("hide");
  expect(show!.dataset.cloudShellFocusToggle).toBe("show");
  expect(hide!.querySelector(".k2b-kbd")).not.toBeNull();
  expect(sections[2]!.querySelector(".menu-item")!.getAttribute("data-danger")).toBe("true");
  expect(sections[1]!.querySelector('[data-danger="true"]')).toBeNull();
  // Both avatars are where focus returns after the sidebar changes.
  expect(page.profile.querySelectorAll("[data-cloud-shell-focus-return]")).toHaveLength(2);
});

test("the touch menu hides the sidebar, then offers to show it, also after the shortcut changed it", async () => {
  const page = await mount();
  let sections = await page.open();
  expect(sections.map((items) => items.map(page.label))).toEqual([
    ["Seitenleiste ausblenden"],
    ["Automatisch", "English", "Profileinstellungen", "App"],
    ["Abmelden"],
  ]);
  const toggle = sections[0]![0];
  const signOut = sections[2]![0];
  expect(toggle!.querySelector("i")?.className).toBe("ti ti-layout-sidebar-left-collapse");
  expect(toggle!.querySelector(".k2b-kbd")).not.toBeNull();
  expect(signOut!.dataset.danger).toBe("true");
  toggle!.click();
  await Promise.resolve();
  expect(page.canvas.dataset.shellFocus).toBe("true");
  expect(document.cookie).toContain("cloud_shell_focus=1");
  expect(page.menu().matches(":popover-open")).toBe(false);

  sections = await page.open();
  expect(page.label(sections[0]![0]!)).toBe("Seitenleiste einblenden");
  expect(sections[0]![0]!.querySelector("i")?.className).toBe("ti ti-layout-sidebar-left-expand");
  sections[0]![0]!.click();
  await Promise.resolve();
  expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);

  // Cmd/Ctrl+\ and the command run setShellFocus; the menu follows its event.
  const { setShellFocus } = await import("../browser/shell-focus");
  setShellFocus(true);
  sections = await page.open();
  expect(page.label(sections[0]![0]!)).toBe("Seitenleiste einblenden");
});

test("a page served with the sidebar hidden opens the avatar menu with the way back", async () => {
  const page = await mount(true);
  const toggle = (await page.open())[0]![0];
  expect(page.label(toggle!)).toBe("Seitenleiste einblenden");
  toggle!.click();
  await Promise.resolve();
  expect(page.canvas.hasAttribute("data-shell-focus")).toBe(false);
});
