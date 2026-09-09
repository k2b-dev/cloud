import { AppApprovalClientError, appApproval } from "@valentinkolb/cloud/browser/app-approval";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { type Binding, storage } from "./storage";

export type Client = Awaited<ReturnType<typeof appApproval.connect>>;
export type Login = Awaited<ReturnType<Client["pending"]>>["requests"][number];
export type PairingPayload = ReturnType<typeof appApproval.parsePairingLink>;
export type Failure = "unavailable" | "forbidden" | "stale" | "storage" | "uncertain";
export function failure(error: unknown): Failure {
  if (error instanceof Error && error.message === "storage") return "storage";
  if (error instanceof AppApprovalClientError) {
    if (error.status === 403 || error.status === 401) return "forbidden";
    if ([400, 404, 409].includes(error.status ?? 0) || error.code === "INVALID_INPUT") return "stale";
  }
  return "unavailable";
}
export function consumePairingLocation() {
  if (!location.hash) return undefined;
  const link = location.href;
  history.replaceState(null, "", location.pathname);
  return link;
}
export function createAuthenticator(vault: import("./vault").Vault) {
  const [bindings, setBindings] = createSignal<Binding[]>([]);
  const [states, setStates] = createSignal<Record<string, { requests: Login[]; error?: Failure }>>({});
  const [storageError, setStorageError] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [online, setOnline] = createSignal(navigator.onLine);
  const clients = new Map<string, Client>();
  const active = new Map<string, AbortController>();
  const mutations = new Set<AbortController>();
  const backoff = new Map<string, number>();
  const channel = new BroadcastChannel("cloud-login-bindings");
  const reload = async () => {
    if (vault.status() !== "open") return;
    const owner = vault.session();
    try {
      const values = await storage.bindings();
      owner.check();
      if (vault.status() !== "open") return;
      setBindings(values);
      setStorageError(false);
    } catch {
      setBindings([]);
      setStates({});
      setStorageError(true);
    }
  };
  const changed = async () => {
    await reload();
    channel.postMessage("changed");
  };
  const client = async (issuer: string, signal?: AbortSignal) => {
    const cached = clients.get(issuer);
    if (cached) return cached;
    const value = await appApproval.connect({ issuer, authenticatorOrigin: location.origin, signal });
    clients.set(issuer, value);
    return value;
  };
  const poll = async (binding: Binding) => {
    if (active.has(binding.id) || vault.status() !== "open") return;
    const abort = new AbortController();
    active.set(binding.id, abort);
    const pollId = `poll:${binding.id}`;
    try {
      // Reserve the server polling interval; an interrupted tab must not stall all tabs for a proof lifetime.
      if (!(await storage.reserve(pollId, Date.now() + appApproval.limits.pollSeconds * 1000))) return;
      abort.signal.throwIfAborted();
      const result = await (await client(binding.issuer, abort.signal)).pending(binding, abort.signal);
      abort.signal.throwIfAborted();
      vault.session().check();
      setStates((s) => ({ ...s, [binding.id]: { requests: result.requests } }));
      channel.postMessage({ type: "pending", id: binding.id, requests: result.requests });
      backoff.delete(binding.id);
      await storage.defer(pollId, Date.now() + Math.max(appApproval.limits.pollSeconds, result.pollAfterSeconds) * 1000);
    } catch (error) {
      if (!abort.signal.aborted) {
        const delay = Math.min(appApproval.limits.proofSeconds, (backoff.get(binding.id) ?? appApproval.limits.pollSeconds) * 2);
        backoff.set(binding.id, delay);
        setStates((s) => ({ ...s, [binding.id]: { requests: [], error: failure(error) } }));
        await storage.defer(pollId, Date.now() + delay * 1000).catch(() => setStorageError(true));
      } else {
        await storage.defer(pollId, Date.now() + appApproval.limits.pollSeconds * 1000).catch(() => {});
      }
    } finally {
      if (active.get(binding.id) === abort) active.delete(binding.id);
    }
  };
  let cleanupAfter = Date.now() + appApproval.limits.loginSeconds * 1000;
  const tick = () => {
    setNow(Date.now());
    if (vault.status() !== "open" || document.visibilityState !== "visible" || !navigator.onLine || storageError()) return;
    if (Date.now() >= cleanupAfter) {
      cleanupAfter = Date.now() + appApproval.limits.loginSeconds * 1000;
      void storage.prune().catch(() => setStorageError(true));
    }
    for (const binding of bindings()) {
      if (states()[binding.id]?.error !== "forbidden") void poll(binding);
    }
  };
  const visibility = () => {
    setOnline(navigator.onLine);
    if (document.visibilityState !== "visible" || !navigator.onLine) {
      for (const abort of active.values()) abort.abort();
      for (const abort of mutations) abort.abort();
      setStates({});
    } else {
      void reload().then(tick);
    }
  };
  onMount(() => {
    void reload().then(tick);
    const timer = setInterval(tick, 1000);
    channel.onmessage = (event: MessageEvent<{ type: "pending"; id: string; requests: Login[] }>) => {
      if (vault.status() === "open" && event.data?.type === "pending" && bindings().some((b) => b.id === event.data.id)) {
        setStates((s) => ({ ...s, [event.data.id]: { requests: event.data.requests } }));
      } else {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", visibility);
    onCleanup(() => {
      clearInterval(timer);
      for (const abort of active.values()) abort.abort();
      for (const abort of mutations) abort.abort();
      channel.close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", visibility);
    });
  });
  createEffect(() => {
    if (vault.status() !== "open") {
      for (const abort of active.values()) abort.abort();
      for (const abort of mutations) abort.abort();
      setBindings([]);
      setStates({});
      clients.clear();
    } else void reload().then(tick);
  });
  const decide = async (binding: Binding, request: Login, decision: "approve" | "deny") => {
    vault.session().check();
    if (!navigator.onLine || document.visibilityState !== "visible" || Date.parse(request.expiresAt) <= Date.now())
      throw new Error("stale");
    const owner = vault.session();
    const api = await client(binding.issuer);
    owner.check();
    // Persist before sending: a lost response or another tab must not silently send again.
    if (!(await storage.reserve(`decision:${binding.id}:${request.requestId}`, Date.parse(request.expiresAt))))
      throw new Error("uncertain");
    const abort = new AbortController();
    mutations.add(abort);
    try {
      owner.check();
      await api.decide(binding, request, decision, abort.signal);
      owner.check();
    } catch {
      throw new Error("uncertain");
    } finally {
      mutations.delete(abort);
    }
    setStates((s) => ({
      ...s,
      [binding.id]: { requests: (s[binding.id]?.requests ?? []).filter((r) => r.requestId !== request.requestId) },
    }));
    channel.postMessage("changed");
  };
  const revoke = async (binding: Binding) => {
    const owner = vault.session();
    const api = await client(binding.issuer);
    owner.check();
    // A failed revoke must be inspected in Cloud device management, not automatically retried.
    if (!(await storage.reserve(`revoke:${binding.id}`, Number.MAX_SAFE_INTEGER))) throw new Error("uncertain");
    const abort = new AbortController();
    mutations.add(abort);
    try {
      owner.check();
      await api.revoke(binding, abort.signal);
      owner.check();
    } catch {
      throw new Error("uncertain");
    } finally {
      mutations.delete(abort);
    }
    await storage.removeBinding(binding.id);
    await changed();
  };
  return {
    bindings,
    states,
    storageError,
    now,
    online,
    changed,
    client,
    decide,
    revoke,
    rename: async (binding: Binding, label: string) => {
      const latest = (await storage.bindings()).find((b) => b.id === binding.id);
      if (!latest || !label.trim() || label.length > 80) throw new Error("storage");
      await storage.saveBinding({ ...latest, label: label.trim() });
      await changed();
    },
    forget: async (binding: Binding) => {
      await storage.removeBinding(binding.id);
      await changed();
    },
  };
}
export type Authenticator = ReturnType<typeof createAuthenticator>;
