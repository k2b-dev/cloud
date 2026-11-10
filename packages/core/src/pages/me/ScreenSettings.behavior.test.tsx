import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

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

const until = async (condition: () => boolean, state: () => unknown) => {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await new Promise((done) => setTimeout(done, 10));
  if (!condition()) expect(state()).toBe("reached");
};

test("At your screen saves the timer at once, says so in place, and offers to try again when it fails", async () => {
  let status = 500;
  const bodies: unknown[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(status === 200 ? String(init?.body) : "{}", { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = previous);
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ScreenSettings } = await import("./ScreenSettings.island");
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ScreenSettings, { timerSeconds: 120 });
        },
      }),
    dom.root,
  );
  const section = dom.root.querySelector<HTMLElement>("#screen")!;
  expect(section.textContent).toContain("Am Bildschirm");
  expect(section.textContent).toContain("Für dich, auf allen Computern mit Maus oder Touchpad");
  const options = () => [...section.querySelectorAll<HTMLButtonElement>(".k2b-segmented-control__option")];
  const checked = () => options().find((option) => option.getAttribute("aria-checked") === "true")?.textContent;
  const status_ = () => section.querySelector('[role="status"]')?.textContent ?? "";
  expect(checked()).toBe("2 min");
  expect(status_()).toBe("");

  options()[0]!.click();
  expect(checked()).toBe("Aus");
  await until(
    () => checked() === "2 min" && status_().includes("Nicht gespeichert"),
    () => ({ checked: checked(), status: status_(), bodies }),
  );
  // The page names the failure in place; no toast repeats it.
  expect(document.querySelector(".k2b-toast")).toBeNull();
  status = 200;
  [...section.querySelectorAll<HTMLButtonElement>('[role="status"] button')]
    .find((button) => button.textContent === "Erneut versuchen")!
    .click();
  await until(
    () => checked() === "Aus" && status_().includes("Gespeichert"),
    () => ({ checked: checked(), status: status_(), bodies }),
  );
  expect(bodies).toEqual([{ privacyTimerSeconds: 0 }, { privacyTimerSeconds: 0 }]);

  const requests: string[] = [];
  window.addEventListener("cloud.privacy.request", (event) => requests.push((event as CustomEvent<{ action: string }>).detail.action));
  [...section.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ausprobieren")!.click();
  expect(requests).toEqual(["on"]);
});
