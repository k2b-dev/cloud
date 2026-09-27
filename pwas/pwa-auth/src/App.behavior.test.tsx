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

test("the document itself can never scroll or rubber-band", async () => {
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const rule = (selector: string) =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  expect(rule("html,\nbody")).toMatch(/overflow:\s*hidden;/);
  expect(rule("html,\nbody")).toMatch(/overscroll-behavior:\s*none;/);
  expect(rule(".auth-app")).toMatch(/position:\s*fixed;/);
  expect(rule(".auth-app")).toMatch(/inset:\s*0;/);
  expect(rule(".auth-app")).not.toMatch(/height:\s*100[sd]?vh/);
});
