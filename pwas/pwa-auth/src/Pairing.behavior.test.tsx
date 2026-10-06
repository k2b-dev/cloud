import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator } from "./authenticator";

let dom: DomTestHarness;
let dispose = () => {};
beforeEach(() => {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
});
afterEach(() => {
  dispose();
  dom.cleanup();
});

const noop = async () => {};
// Scanning never reaches the authenticator; a pairing link would.
const auth: Authenticator = {
  bindings: () => [],
  states: () => ({}),
  now: Date.now,
  online: () => true,
  storageError: () => false,
  changed: noop,
  client: async () => {
    throw new Error("No network in this test");
  },
  stored: async () => undefined,
  account: async () => {
    throw new Error("No account in this test");
  },
  decide: noop,
  revoke: noop,
  syncPush: noop,
  forget: noop,
  rename: noop,
};

const text = () => dom.document.body.textContent ?? "";

for (const [name, message] of [
  [
    "NotAllowedError",
    "Camera access is off. Allow it for Cloud Login in your browser or phone settings, or paste the pairing link instead.",
  ],
  ["NotFoundError", "No camera was found on this device. Paste the pairing link instead."],
  [
    "NotReadableError",
    "The camera is busy or could not start. Close other apps that use it and try again, or paste the pairing link instead.",
  ],
  ["AbortError", "The camera could not be started. Try again, or paste the pairing link instead."],
] as const) {
  test(`a camera that answers ${name} says why and returns to the pairing link field`, async () => {
    Object.defineProperty(dom.window.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new dom.window.DOMException("The camera refused.", name);
        },
      },
    });
    const { Pairing } = await import("./Pairing");
    dispose = render(() => createComponent(Pairing, { auth, close: () => {} }), dom.root);
    const scan = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Scan QR code"));
    scan!.click();
    for (let attempt = 0; attempt < 100 && !dom.document.querySelector('[role="alert"]'); attempt++) await Bun.sleep(10);
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(dom.document.querySelector("video")).toBeNull();
    expect(text()).toContain("Pairing link");
  });
}
