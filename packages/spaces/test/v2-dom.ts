import type { DomTestHarness } from "../../ui/test/dom";

/**
 * What the v2 dialogs, menus and fields read from the window that the shared happy-dom harness leaves out: the element
 * classes the focus code of ui-sdk checks, and a media query (never the phone) for the dialog's sheet.
 */
export const installV2Globals = (dom: DomTestHarness) => {
  const window = dom.window as unknown as Record<string, unknown>;
  Object.assign(globalThis, {
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLSlotElement: window.HTMLSlotElement,
    HTMLFieldSetElement: window.HTMLFieldSetElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLLabelElement: window.HTMLLabelElement,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
};

/** A button of the page or of an open dialog by its words or its name. */
export const buttonNamed = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );

/** The control of a v2 field by its label's words. */
export const fieldControl = <T extends Element = HTMLInputElement>(dom: DomTestHarness, label: string) => {
  const field = [...dom.document.querySelectorAll('[data-k2-part="Field"]')].find(
    (candidate) => candidate.querySelector("label")?.textContent?.trim().startsWith(label) ?? false,
  );
  return field?.querySelector<T & Element>("input, textarea, button, select") ?? null;
};

/** Sends the open dialog with its main button, the last one of its foot. */
export const sendDialog = (dom: DomTestHarness) => {
  const dialogs = [...dom.document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const buttons = [...(dialogs.at(-1)?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  buttons.at(-1)?.click();
};

/**
 * Opens the v2 menu with this name and returns its entry with these words (`aria-disabled="true"` when it cannot be
 * chosen now); a click on it chooses it and closes the menu.
 */
export const menuEntry = async (dom: DomTestHarness, menu: string, entry: string) => {
  dom.document.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)?.click();
  await Bun.sleep(10);
  const open = [...dom.document.querySelectorAll<HTMLElement>('[role="menu"][data-open]')].at(-1);
  return [...(open?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find((item) => item.textContent?.trim() === entry);
};

/** Picks an option of a v2 `Choice` by its words. */
export const choose = (dom: DomTestHarness, label: string) => {
  const option = [...dom.document.querySelectorAll<HTMLElement>("label")].find((entry) => entry.textContent?.trim() === label);
  (option?.querySelector<HTMLInputElement>("input") ?? option)?.click();
};
