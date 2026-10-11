import { type AppVaultMethod, type AppVaultSession, appApproval } from "@k2b/cloud/browser/app-approval";
import { localStore } from "@k2b/stdlib/solid";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
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
  const [status, setStatus] = createSignal<"loading" | "empty" | "locked" | "open" | "legacy" | "unsupported" | "error">("loading");
  const channel = new BroadcastChannel("cloud-login-vault");
  let generation = 0;
  let disposed = false;
  let pendingOperation: AbortController | undefined;
  const [retry, setRetry] = localStore.create("pwa-auth.pin-retry", { attempts: 0, retryAt: 0 });
  const attempts = () => (Number.isInteger(retry.attempts) ? Math.max(0, Math.min(6, retry.attempts)) : 0);
  const retryAt = () => (Number.isSafeInteger(retry.retryAt) ? retry.retryAt : 0);
  const [now, setNow] = createSignal(Date.now());
  const retryAfter = createMemo(() => Math.max(0, Math.min(30, Math.ceil((retryAt() - now()) / 1000))));
  const cancelPending = () => {
    generation++;
    pendingOperation?.abort();
    pendingOperation = undefined;
  };
  const invalidate = () => {
    cancelPending();
    lockStorage();
    if (status() === "open") setStatus("loading");
    closeDialogs();
  };
  const refresh = async () => {
    if (disposed) return;
    cancelPending();
    const gen = generation;
    try {
      const h = await readHeader();
      const legacy = !h && (await hasLegacy());
      if (gen !== generation) return;
      if (h?.config.methods[0]?.type === "local" && !h.config.methods.some((method) => method.type === "pin")) {
        const value = await appApproval.vault.unlock(h.config, "local");
        try {
          const latest = await readHeader();
          if (gen !== generation || latest?.revision !== h.revision) return;
          activate(value, h);
        } finally {
          if (status() !== "open" || header() !== h) value.lock();
        }
        return;
      }
      setHeader(h);
      setStatus(h ? (h.config.methods.some((method) => method.type === "pin") ? "locked" : "unsupported") : legacy ? "legacy" : "empty");
    } catch {
      if (gen === generation) setStatus("error");
    }
  };
  const guard = (gen: number) => {
    if (generation !== gen || document.visibilityState !== "visible") throw new Error("locked");
  };
  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>, dispose?: (value: T) => void) => {
    const gen = generation;
    if (pendingOperation || document.visibilityState !== "visible") throw new Error("locked");
    const abort = new AbortController();
    pendingOperation = abort;
    try {
      const value = await operation(abort.signal);
      try {
        guard(gen);
      } catch (error) {
        dispose?.(value);
        throw error;
      }
      return value;
    } finally {
      if (pendingOperation === abort) pendingOperation = undefined;
    }
  };
  const verify = async (pin: string) => {
    if (Date.now() < retryAt()) throw new Error("locked");
    const expected = header();
    if (status() !== "locked" || !expected?.config.methods.some((method) => method.type === "pin")) throw new Error("locked");
    return run(
      async (signal) => {
        let value: AppVaultSession;
        try {
          value = await appApproval.vault.unlock(expected.config, "pin", pin, signal);
        } catch (error) {
          if (!signal.aborted) {
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
  };
  const unlock = async (pin: string) => {
    const gen = generation;
    const value = await verify(pin);
    const h = header();
    if (!h || gen !== generation || document.visibilityState !== "visible") {
      value.lock();
      throw new Error("locked");
    }
    try {
      const method = value.local();
      const checked = await run(
        (signal) => appApproval.vault.unlock({ version: 1, id: value.id, methods: [method] }, "local", undefined, signal),
        (session) => session.lock(),
      );
      checked.lock();
      guard(gen);
      await save(value, [method], h.revision);
    } catch (error) {
      value.lock();
      throw error;
    }
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
  const setup = async () => {
    if (status() !== "empty") throw new Error("locked");
    const gen = generation;
    const value = await appApproval.vault.create();
    try {
      guard(gen);
      const method = value.local();
      const config = { version: 1 as const, id: value.id, methods: [method] };
      const checked = await run(
        (signal) => appApproval.vault.unlock(config, "local", undefined, signal),
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
    const visibility = () => {
      if (document.visibilityState !== "visible") cancelPending();
      else if (status() === "loading" || (status() === "locked" && header()?.config.methods[0]?.type === "local")) void refresh();
    };
    const hide = () => cancelPending();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    channel.onmessage = () => {
      invalidate();
      void refresh();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    onCleanup(() => {
      disposed = true;
      invalidate();
      clearInterval(timer);
      channel.close();
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
    });
  });
  return {
    header,
    status,
    unlock,
    setup,
    reset,
    cancelPending,
    retryAfter,
    session: currentSession,
  };
}
export type Vault = ReturnType<typeof createVault>;
