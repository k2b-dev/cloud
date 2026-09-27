import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator } from "./authenticator";
import type { Installation } from "./install";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";
import type { Vault } from "./vault";

let dom: DomTestHarness;
let clouds = 0;
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);

beforeEach(() => {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
});
afterEach(() => dom.cleanup());

// The shell is under test, not key storage or the network: an open vault with `clouds` paired Clouds.
mock.module("./vault", () => ({
  createVault: (): Vault => ({
    header: () => undefined,
    protectedByPin: () => false,
    status: () => "open",
    lock: () => {},
    unlock: async () => {},
    setup: async () => {},
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
  }),
}));
mock.module("./authenticator", () => ({
  consumePairingLocation: () => undefined,
  failure: () => "unavailable",
  createAuthenticator: (): Authenticator => {
    const bindings = Array.from(
      { length: clouds },
      (_, i): Binding => ({
        id: `cloud-${i}`,
        label: `Cloud ${i}`,
        name: `Cloud ${i}`,
        issuer: `http://cloud-${i}.localhost`,
        deviceId: `device-${i}`,
        key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
      }),
    );
    const noop = async () => {};
    return {
      bindings: () => bindings,
      states: () => Object.fromEntries(bindings.map((binding) => [binding.id, { requests: [] }])),
      now: Date.now,
      online: () => true,
      storageError: () => false,
      changed: noop,
      client: async () => {
        throw new Error("No network in this test");
      },
      stored: async () => undefined,
      account: async () => {
        throw new Error("No network in this test");
      },
      decide: noop,
      revoke: noop,
      syncPush: noop,
      forget: noop,
      rename: noop,
    };
  },
}));
mock.module("./install", () => ({
  installationPlatform: () => "generic",
  createInstallation: (): Installation => ({
    installed: () => true,
    busy: () => false,
    requested: () => false,
    failed: () => false,
    install: async () => {},
    platform: "generic",
    canPrompt: () => false,
    shouldIntroduce: () => false,
    markIntroduced: () => {},
  }),
}));

const preferences: Preferences = {
  locale: () => "en",
  language: () => "en",
  theme: () => "light",
  setLanguage: () => {},
  setTheme: () => {},
};

async function renderApp(count: number) {
  clouds = count;
  const { App } = await import("./App");
  const dispose = render(() => createComponent(App, { preferences }), dom.root);
  await Bun.sleep(20);
  return dispose;
}

const regions = () => [...(dom.root.querySelector(".auth-app")?.children ?? [])].map((element) => element.tagName.toLowerCase());

test("only the Cloud list scrolls; header and recovery note stay outside it", async () => {
  const dispose = await renderApp(6);
  expect(regions()).toEqual(["header", "main", "footer"]);
  const main = dom.root.querySelector(".auth-app > main")!;
  // One shared scrollport owns every card; the header and the footer note are its siblings.
  expect(main.children.length).toBe(1);
  const scroll = main.firstElementChild!;
  expect(scroll.classList.contains("k2b-scroll-area")).toBe(true);
  expect(scroll.querySelectorAll(".auth-cloud").length).toBe(6);
  expect(scroll.querySelector(".auth-recovery")).toBeNull();
  expect(dom.root.querySelector(".auth-app > footer .auth-recovery")?.textContent).toContain("Your connections are saved on this device.");
  dispose();
});

test("the welcome screen has no recovery footer", async () => {
  const dispose = await renderApp(0);
  expect(regions()).toEqual(["header", "main"]);
  expect(dom.root.querySelector(".auth-recovery")).toBeNull();
  dispose();
});

// happy-dom cascades the app's own stylesheet, media queries included; the imported @k2b/ui rules are not loaded.
async function style(viewport: { width: number; height: number }) {
  dom.window.happyDOM.setViewport(viewport);
  const sheet = dom.document.createElement("style");
  sheet.textContent = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  dom.document.head.append(sheet);
  return (selector: string) => getComputedStyle(dom.document.querySelector(selector)!);
}

test("the document itself can never scroll or rubber-band", async () => {
  const computed = await style({ width: 390, height: 844 });
  const dispose = await renderApp(6);
  for (const root of ["html", "body"]) {
    expect(computed(root).overflow).toBe("hidden");
    expect(computed(root).overscrollBehavior).toBe("none");
  }
  // Pinned to the viewport, so the shell adds no document height whatever the dynamic toolbars do.
  expect(computed(".auth-app").position).toBe("fixed");
  expect(computed(".auth-app").getPropertyValue("inset")).toBe("0");
  dispose();
});

// Portrait phones keep the note pinned; a phone in landscape gives its height to the list.
test.each([
  { width: 390, height: 844, pinned: true },
  { width: 320, height: 568, pinned: true },
  { width: 844, height: 390, pinned: false },
  { width: 750, height: 342, pinned: false },
])("at $width x $height the recovery note is pinned: $pinned", async ({ width, height, pinned }) => {
  const computed = await style({ width, height });
  const dispose = await renderApp(2);
  expect(computed(".auth-footer").display).toBe(pinned ? "block" : "none");
  dispose();
});
