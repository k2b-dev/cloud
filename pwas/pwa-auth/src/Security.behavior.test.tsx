import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Preferences } from "./preferences";
import type { Vault } from "./vault";

let dom: DomTestHarness;
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(async () => {
  const { closeDialogs } = await import("./dialog");
  closeDialogs();
  await Bun.sleep(20);
  dom.cleanup();
});

function fakeVault(status: ReturnType<Vault["status"]>, protectedByPin = false) {
  const setups: (string | undefined)[] = [];
  const [current, setCurrent] = createSignal(status);
  const vault: Vault = {
    header: () => undefined,
    protectedByPin: () => protectedByPin,
    status: current,
    lock: () => {},
    unlock: async () => {},
    setup: async (pin?: string) => {
      setups.push(pin);
      setCurrent("open");
    },
    verify: async () => {
      throw new Error("not used");
    },
    change: async () => {},
    addPin: async () => {},
    reset: async () => {},
    cancelPending: () => {},
    retryAfter: () => 0,
    session: () => {
      throw new Error("not used");
    },
  };
  return { vault, setups };
}

const preferences = (locale: "en" | "de"): Preferences => ({
  locale: () => locale,
  language: () => locale,
  theme: () => "light",
  setLanguage: () => {},
  setTheme: () => {},
});

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const headerButtons = () =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>(".k2b-panel-dialog__header button") ?? [])].map((b) => b.getAttribute("aria-label"));
const footerButtons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".k2b-panel-dialog__footer button") ?? [])];
const footerLabels = () => footerButtons().map((b) => b.textContent?.trim());
const footerButton = (label: string) => footerButtons().find((b) => b.textContent?.trim() === label)!;
const type = (label: string, value: string) => {
  const field = [...(dialog()?.querySelectorAll("label") ?? [])].find((l) => l.textContent?.trim() === label);
  const input = dialog()?.querySelector<HTMLInputElement>(`input[id="${field?.htmlFor}"]`);
  if (!input) throw new Error(`No input labelled ${label}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

test("the PIN prompt offers one PIN entry and a secondary way to continue without one", async () => {
  const { openSecurity } = await import("./Security");
  const { vault, setups } = fakeVault("empty");
  const result = openSecurity(vault, preferences("en"), "setup");
  await Bun.sleep(30);

  // Close sits in the header; the footer holds exactly the two decisions, stacked full width.
  expect(headerButtons()).toEqual(["Close"]);
  expect(footerLabels()).toEqual(["Save protection", "Continue without PIN"]);
  expect(dialog()?.querySelector(".k2b-panel-dialog__footer .auth-dialog-actions--stack")).not.toBeNull();

  // Six digits, confirmed by repetition, stay required.
  expect(footerButton("Save protection").disabled).toBe(true);
  type("App PIN", "12345");
  type("Repeat PIN", "12345");
  await Bun.sleep(0);
  expect(footerButton("Save protection").disabled).toBe(true);
  type("App PIN", "123456");
  type("Repeat PIN", "654321");
  await Bun.sleep(0);
  expect(footerButton("Save protection").disabled).toBe(true);
  type("Repeat PIN", "123456");
  await Bun.sleep(0);
  expect(footerButton("Save protection").disabled).toBe(false);
  footerButton("Save protection").click();
  expect(await result).toBe(true);
  expect(setups).toEqual(["123456"]);
});

test("continuing without a PIN and closing stay reachable in German", async () => {
  const { openSecurity } = await import("./Security");
  const skipped = fakeVault("empty");
  const skip = openSecurity(skipped.vault, preferences("de"), "setup");
  await Bun.sleep(30);
  expect(headerButtons()).toEqual(["Schließen"]);
  expect(footerLabels()).toEqual(["Schutz speichern", "Ohne PIN fortfahren"]);
  footerButton("Ohne PIN fortfahren").click();
  expect(await skip).toBe(true);
  expect(skipped.setups).toEqual([undefined]);

  const closed = fakeVault("empty");
  const close = openSecurity(closed.vault, preferences("de"), "setup");
  await Bun.sleep(30);
  dialog()!.querySelector<HTMLButtonElement>('.k2b-panel-dialog__header button[aria-label="Schließen"]')!.click();
  expect(await close).toBeUndefined();
  expect(closed.setups).toEqual([]);
});

test("other security modes keep close in the header and show only their own action", async () => {
  const { openSecurity } = await import("./Security");
  const cases: [Parameters<typeof openSecurity>[2], ReturnType<Vault["status"]>, boolean, string[]][] = [
    ["unlock", "locked", true, []],
    ["manage", "open", true, []],
    ["manage", "open", false, ["Save protection"]],
    ["reset", "locked", true, ["Reset Cloud Login"]],
  ];
  for (const [mode, status, pin, footer] of cases) {
    const result = openSecurity(fakeVault(status, pin).vault, preferences("en"), mode);
    await Bun.sleep(30);
    expect(headerButtons()).toEqual(["Close"]);
    expect(footerLabels()).toEqual(footer);
    dialog()!.querySelector<HTMLButtonElement>('.k2b-panel-dialog__header button[aria-label="Close"]')!.click();
    expect(await result).toBeUndefined();
  }
});
