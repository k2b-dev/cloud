import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, Login } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

test("login requests use the shared sheet and dismiss without approving", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const binding: Binding = {
    id: "fixture",
    label: "Test Cloud",
    name: "Test",
    issuer: "http://localhost",
    deviceId: "device",
    key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
  };
  const request: Login = {
    requestId: "login",
    comparison: "123456",
    challenge: "unused",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const [requests, setRequests] = createSignal([request]);
  const decisions: string[] = [];
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: requests() } }),
    now: Date.now,
    online: () => true,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No network in this test");
    },
    decide: async (_binding, _request, decision) => {
      decisions.push(decision);
      setRequests([]);
    },
    revoke: noop,
    forget: noop,
    rename: noop,
  };
  const preferences: Preferences = {
    locale: () => "en",
    language: () => "en",
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    expect(document.querySelector("dialog.k2b-bottom-sheet-frame")).not.toBeNull();
    expect(document.querySelector("dialog output")?.textContent).toBe("123456");
    document.querySelector<HTMLButtonElement>("dialog .k2b-bottom-sheet__handle")!.click();
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(decisions).toEqual([]);
    dom.root.querySelector<HTMLButtonElement>(".auth-request-row button")!.click();
    await Bun.sleep(30);
    const approve = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) =>
      button.textContent?.includes("Approve"),
    )!;
    approve.click();
    await Bun.sleep(30);
    expect(decisions).toEqual(["approve"]);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});
