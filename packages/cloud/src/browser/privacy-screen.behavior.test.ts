import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { PrivacyScreenText } from "./privacy-screen";
import { PRIVACY_REQUEST_EVENT, type PrivacyRequest } from "./privacy-timer";

const text: PrivacyScreenText = {
  title: "Sichtschutz",
  howToContinue: "Klicke oder drücke eine Taste.",
  keepWorking: "Weiterarbeiten",
  notALock: "Keine Sperre.",
  on: "Sichtschutz an.",
  onAfterIdle: "Sichtschutz an.",
  off: "Sichtschutz aus.",
  newMessages: "Neue Meldungen.",
  countdown: ({ seconds }) => `Sichtschutz in ${seconds} Sekunden.`,
  tabTitle: "Cloud",
};

let dom: DomTestHarness;
let restorePopover: () => void;
beforeEach(() => {
  dom = createDomTestHarness();
  // A browser without the popover API, such as Safari 16.
  const prototype = window.HTMLElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "showPopover");
  Object.defineProperty(prototype, "showPopover", { configurable: true, writable: true, value: undefined });
  restorePopover = () => {
    if (descriptor) Object.defineProperty(prototype, "showPopover", descriptor);
    else delete (prototype as { showPopover?: unknown }).showPopover;
  };
});
afterEach(() => {
  restorePopover();
  dom.cleanup();
});

const request = (action: PrivacyRequest["action"]) =>
  window.dispatchEvent(new CustomEvent<PrivacyRequest>(PRIVACY_REQUEST_EVENT, { detail: { action } }));

test("without the popover API there is no veil, and the screen still covers and shows again", async () => {
  // Loaded once the DOM is in place: @k2b/ui binds its event delegation to `window` on import.
  const { installPrivacyScreen } = await import("./privacy-screen");
  dom.root.innerHTML = "<p>Gehaltsübersicht 2026</p>";
  const dispose = installPrivacyScreen({ timerSeconds: 0, text: () => text });
  try {
    // Nothing would hide a veil while uncovered, so none is there.
    expect(document.querySelector(".cloud-privacy-veil")).toBeNull();
    request("on");
    expect(document.documentElement.dataset.cloudPrivacy).toBe("on");
    expect(dom.root.getAttribute("data-cloud-privacy-covered")).toBe("");
    expect(dom.root.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".cloud-privacy-veil")).toBeNull();
    request("off");
    expect(document.documentElement.dataset.cloudPrivacy).toBeUndefined();
    expect(dom.root.hasAttribute("data-cloud-privacy-covered")).toBe(false);
    expect(dom.root.hasAttribute("inert")).toBe(false);
  } finally {
    dispose();
  }
});
