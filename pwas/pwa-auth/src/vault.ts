import { localStore } from "@k2b/stdlib/solid";
import { type AppVaultMethod, type AppVaultSession, appApproval } from "@valentinkolb/cloud/browser/app-approval";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { waitForVaultVisibility } from "./vault-visibility";
import { closeDialogs } from "./dialog";
import {
  currentSession,
  hasLegacy,
  lockStorage,
  readHeader,
  readRevision,
  saveHeader,
  unlockStorage,
  type VaultHeader,
} from "./vault-storage";

export function createVault() {
  const [header, setHeader] = createSignal<VaultHeader>();
  const [status, setStatus] = createSignal<"loading" | "empty" | "locked" | "open" | "legacy" | "error">("loading");
  const [capability, setCapability] = createSignal<"supported" | "unknown" | "unsupported">("unknown");
  const channel = new BroadcastChannel("cloud-login-vault");
  let generation = 0;
  let ceremony: AbortController | undefined;
  let lastActivity = Date.now();
  let hiddenAt: number | undefined;
  const [retry, setRetry] = localStore.create("pwa-auth.pin-retry", { attempts: 0, retryAt: 0 });
  const attempts = () => (Number.isInteger(retry.attempts) ? Math.max(0, Math.min(6, retry.attempts)) : 0);
  const retryAt = () => (Number.isSafeInteger(retry.retryAt) ? retry.retryAt : 0);
  const [now, setNow] = createSignal(Date.now());
  const retryAfter = createMemo(() => Math.max(0, Math.min(30, Math.ceil((retryAt() - now()) / 1000))));
  const cancelPending = () => {
    generation++;
    ceremony?.abort();
    ceremony = undefined;
  };
  const lock = (broadcast = true) => {
    cancelPending();
    hiddenAt = undefined;
    lockStorage();
    if (status() === "open") setStatus("locked");
    closeDialogs();
    if (broadcast) channel.postMessage("lock");
  };
  const refresh = async () => {
    const gen = generation;
    try {
      const h = await readHeader();
      const legacy = !h && (await hasLegacy());
      if (gen !== generation) return;
      setHeader(h);
      setStatus(h ? "locked" : legacy ? "legacy" : "empty");
    } catch {
      if (gen === generation) setStatus("error");
    }
  };
  const guard = (gen: number) => {
    if (generation !== gen || document.visibilityState !== "visible") throw new Error("locked");
  };
  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>, dispose?: (value: T) => void) => {
    const gen = generation;
    if (ceremony || document.visibilityState !== "visible") throw new Error("locked");
    const abort = new AbortController();
    ceremony = abort;
    try {
      const value = await operation(abort.signal);
      try {
        await waitForVaultVisibility(abort.signal);
        guard(gen);
      } catch (error) {
        dispose?.(value);
        throw error;
      }
      return value;
    } finally {
      if (ceremony === abort) ceremony = undefined;
    }
  };
  const verify = async (type: "pin" | "passkey", pin?: string) => {
    if (type === "pin" && Date.now() < retryAt()) throw new Error("locked");
    const expected = header();
    if (!expected) throw new Error("locked");
    if (status() === "open") {
      lockStorage();
      setStatus("locked");
    }
    return run(
      async (signal) => {
        let value: AppVaultSession;
        try {
          value = await appApproval.vault.unlock(expected.config, type, pin, signal);
        } catch (error) {
          if (type === "pin" && !signal.aborted) {
            const time = Date.now();
            setNow(time);
            setRetry({ attempts: Math.min(6, attempts() + 1), retryAt: time + Math.min(30, 2 ** attempts()) * 1000 });
          }
          throw error;
        }
        try {
          if ((await readHeader())?.revision !== expected.revision || signal.aborted) throw new Error("locked");
          setRetry({ attempts: 0, retryAt: 0 });
          return value;
        } catch (e) {
          value.lock();
          throw e;
        }
      },
      (value) => value.lock(),
    );
  };
  const activate = (value: AppVaultSession, h: VaultHeader) => {
    unlockStorage(value, h);
    setHeader(h);
    setStatus("open");
    lastActivity = Date.now();
  };
  const unlock = async (type: "pin" | "passkey", pin?: string) => {
    const gen = generation;
    const value = await verify(type, pin);
    const h = header();
    if (!h || gen !== generation || document.visibilityState !== "visible") {
      value.lock();
      throw new Error("locked");
    }
    activate(value, h);
  };
  const save = async (value: AppVaultSession, methods: AppVaultMethod[], expected?: string) => {
    const gen = generation;
    const h: VaultHeader = { revision: crypto.randomUUID(), config: appApproval.vault.parseConfig({ version: 1, id: value.id, methods }) };
    guard(gen);
    value.check();
    await saveHeader(h, expected);
    if (generation !== gen || document.visibilityState !== "visible") {
      value.lock();
      lockStorage();
      setHeader(h);
      setStatus("locked");
      channel.postMessage("changed");
      throw new Error("locked");
    }
    guard(gen);
    activate(value, h);
    channel.postMessage("changed");
  };
  const setup = async (type: "pin" | "passkey", pin?: string) => {
    if (status() !== "empty") throw new Error("locked");
    const gen = generation;
    const value = await appApproval.vault.create();
    try {
      guard(gen);
      const method = await run((signal) => (type === "pin" ? value.pin(pin ?? "") : value.passkey(signal)));
      const config = { version: 1 as const, id: value.id, methods: [method] };
      const checked = await run(
        (signal) => appApproval.vault.unlock(config, type, pin, signal),
        (value) => value.lock(),
      );
      checked.lock();
      guard(gen);
      await save(value, [method]);
    } catch (e) {
      value.lock();
      throw e;
    }
  };
  const change = async (proof: AppVaultSession, action: "pin" | "passkey" | "remove-pin" | "remove-passkey", pin?: string) => {
    const gen = generation;
    const h = header();
    if (!h || proof.id !== h.config.id) throw new Error("locked");
    try {
      let methods = h.config.methods;
      if (action === "pin" || action === "passkey") {
        const method = await run((signal) => (action === "pin" ? proof.pin(pin ?? "") : proof.passkey(signal)));
        const checked = await run(
          (signal) => appApproval.vault.unlock({ ...h.config, methods: [method] }, action, pin, signal),
          (value) => value.lock(),
        );
        checked.lock();
        methods = [...methods.filter((m) => m.type !== action), method];
      } else methods = methods.filter((m) => m.type !== action.slice(7));
      guard(gen);
      await save(proof, methods, h.revision);
    } catch (e) {
      proof.lock();
      throw e;
    }
  };
  const reset = async () => {
    const expected = await readRevision();
    cancelPending();
    lockStorage();
    if (status() === "open") setStatus("locked");
    await saveHeader(undefined, expected, true);
    setRetry({ attempts: 0, retryAt: 0 });
    channel.postMessage("changed");
    await refresh();
  };
  onMount(() => {
    void refresh();
    void appApproval.vault.capability().then(setCapability);
    const activity = () => {
      if (Date.now() - lastActivity > 300_000 && status() === "open") lock();
      else lastActivity = Date.now();
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        if (status() === "open") {
          hiddenAt ??= Date.now();
          cancelPending();
        } else if (!ceremony) lock(false);
      } else {
        if (hiddenAt !== undefined && Date.now() - hiddenAt >= 60_000) lock(false);
        hiddenAt = undefined;
      }
    };
    const hide = () => lock(false);
    const timer = setInterval(() => {
      setNow(Date.now());
      if (status() === "open" && hiddenAt !== undefined && Date.now() - hiddenAt >= 60_000) lock(false);
      if (status() === "open" && Date.now() - lastActivity >= 300_000) lock();
    }, 1000);
    channel.onmessage = () => {
      lock(false);
      void refresh();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerdown", activity);
    document.addEventListener("keydown", activity);
    onCleanup(() => {
      lock(false);
      clearInterval(timer);
      channel.close();
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", activity);
      document.removeEventListener("keydown", activity);
    });
  });
  return { header, status, capability, lock, unlock, setup, verify, change, reset, cancelPending, retryAfter, session: currentSession };
}
export type Vault = ReturnType<typeof createVault>;
