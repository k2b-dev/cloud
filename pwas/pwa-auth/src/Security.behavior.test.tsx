import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Preferences } from "./preferences";
import type { Vault } from "./vault";

let dom: DomTestHarness;
beforeEach(() => {
  dom = createDomTestHarness();
  delegateEvents(["input", "keydown", "focusin"]);
});
afterEach(async () => {
  const { closeDialogs } = await import("./dialog");
  closeDialogs();
  await Bun.sleep(20);
  dom.cleanup();
});

function fakeVault() {
  const pins: string[] = [];
  const [status, setStatus] = createSignal<ReturnType<Vault["status"]>>("locked");
  const vault: Vault = {
    header: () => undefined,
    status,
    unlock: async (pin) => {
      pins.push(pin);
      setStatus("open");
    },
    setup: async () => {},
    reset: async () => {},
    cancelPending: () => {},
    retryAfter: () => 0,
    session: () => {
      throw new Error("not used");
    },
  };
  return { vault, pins };
}
const preferences = (locale: "en" | "de"): Preferences => ({
  locale: () => locale,
  language: () => locale,
  theme: () => "light",
  setLanguage: () => {},
  setTheme: () => {},
});

for (const [locale, title, help] of [
  ["en", "Remove app PIN", "Cloud Login no longer uses an app PIN. Enter your PIN one last time to keep your connected Clouds."],
  [
    "de",
    "App-PIN entfernen",
    "Cloud Login verwendet keine App-PIN mehr. Gib deine PIN ein letztes Mal ein, um deine verbundenen Clouds zu behalten.",
  ],
] as const) {
  test(`legacy unlock explains PIN removal in ${locale} and submits once`, async () => {
    const { openSecurity } = await import("./Security");
    const { vault, pins } = fakeVault();
    const result = openSecurity(vault, preferences(locale), "unlock");
    await Bun.sleep(30);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(dialog.textContent).toContain(title);
    expect(dialog.textContent).toContain(help);
    expect(dialog.querySelector(".k2b-panel-dialog__footer")).toBeNull();
    expect(dialog.textContent).not.toContain("Repeat PIN");
    expect(dialog.textContent).not.toContain("Save protection");
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>(".k2b-pin-input input")];
    expect(inputs).toHaveLength(6);
    for (const [i, digit] of [..."012345"].entries()) {
      inputs[i]!.value = digit;
      inputs[i]!.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(await result).toBe(true);
    expect(pins).toEqual(["012345"]);
  });
}

test("reset keeps its explicit confirmation and has no PIN fields", async () => {
  const { openSecurity } = await import("./Security");
  const result = openSecurity(fakeVault().vault, preferences("en"), "reset");
  await Bun.sleep(30);
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(dialog.querySelector(".k2b-pin-input")).toBeNull();
  const reset = dialog.querySelector<HTMLButtonElement>(".k2b-panel-dialog__footer button")!;
  expect(reset.textContent).toBe("Reset Cloud Login");
  expect(reset.disabled).toBe(true);
  dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
  expect(await result).toBeUndefined();
});
