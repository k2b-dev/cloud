import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
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

const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await new Promise((done) => setTimeout(done, 10));
  expect(condition()).toBe(true);
};

const fine = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: matches && media === "(any-pointer: fine)",
      media,
      addEventListener() {},
      removeEventListener() {},
    }),
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
  HTMLElement.prototype.showPopover = function () {
    open.add(this);
  };
  HTMLElement.prototype.hidePopover = function () {
    open.delete(this);
  };
};

const mount = async (locale = "de") => {
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
        locale,
        get children() {
          return createComponent(ProfilePreferences, { name: "Mia Muster", initialTheme: "system", userId: "u1" });
        },
      }),
    canvas,
  );
  return canvas.querySelector<HTMLElement>(".layout-profile-preferences")!;
};

test("the profile panel holds one screen section: Privacy screen with its shortcut and the shared workstation switch, one line each", async () => {
  fine(true);
  const profile = await mount();
  const panel = profile.querySelector<HTMLElement>(".layout-profile-preferences__panel")!;
  const sections = [...panel.querySelectorAll(":scope > .layout-profile-preferences__section")];
  const screen = sections[1]!;
  const rows = [...screen.querySelectorAll<HTMLElement>(".menu-item")];
  expect(rows.map((row) => row.querySelector(":scope > span:last-of-type")?.textContent)).toEqual([
    "Sichtschutz",
    "Gemeinsam genutzter Arbeitsplatz",
  ]);
  // No section headings, no descriptions and no timer row in the menu: the timer lives under /me.
  expect(screen.querySelector("small, .k2b-segmented-control, [role=radio]")).toBeNull();
  expect(panel.querySelector(".k2b-segmented-control")).toBeNull();
  expect(rows[0]!.querySelector(".k2b-kbd")).not.toBeNull();
  expect(rows[0]!.getAttribute("aria-keyshortcuts")).toBe("Control+Period");
  expect(rows[1]!.getAttribute("role")).toBe("switch");
  expect(rows[1]!.getAttribute("aria-checked")).toBe("false");
  const requests: string[] = [];
  window.addEventListener("cloud.privacy.request", (event) => requests.push((event as CustomEvent<{ action: string }>).detail.action));
  rows[0]!.click();
  expect(requests).toEqual(["on"]);
});

test("the touch menu offers the same two entries where a mouse or touchpad is also connected, and only the switch without one", async () => {
  installPopoverStub();
  for (const [pointer, labels] of [
    [true, ["Sichtschutz", "Gemeinsam genutzter Arbeitsplatz"]],
    [false, ["Gemeinsam genutzter Arbeitsplatz"]],
  ] as const) {
    fine(pointer);
    const profile = await mount();
    profile.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!.click();
    await Promise.resolve();
    const sections = [...profile.querySelectorAll<HTMLElement>(".k2b-dropdown__menu .k2b-dropdown__section")];
    expect(sections.some((section) => section.querySelector(".k2b-dropdown__label"))).toBe(false);
    const screen = sections[1]!;
    expect([...screen.querySelectorAll(".k2b-dropdown__copy > span")].map((label) => label.textContent)).toEqual([...labels]);
    expect(screen.querySelector(".k2b-dropdown__copy > small")).toBeNull();
    expect(profile.querySelector('.k2b-dropdown__menu [role="menuitemradio"]')).toBeNull();
    dispose?.();
    dispose = undefined;
  }
});

/** Drives the timer choice that Profile settings › At your screen uses; `answer` decides each save. */
const choice = async (answer: () => Promise<number>) => {
  const bodies: unknown[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const status = await answer();
    return new Response(String(init?.body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = previous);
  const heard: number[] = [];
  window.addEventListener("cloud.privacy.timer", (event) => heard.push((event as CustomEvent<number>).detail));
  const { createPrivacyTimerChoice } = await import("./privacy-timer-choice");
  const timer = createRoot((done) => {
    dispose = done;
    return createPrivacyTimerChoice(120, () => "de");
  });
  return { timer, bodies, heard };
};

test("quick timer choices save one after another and the last one wins, also when an earlier answer comes late", async () => {
  const answers: (() => void)[] = [];
  const { timer, bodies, heard } = await choice(() => new Promise<number>((done) => answers.push(() => done(200))));
  timer.choose(30);
  timer.choose(0);
  timer.choose(300);
  expect(timer.value()).toBe(300);
  await until(() => answers.length === 1);
  expect(bodies).toEqual([{ privacyTimerSeconds: 30 }]);
  answers.shift()!();
  await until(() => answers.length === 1 && bodies.length === 2);
  expect(bodies).toEqual([{ privacyTimerSeconds: 30 }, { privacyTimerSeconds: 300 }]);
  expect(heard).toEqual([]);
  answers.shift()!();
  await until(() => heard.length === 1);
  expect(heard).toEqual([300]);
  expect(timer.value()).toBe(300);
});

test("when an earlier timer choice saved and the last one fails, every listener hears the saved one", async () => {
  const answers: ((status: number) => void)[] = [];
  const { timer, heard } = await choice(() => new Promise<number>((done) => answers.push(done)));
  timer.choose(30);
  timer.choose(300);
  await until(() => answers.length === 1);
  answers.shift()!(200);
  await until(() => answers.length === 1);
  answers.shift()!(503);
  await until(() => heard.length === 1);
  expect(heard).toEqual([30]);
  expect(timer.value()).toBe(30);
  expect(timer.failed()).toBe(300);
});
