import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { type AppVaultSession, appApproval } from "@k2b/cloud/browser/app-approval";
import { createRoot } from "solid-js";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { VaultHeader } from "./vault-storage";

let header: VaultHeader | undefined;
let session: AppVaultSession | undefined;
let failSave = false;
mock.module("./vault-storage", () => ({
  readHeader: async () => header,
  readRevision: async () => header?.revision,
  hasLegacy: async () => false,
  saveHeader: async (value: VaultHeader | undefined, expected?: string) => {
    if (failSave || header?.revision !== expected) throw new Error("storage");
    header = value;
  },
  currentSession: () => {
    if (!session) throw new Error("locked");
    session.check();
    return session;
  },
  lockStorage: () => {
    session?.lock();
    session = undefined;
  },
  unlockStorage: (value: AppVaultSession) => {
    session?.lock();
    session = value;
  },
}));
let dom: DomTestHarness;
let dispose = () => {};
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  header = undefined;
  session = undefined;
  failSave = false;
});
afterEach(() => {
  dispose();
  dom.cleanup();
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const start = async () => {
  const { createVault } = await import("./vault");
  const vault = createRoot((stop) => {
    dispose = stop;
    return createVault();
  });
  await Bun.sleep(20);
  return vault;
};
const seed = async (passkey = false) => {
  const original = await appApproval.vault.create();
  const pin = await original.pin("012345");
  if (pin.type !== "pin") throw new Error("Expected PIN method");
  header = {
    revision: crypto.randomUUID(),
    config: appApproval.vault.parseConfig({
      version: 1,
      id: original.id,
      methods: [
        pin,
        ...(passkey
          ? [
              {
                type: "passkey",
                credentialId: "legacy",
                salt: btoa("S".repeat(32)),
                wrapped: pin.wrapped,
              },
            ]
          : []),
      ],
    }),
  };
  const blob = await original.sealRecord({ label: "Kept Cloud", key: await original.createKey() }, "binding");
  original.lock();
  return blob;
};

for (const passkey of [false, true]) {
  test(`PIN migration preserves encrypted records and reopens locally (${passkey ? "PIN and passkey" : "PIN only"})`, async () => {
    const blob = await seed(passkey);
    const vault = await start();
    expect(vault.status()).toBe("locked");
    await vault.unlock("012345");
    expect(vault.status()).toBe("open");
    expect(header?.config.methods.map((method) => method.type)).toEqual(["local"]);
    const read = (value: unknown) => {
      if (!value || typeof value !== "object" || !("label" in value)) throw new Error("invalid");
      return value.label;
    };
    expect(await vault.session().openRecord(blob, "binding", read)).toBe("Kept Cloud");
    dispose();
    const reopened = await start();
    expect(reopened.status()).toBe("open");
    expect(await reopened.session().openRecord(blob, "binding", read)).toBe("Kept Cloud");
  });
}

test("a wrong PIN retains the legacy header and retry delay before migration", async () => {
  await seed();
  const before = header;
  const vault = await start();
  await expect(vault.unlock("111111")).rejects.toThrow();
  expect(vault.status()).toBe("locked");
  expect(header).toBe(before);
  expect(vault.retryAfter()).toBeGreaterThan(0);
  await expect(vault.unlock("012345")).rejects.toThrow("locked");
  await Bun.sleep(1100);
  await vault.unlock("012345");
  expect(vault.status()).toBe("open");
});

test("failed atomic migration leaves the old PIN usable", async () => {
  await seed();
  const before = header;
  const vault = await start();
  failSave = true;
  await expect(vault.unlock("012345")).rejects.toThrow("storage");
  expect(header).toBe(before);
  expect(vault.status()).toBe("locked");
  failSave = false;
  await vault.unlock("012345");
  expect(vault.status()).toBe("open");
});

test("new vaults are local and stay open across background and inactivity", async () => {
  const vault = await start();
  await vault.setup();
  expect(header?.config.methods.map((method) => method.type)).toEqual(["local"]);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pagehide"));
  expect(vault.status()).toBe("open");
  vault.session().check();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vault.status()).toBe("open");
});

test("passkey-only installs remain unsupported and can explicitly reset", async () => {
  await seed(true);
  if (!header) throw new Error("missing seed");
  header = { ...header, config: { ...header.config, methods: header.config.methods.filter((method) => method.type === "passkey") } };
  const vault = await start();
  expect(vault.status()).toBe("unsupported");
  await vault.reset();
  expect(header).toBeUndefined();
  expect(vault.status()).toBe("empty");
});

test("cancelled PIN verification cannot migrate or reopen the vault", async () => {
  await seed();
  const before = header;
  const vault = await start();
  const unlocking = vault.unlock("012345");
  vault.cancelPending();
  await expect(unlocking).rejects.toThrow();
  expect(header).toBe(before);
  expect(vault.status()).toBe("locked");
});

test("a cross-tab change invalidates the old session and refreshes a local vault", async () => {
  const vault = await start();
  await vault.setup();
  const previous = vault.session();
  if (!header) throw new Error("missing header");
  header = { ...header, revision: crypto.randomUUID() };
  const other = new BroadcastChannel("cloud-login-vault");
  try {
    other.postMessage("changed");
    for (let i = 0; i < 100 && vault.header()?.revision !== header.revision; i++) await Bun.sleep(10);
    expect(() => previous.check()).toThrow();
    expect(vault.status()).toBe("open");
    expect(vault.session()).not.toBe(previous);
    vault.session().check();
  } finally {
    other.close();
  }
});
