import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, Login } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

test("a rejected sign-in keeps its grouped code and ends in place with focused Done", async () => {
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
    createdAt: "2026-10-16T12:00:00.000Z",
    expiresAt: "2026-10-16T12:01:00.000Z",
  };
  const decisions: string[] = [];
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: [request], actions: [], moreActions: 0 } }),
    now: () => Date.parse("2026-10-16T12:00:30.000Z"),
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
    action: async () => {
      throw new Error("No action in this test");
    },
    act: noop,
    decide: async (_binding, _request, decision) => {
      decisions.push(decision);
      throw new Error("The response was lost");
    },
    revoke: noop,
    syncPush: noop,
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
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open].k2b-bottom-sheet-frame.is-adaptive")!;
    expect(dialog).not.toBeNull();
    const code = dialog.querySelector("output")!;
    expect([...code.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["123", "456"]);
    expect(code.getAttribute("aria-label")).toBe("123 456");
    expect(code.textContent).toBe("123456");
    const choices = dialog.querySelector<HTMLElement>(".auth-decision-actions__choices")!;
    const approve = [...choices.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Approve"))!;
    approve.click();
    await Bun.sleep(30);
    expect(decisions).toEqual(["approve"]);
    expect(document.querySelector("dialog[open]")).toBe(dialog);
    expect(choices.hasAttribute("inert")).toBe(true);
    expect([...choices.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    const alert = dialog.querySelector('[role="alert"]')!;
    expect(alert.querySelector("h3")?.textContent).toBe("Not confirmed");
    const { authMessages } = await import("./i18n");
    expect(alert.textContent).toContain(authMessages.resolve(["en"]).t.loginUncertain);
    const done = dialog.querySelector<HTMLButtonElement>(".auth-decision-actions__done button")!;
    expect(done.textContent).toBe("Done");
    expect(document.activeElement).toBe(done);
    // Even a stale reference to an old choice cannot submit a second decision.
    approve.click();
    done.click();
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(decisions).toEqual(["approve"]);
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

test("an expired sign-in stays open with its ending and focused Done", async () => {
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
    createdAt: "2026-10-16T12:00:00.000Z",
    expiresAt: "2026-10-16T12:01:00.000Z",
  };
  const decisions: string[] = [];
  const [now, setNow] = createSignal(Date.parse("2026-10-16T12:00:30.000Z"));
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: [request], actions: [], moreActions: 0 } }),
    now,
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
    action: async () => {
      throw new Error("No action in this test");
    },
    act: noop,
    decide: async (_binding, _request, decision) => {
      decisions.push(decision);
      throw new Error("The response was lost");
    },
    revoke: noop,
    syncPush: noop,
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
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open].k2b-bottom-sheet-frame.is-adaptive")!;
    expect(dialog).not.toBeNull();
    setNow(Date.parse("2026-10-16T12:01:00.000Z"));
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBe(dialog);
    const choices = dialog.querySelector<HTMLElement>(".auth-decision-actions__choices")!;
    expect(choices.hasAttribute("inert")).toBe(true);
    const status = dialog.querySelector('[role="status"].auth-action-result')!;
    expect(status.querySelector("h3")?.textContent).toBe("Expired");
    const { authMessages } = await import("./i18n");
    expect(status.textContent).toContain(authMessages.resolve(["en"]).t.requestExpired);
    const done = dialog.querySelector<HTMLButtonElement>(".auth-decision-actions__done button")!;
    expect(document.activeElement).toBe(done);
    done.click();
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(decisions).toEqual([]);
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});
