import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, DeviceChange, InboxState } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

const preferences: Preferences = {
  locale: () => "en",
  language: () => "en",
  theme: () => "light",
  setLanguage: () => {},
  setTheme: () => {},
};
const pairing: DeviceChange = {
  changeId: "00000000-0000-4000-8000-000000000101",
  kind: "pair",
  device: { id: "00000000-0000-4000-8000-000000000102", name: "Jonas' iPad" },
  endSessions: false,
  createdAt: "2026-10-16T12:00:00.000Z",
  expiresAt: "2026-10-16T12:05:00.000Z",
};
const binding = async (): Promise<Binding> => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    id: "fixture",
    label: "Test Cloud",
    name: "Test",
    issuer: "http://localhost",
    deviceId: "00000000-0000-4000-8000-000000000001",
    key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
  };
};
const authenticator = (input: {
  binding: Binding;
  states: () => Record<string, InboxState>;
  online?: () => boolean;
  decideChange: Authenticator["decideChange"];
}): Authenticator => {
  const noop = async () => {};
  const offline = async () => {
    throw new Error("No network in this test");
  };
  return {
    bindings: () => [input.binding],
    states: input.states,
    now: () => Date.parse("2026-10-16T12:01:00.000Z"),
    online: input.online ?? (() => true),
    storageError: () => false,
    changed: noop,
    client: offline,
    stored: async () => undefined,
    account: offline,
    action: offline,
    act: noop,
    decide: noop,
    decideChange: input.decideChange,
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
};
const sheet = () => document.querySelector<HTMLDialogElement>("dialog[open].k2b-bottom-sheet-frame.is-adaptive");
const choice = (dialog: HTMLElement, label: string) =>
  [...dialog.querySelectorAll<HTMLButtonElement>(".auth-decision-actions__choices button")].find((button) =>
    button.textContent?.includes(label),
  )!;

test("a pairing request names the new device, waits before it can decide, and ends in place with focused Done", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const decisions: string[] = [];
  const auth = authenticator({
    binding: await binding(),
    states: () => ({ fixture: { requests: [], actions: [], moreChanges: 0, moreActions: 0, changes: [pairing] } }),
    decideChange: async (_binding, change, decision) => {
      decisions.push(`${change.changeId}:${decision}`);
    },
  });
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    // The card lists the request too, so it can be reopened after the sheet was dismissed.
    expect(dom.root.textContent).toContain("Pair a device · Jonas' iPad");
    const dialog = sheet()!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("wants to pair a new device");
    expect(dialog.querySelector(".auth-change-device strong")?.textContent).toBe("Jonas' iPad");
    expect(dialog.querySelector(".auth-change-device")?.textContent).toContain("New device");
    expect(dialog.textContent).toContain("Approve only if you are pairing it yourself right now.");
    // A tap that arrives with the sheet never decides.
    choice(dialog, "Pair device").click();
    await Bun.sleep(30);
    expect(decisions).toEqual([]);
    await Bun.sleep(520);
    choice(dialog, "Pair device").click();
    await Bun.sleep(30);
    expect(decisions).toEqual([`${pairing.changeId}:approve`]);
    expect(sheet()).toBe(dialog);
    const result = dialog.querySelector('.auth-action-result[role="status"]:not(.auth-decision__sizer)')!;
    expect(result.querySelector("h3")?.textContent).toBe("Device paired");
    expect(result.textContent).toContain("“Jonas' iPad” can now approve sign-ins.");
    expect(dialog.querySelector(".auth-decision__request")?.getAttribute("aria-hidden")).toBe("true");
    const done = dialog.querySelector<HTMLButtonElement>(".auth-decision-actions__done button")!;
    expect(document.activeElement).toBe(done);
    done.click();
    await Bun.sleep(30);
    expect(sheet()).toBeNull();
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

test("removing this device says so, offers Not now instead of Deny, and offline keeps the place and disables Remove", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const { authMessages } = await import("./i18n");
  const t = authMessages.resolve(["en"]).t;
  const self = await binding();
  const removal: DeviceChange = {
    ...pairing,
    changeId: "00000000-0000-4000-8000-000000000201",
    kind: "revoke",
    device: { id: self.deviceId, name: "" },
    endSessions: true,
  };
  const [online, setOnline] = createSignal(true);
  const decisions: string[] = [];
  const auth = authenticator({
    binding: self,
    online,
    states: () => ({ fixture: { requests: [], actions: [], moreChanges: 0, moreActions: 0, changes: [removal] } }),
    decideChange: async (_binding, _change, decision) => {
      decisions.push(decision);
      throw new Error("stale");
    },
  });
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    const dialog = sheet()!;
    expect(dialog.querySelector(".auth-change-device strong")?.textContent).toBe(t.changeUnnamed);
    expect(dialog.querySelector(".auth-change-device")?.textContent).toContain(t.thisDevice);
    const note = dialog.querySelector<HTMLElement>(".auth-change-note")!;
    expect(note.textContent).toContain(t.changeRevokeSelfEndEffect);
    // Cloud refuses a device's denial of its own removal; the device can only leave the request open.
    expect(choice(dialog, "Deny")).toBeUndefined();
    // The offline reason is always part of the cell, so it never changes the sheet's height.
    expect(note.querySelector(".auth-change-note__sizer")?.textContent).toBe(t.changeOffline);
    await Bun.sleep(520);
    setOnline(false);
    await Bun.sleep(10);
    expect(note.hasAttribute("data-offline")).toBe(true);
    expect(note.querySelector('[role="status"]')?.textContent).toBe(t.changeOffline);
    expect(choice(dialog, t.changeNotNow).disabled).toBe(false);
    expect(choice(dialog, "Remove device").disabled).toBe(true);
    choice(dialog, "Remove device").click();
    await Bun.sleep(10);
    expect(decisions).toEqual([]);
    setOnline(true);
    await Bun.sleep(10);
    choice(dialog, "Remove device").click();
    await Bun.sleep(30);
    expect(decisions).toEqual(["approve"]);
    expect(choice(dialog, t.changeNotNow).disabled).toBe(true);
    const result = dialog.querySelector('.auth-action-result[role="status"]:not(.auth-decision__sizer)')!;
    expect(result.querySelector("h3")?.textContent).toBe(t.actionNotApplied);
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

test("Not now on this device's removal closes the sheet without a decision and keeps the request on the card", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const { authMessages } = await import("./i18n");
  const t = authMessages.resolve(["en"]).t;
  const self = await binding();
  const removal: DeviceChange = {
    ...pairing,
    changeId: "00000000-0000-4000-8000-000000000301",
    kind: "revoke",
    device: { id: self.deviceId, name: "Phone" },
    endSessions: false,
  };
  const decisions: string[] = [];
  const auth = authenticator({
    binding: self,
    states: () => ({ fixture: { requests: [], actions: [], moreChanges: 0, moreActions: 0, changes: [removal] } }),
    decideChange: async (_binding, _change, decision) => {
      decisions.push(decision);
    },
  });
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    const dialog = sheet()!;
    expect(dialog.querySelector(".auth-change-note")?.textContent).toContain(t.changeRevokeSelfEffect);
    await Bun.sleep(520);
    choice(dialog, t.changeNotNow).click();
    await Bun.sleep(400);
    expect(sheet()).toBeNull();
    expect(decisions).toEqual([]);
    expect(dom.root.textContent).toContain("Remove a device · Phone");
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

test("an omitted change keeps its sheet open until a complete inbox no longer lists it", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const [changes, setChanges] = createSignal<DeviceChange[]>([pairing]);
  const [inbox, setInbox] = createSignal(true);
  const [moreChanges, setMoreChanges] = createSignal(0);
  const auth = authenticator({
    binding: await binding(),
    states: (): Record<string, InboxState> =>
      inbox() ? { fixture: { requests: [], actions: [], moreChanges: moreChanges(), moreActions: 0, changes: changes() } } : {},
    decideChange: async () => {},
  });
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    expect(sheet()).not.toBeNull();
    // Offline, the inbox is empty without a read: the sheet stays.
    setInbox(false);
    await Bun.sleep(30);
    expect(sheet()).not.toBeNull();
    setInbox(true);
    setMoreChanges(1);
    setChanges([]);
    await Bun.sleep(30);
    expect(sheet()).not.toBeNull();
    setMoreChanges(0);
    await Bun.sleep(30);
    expect(sheet()).toBeNull();
    expect(dom.root.textContent).toContain("You're all set.");
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});
