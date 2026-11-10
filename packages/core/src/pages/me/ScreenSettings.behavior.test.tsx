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
  const marks: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/me/browser/shared-workstation")) {
      marks.push(JSON.parse(String(init?.body)));
      return Response.json({ sharedWorkstation: true, idle: { remainingSeconds: 600, timeoutSeconds: 600 } });
    }
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
          return createComponent(ScreenSettings, { timerSeconds: 120, sharedWorkstation: { userId: "u1", minutes: 10 } });
        },
      }),
    dom.root,
  );
  const section = dom.root.querySelector<HTMLElement>("#screen")!;
  expect(section.textContent).toContain("Am Bildschirm");
  // Short and quiet: one sentence under the title, and the admin's minutes beside the shared workstation switch.
  expect(section.textContent).toContain("Schützt deine Inhalte vor fremden Blicken.");
  expect(section.textContent).toContain("Dieser Browser meldet nach 10 Minuten ohne Eingabe ab.");
  const workstation = section.querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(workstation.checked).toBe(false);
  workstation.click();
  await until(
    () => workstation.checked && marks.length === 1,
    () => ({ marks }),
  );
  expect(marks).toEqual([{ shared: true }]);
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
  expect([...document.querySelectorAll(".k2b-toast")].some((toast) => toast.textContent?.includes("gespeichert"))).toBe(false);
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
