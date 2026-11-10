import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  restoreFetch?.();
  restoreFetch = undefined;
  dom.cleanup();
});

/** Answers the timer's save with `status`; returns the bodies the menu sent. */
const serve = (status: () => number) => {
  const bodies: unknown[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url, "http://localhost").pathname.endsWith("/me/screen")) return new Response(null, { status: 404 });
    const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
    bodies.push(JSON.parse(body));
    return new Response(status() === 200 ? body : JSON.stringify({ message: "down" }), {
      status: status(),
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = previous);
  return bodies;
};

const mount = async () => {
  dom.root.innerHTML = `<script id="cloud-shell-data" type="application/json">${JSON.stringify({
    apps: [],
    legalLinks: [],
    searchLinks: {},
    theme: "system",
    privacyTimerSeconds: 120,
  })}</script><div class="cloud-app-canvas" data-layout-authenticated="true"></div>`;
  const canvas = dom.root.querySelector<HTMLElement>(".cloud-app-canvas")!;
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ProfilePreferences } = await import("./ProfilePreferences");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ProfilePreferences, { name: "Mia Muster", initialTheme: "system" });
        },
      }),
    canvas,
  );
  const panel = canvas.querySelector<HTMLElement>(".layout-profile-preferences__panel")!;
  const options = () => [...panel.querySelectorAll<HTMLButtonElement>(".k2b-segmented-control__option")];
  const checked = () => options().find((option) => option.getAttribute("aria-checked") === "true")?.textContent;
  return { panel, options, checked };
};
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await new Promise((done) => setTimeout(done, 10));
  expect(condition()).toBe(true);
};

test("the profile panel offers Privacy screen now with its shortcut and the timer Off · 30 s · 1 · 2 · 5 min, set to 2 min", async () => {
  const menu = await mount();
  expect(menu.panel.textContent).toContain("Sichtschutz · für dich");
  expect(menu.options().map((option) => option.textContent)).toEqual(["Aus", "30 s", "1 min", "2 min", "5 min"]);
  expect(menu.checked()).toBe("2 min");
  const requests: string[] = [];
  window.addEventListener("cloud.privacy.request", (event) => requests.push((event as CustomEvent<{ action: string }>).detail.action));
  const now = [...menu.panel.querySelectorAll<HTMLButtonElement>(".menu-item")].find((item) =>
    item.textContent?.includes("Sichtschutz jetzt"),
  )!;
  expect(now.querySelector(".k2b-kbd")).not.toBeNull();
  now.click();
  expect(requests).toEqual(["on"]);
});

test("a timer that does not save springs back and offers to try again; the retry saves it", async () => {
  let status = 500;
  const bodies = serve(() => status);
  const menu = await mount();
  const heard: number[] = [];
  window.addEventListener("cloud.privacy.timer", (event) => heard.push((event as CustomEvent<number>).detail));
  menu.options()[2]!.click();
  // The choice shows at once.
  expect(menu.checked()).toBe("1 min");
  await until(() => menu.checked() === "2 min");
  expect(bodies).toEqual([{ privacyTimerSeconds: 60 }]);
  expect(heard).toEqual([]);
  const toast = () => document.querySelector(".k2b-toast");
  await until(() => Boolean(toast()?.textContent?.includes("Timer nicht gespeichert. Es bleibt bei „2 min“.")));
  const retry = [...toast()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Erneut versuchen")!;
  status = 200;
  retry.click();
  await until(() => menu.checked() === "1 min" && heard.length === 1);
  expect(bodies).toEqual([{ privacyTimerSeconds: 60 }, { privacyTimerSeconds: 60 }]);
  expect(heard).toEqual([60]);
});

test("the touch menu offers the same entries where a mouse or touchpad is also connected", async () => {
  const open = new WeakSet<HTMLElement>();
  const matches = HTMLElement.prototype.matches;
  Object.defineProperty(HTMLElement.prototype, "matches", {
    configurable: true,
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  HTMLElement.prototype.showPopover = function () {
    open.add(this);
  };
  HTMLElement.prototype.hidePopover = function () {
    open.delete(this);
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({ matches: media === "(any-pointer: fine)", media, addEventListener() {}, removeEventListener() {} }),
  });
  await mount();
  document.querySelector<HTMLButtonElement>(".layout-profile-preferences .k2b-dropdown__trigger")!.click();
  await Promise.resolve();
  const sections = [...document.querySelectorAll<HTMLElement>(".layout-profile-preferences .k2b-dropdown__menu .k2b-dropdown__section")];
  expect(sections.map((section) => section.querySelector(".k2b-dropdown__label")?.textContent ?? null)).toEqual([
    null,
    "Sichtschutz · für dich",
    "Automatisch verdecken",
    null,
    null,
  ]);
  const radios = [...sections[2]!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(radios.map((radio) => radio.textContent?.trim())).toEqual(["Aus", "30 s", "1 min", "2 min", "5 min"]);
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true", "false"]);
});

test("quick choices save one after another and the last one wins, also when an earlier answer comes late", async () => {
  const bodies: unknown[] = [];
  const answers: (() => void)[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(JSON.parse(body));
    await new Promise<void>((done) => answers.push(done));
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = previous);
  const menu = await mount();
  const heard: number[] = [];
  window.addEventListener("cloud.privacy.timer", (event) => heard.push((event as CustomEvent<number>).detail));
  menu.options()[1]!.click();
  menu.options()[0]!.click();
  menu.options()[4]!.click();
  expect(menu.checked()).toBe("5 min");
  await until(() => answers.length === 1);
  // Only one save runs; the choices in between are not sent.
  expect(bodies).toEqual([{ privacyTimerSeconds: 30 }]);
  answers.shift()!();
  await until(() => answers.length === 1 && bodies.length === 2);
  expect(bodies).toEqual([{ privacyTimerSeconds: 30 }, { privacyTimerSeconds: 300 }]);
  expect(heard).toEqual([]);
  expect(menu.checked()).toBe("5 min");
  answers.shift()!();
  await until(() => heard.length === 1);
  expect(heard).toEqual([300]);
  expect(menu.checked()).toBe("5 min");
});

test("when an earlier choice saved and the last one fails, every listener hears the saved one", async () => {
  const answers: ((status: number) => void)[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const status = await new Promise<number>((done) => answers.push(done));
    return new Response(String(init?.body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = previous);
  const menu = await mount();
  const heard: number[] = [];
  window.addEventListener("cloud.privacy.timer", (event) => heard.push((event as CustomEvent<number>).detail));
  menu.options()[1]!.click();
  menu.options()[4]!.click();
  await until(() => answers.length === 1);
  answers.shift()!(200);
  await until(() => answers.length === 1);
  answers.shift()!(503);
  await until(() => heard.length === 1);
  expect(heard).toEqual([30]);
  expect(menu.checked()).toBe("30 s");
});

test("arrow keys move through the timer", async () => {
  const bodies = serve(() => 200);
  const menu = await mount();
  menu.options()[3]!.focus();
  menu.options()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => menu.checked() === "5 min");
  await until(() => bodies.length === 1);
  expect(bodies).toEqual([{ privacyTimerSeconds: 300 }]);
});
