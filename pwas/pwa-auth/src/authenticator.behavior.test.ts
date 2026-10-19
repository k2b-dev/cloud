import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { appApproval } from "@k2b/cloud/browser/app-approval";
import { createRoot } from "solid-js";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Login } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Vault } from "./vault";

// Records are sealed with a real vault session and parsed with the real schemas. Only IndexedDB is replaced:
// one in-memory table per object store, where a transaction delivers its success events in order.
type FakeRequest = { result: unknown; onsuccess: (() => void) | null };
type FakeStore = {
  get: (id: string) => FakeRequest;
  getAll: () => FakeRequest;
  put: (value: unknown, id: string) => FakeRequest;
  delete: (id: string) => FakeRequest;
};
const tables = new Map<string, Map<string, unknown>>();
/** Runs once before the next write to the bindings store, like another tab acting between a read and a write. */
let otherTab: (() => Promise<unknown>) | undefined;
const session = await appApproval.vault.create();
mock.module("./vault-storage", () => ({
  currentSession: () => session,
  guarded: async (name: string, mode: IDBTransactionMode, run: (store: FakeStore) => FakeRequest) => {
    if (name === "bindings" && mode === "readwrite" && otherTab) {
      const act = otherTab;
      otherTab = undefined;
      await act();
    }
    const table = tables.get(name) ?? new Map<string, unknown>();
    tables.set(name, table);
    const requests: FakeRequest[] = [];
    const request = (result: unknown) => {
      const value: FakeRequest = { result: structuredClone(result), onsuccess: null };
      requests.push(value);
      return value;
    };
    const result = run({
      get: (id) => request(table.get(id)),
      getAll: () => request([...table.values()]),
      put: (value, id) => {
        table.set(id, structuredClone(value));
        return request(id);
      },
      delete: (id) => {
        table.delete(id);
        return request(undefined);
      },
    });
    // Handlers may queue further requests; the array iterator reaches them too.
    for (const value of requests) value.onsuccess?.();
    return result.result;
  },
}));
const { createAuthenticator } = await import("./authenticator");
const { appActionDigest } = await import("../../../packages/cloud/src/contracts/app-approval");
const { bindingId, storage } = await import("./storage");

const issuer = "https://cloud.example.org";
const account = { uid: "vkolb", displayName: "Valentin Kolb", mail: "valentin@example.org" };
const pairedAt = "2026-09-01T10:00:00.000Z";
const operations: string[] = [];
let features: string[] = [];
const inboxCommands: Array<{ operation: string; accept?: string[] }> = [];
let inboxLogins: Login[] = [];
let pendingChange: import("./authenticator").DeviceChange;
const pendingCommands: Array<{ operation: string; accept?: string[] }> = [];
let pendingLogins: Login[] = [];
let actStatus = 200;
let dropAct = false;
const vault: Vault = {
  header: () => undefined,
  status: () => "open",
  unlock: async () => {},
  setup: async () => {},
  reset: async () => {},
  cancelPending: () => {},
  retryAfter: () => 0,
  session: () => session,
};

let dom: DomTestHarness;
let dispose = () => {};
const realFetch = globalThis.fetch;
beforeEach(() => {
  dom = createDomTestHarness();
  tables.clear();
  operations.length = 0;
  otherTab = undefined;
  features = [];
  inboxCommands.length = 0;
  inboxLogins = [];
  pendingChange = deviceChange();
  pendingCommands.length = 0;
  pendingLogins = [];
  actStatus = 200;
  dropAct = false;
  // The Cloud: discovery, then signed device commands. Signatures are the SDK's concern and are not checked here.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/info"))
        return Response.json({
          protocol: "cloud-app-approval-v1",
          issuer,
          api: url.slice(0, -"/info".length),
          appOrigin: location.origin,
          algorithm: "ES256",
          limits: appApproval.limits,
          ...(features.length ? { features } : {}),
        });
      const command: { operation: string; decision?: string; accept?: string[] } = JSON.parse(String(init?.body)).proof.command;
      operations.push(command.operation);
      if (command.operation === "account") return Response.json({ account, device: { name: "iPhone", createdAt: pairedAt } });
      if (command.operation === "inbox") {
        inboxCommands.push(command);
        return Response.json({
          logins: inboxLogins,
          actions: [actionSummary()],
          moreActions: 2,
          pollAfterSeconds: 5,
          ...(command.accept?.includes("device-changes") ? { changes: [pendingChange], moreChanges: 2 } : {}),
        });
      }
      if (command.operation === "pending") {
        pendingCommands.push(command);
        return Response.json({ requests: pendingLogins, pollAfterSeconds: 5 });
      }
      if (command.operation === "action") return Response.json(actionView());
      if (command.operation === "act" || command.operation === "change") {
        if (dropAct) throw new Error("lost response");
        if (actStatus !== 200) return new Response(null, { status: actStatus });
        return Response.json({ state: command.decision === "approve" ? "approved" : "denied" });
      }
      if (command.operation === "decide") return Response.json({ state: command.decision === "approve" ? "approved" : "denied" });
      return Response.json({ requests: [], pollAfterSeconds: 5 });
    },
    { preconnect: realFetch.preconnect },
  );
});
afterEach(() => {
  dispose();
  globalThis.fetch = realFetch;
  dom.cleanup();
});

async function paired() {
  const deviceId = crypto.randomUUID();
  const binding = { id: bindingId(issuer, deviceId), issuer, deviceId, key: await session.createKey(), label: "Cloud", name: "iPhone" };
  // Renamed and push-enabled after pairing: the caller's copy below is older than the saved record.
  await storage.saveBinding({ ...binding, label: "StuVe Cloud", pushToken: "T".repeat(43) });
  const auth = createRoot((stop) => {
    dispose = stop;
    return createAuthenticator(vault);
  });
  return { auth, binding };
}
const saved = async () => (await storage.bindings())[0];
const login = () => ({
  requestId: crypto.randomUUID(),
  challenge: "A".repeat(43),
  comparison: "123456",
  createdAt: "2026-10-19T10:00:00.000Z",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const loginContext: NonNullable<Login["context"]> = {
  level: "warn",
  browser: "edge",
  os: "windows",
  country: "PL",
  city: "Warsaw",
  network: "OVH",
  history: { knownSince: null, newCountry: true, countriesSince: null },
};

test("account details merge into the latest encrypted record without dropping its label or push token", async () => {
  const { auth, binding } = await paired();
  const details = await auth.account(binding);
  expect(details).toMatchObject({ ...account, deviceName: "iPhone", pairedAt });
  expect(operations).toContain("account");
  expect(await saved()).toMatchObject({ label: "StuVe Cloud", pushToken: "T".repeat(43), details });
  // Only the sealed blob reaches storage.
  expect(JSON.stringify([...(tables.get("bindings")?.values() ?? [])])).not.toContain("vkolb");
});

test("an approval records when it happened next to the saved details; a denial does not", async () => {
  const { auth, binding } = await paired();
  const details = await auth.account(binding);
  await auth.decide(binding, login(), "deny");
  expect((await saved())?.approvedAt).toBeUndefined();
  const before = Date.now();
  await auth.decide(binding, login(), "approve");
  const record = await saved();
  expect(operations.filter((operation) => operation === "decide")).toHaveLength(2);
  expect(Date.parse(record?.approvedAt ?? "")).toBeGreaterThanOrEqual(before);
  expect(record).toMatchObject({ label: "StuVe Cloud", pushToken: "T".repeat(43), details });
});

test("a Cloud another tab disconnected or renamed meanwhile is not written back", async () => {
  const { auth, binding } = await paired();
  otherTab = () => storage.removeBinding(binding.id);
  expect((await auth.account(binding)).uid).toBe("vkolb");
  expect(await storage.bindings()).toEqual([]);

  await storage.saveBinding(binding);
  otherTab = async () => {
    const latest = await saved();
    if (latest) await storage.saveBinding({ ...latest, label: "Renamed in another tab" });
  };
  await auth.decide(binding, login(), "approve");
  expect(await saved()).toMatchObject({ label: "Renamed in another tab" });
  expect((await saved())?.approvedAt).toBeUndefined();
});

const actionView = () => ({
  actionId: "11111111-1111-4111-8111-111111111111",
  app: { id: "files", name: "Files" },
  requester: { app: { id: "assistant", name: "Assistant" }, title: "A chat" },
  assurance: "confirm" as const,
  sentence: "Remove the file",
  message: null,
  details: [],
  truncated: false,
  argsDigest: "input",
  digest: "A".repeat(43),
  createdAt: pairedAt,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const actionSummary = () => {
  const { message, details, truncated, argsDigest, digest, ...summary } = actionView();
  return summary;
};

for (const actions of [false, true]) {
  test(`polling uses ${actions ? "inbox" : "pending"} according to discovery`, async () => {
    features = actions ? ["actions"] : [];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(operations).toContain(actions ? "inbox" : "pending");
    expect(operations).not.toContain(actions ? "pending" : "inbox");
    expect(auth.states()[binding.id]).toMatchObject({ requests: [], moreActions: actions ? 2 : 0, moreChanges: 0 });
    expect(auth.states()[binding.id]?.actions).toHaveLength(actions ? 1 : 0);
  });
}

for (const terminal of [false, true]) {
  test(`inbox ${terminal ? "opts in and preserves terminal consent" : "omits accept for an older Cloud and preserves browser sign-ins"}`, async () => {
    features = terminal ? ["actions", "terminal-logins"] : ["actions"];
    const request: Login = {
      ...login(),
      ...(terminal
        ? {
            terminal: {
              client: { id: "cloud-cli", name: "Cloud CLI" },
              scopes: ["openid", "profile", "email", "offline_access", "read", "write"],
              lifetimeSeconds: 28800,
            },
          }
        : {}),
    };
    inboxLogins = [request];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(inboxCommands).toEqual([terminal ? { operation: "inbox", accept: ["terminal-logins"] } : { operation: "inbox" }]);
    expect(auth.states()[binding.id]?.requests).toEqual([request]);
  });
}

for (const context of [false, true]) {
  test(`inbox asks for terminal sign-ins${context ? ", sign-in context" : ""} and device changes together when the Cloud offers them`, async () => {
    features = ["actions", "terminal-logins", ...(context ? ["login-context"] : []), "device-changes"];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(inboxCommands).toEqual([
      { operation: "inbox", accept: ["terminal-logins", ...(context ? ["login-context"] : []), "device-changes"] },
    ]);
    expect(auth.states()[binding.id]?.changes).toEqual([pendingChange]);
    expect(auth.states()[binding.id]?.moreChanges).toBe(2);
  });
}

for (const accepted of [[], ["terminal-logins"], ["login-context"], ["terminal-logins", "login-context"]]) {
  test(`inbox filters opt-ins for Cloud features ${JSON.stringify(["actions", ...accepted])} and preserves logins`, async () => {
    features = ["actions", ...accepted];
    const request: Login = { ...login(), ...(accepted.includes("login-context") ? { context: loginContext } : {}) };
    inboxLogins = [request];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(inboxCommands).toEqual([{ operation: "inbox", ...(accepted.length ? { accept: accepted } : {}) }]);
    expect(auth.states()[binding.id]?.requests).toEqual([request]);
    expect(auth.states()[binding.id]?.error).toBeUndefined();
  });
}

for (const context of [false, true]) {
  test(`pending ${context ? "opts in to login-context and preserves it" : "omits accept for an older Cloud"}`, async () => {
    features = context ? ["login-context"] : [];
    const request: Login = { ...login(), ...(context ? { context: loginContext } : {}) };
    pendingLogins = [request];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(pendingCommands).toEqual([context ? { operation: "pending", accept: ["login-context"] } : { operation: "pending" }]);
    expect(auth.states()[binding.id]?.requests).toEqual([request]);
    expect(auth.states()[binding.id]?.error).toBeUndefined();
  });
}

for (const actions of [false, true]) {
  test(`${actions ? "inbox" : "pending"} accepts missing context from a Cloud offering login-context`, async () => {
    features = actions ? ["actions", "login-context"] : ["login-context"];
    const request = login();
    inboxLogins = [request];
    pendingLogins = [request];
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(actions ? inboxCommands : pendingCommands).toEqual([{ operation: actions ? "inbox" : "pending", accept: ["login-context"] }]);
    expect(auth.states()[binding.id]?.requests).toEqual([request]);
    expect(auth.states()[binding.id]?.error).toBeUndefined();
  });
}

for (const status of [200, 409, 403, 500]) {
  test(`act handles HTTP ${status} and reserves the Action across models before sending`, async () => {
    features = ["actions"];
    actStatus = status;
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(auth.states()[binding.id]?.actions).toHaveLength(1);
    const view = actionView();
    view.digest = await appActionDigest(issuer, view);
    if (status === 200) await auth.act(binding, view, "approve");
    else await expect(auth.act(binding, view, "approve")).rejects.toThrow(status === 409 ? "stale" : "uncertain");
    await expect(auth.act(binding, view, "deny")).rejects.toThrow("uncertain");
    const other = createRoot((stop) => {
      const firstDispose = dispose;
      dispose = () => {
        firstDispose();
        stop();
      };
      return createAuthenticator(vault);
    });
    await expect(other.act(binding, view, "approve")).rejects.toThrow("uncertain");
    expect(operations.filter((operation) => operation === "act")).toHaveLength(1);
    // Applied or no longer offered (409): the row leaves at once. An unknown outcome keeps it.
    expect(auth.states()[binding.id]?.actions).toHaveLength(status === 200 || status === 409 ? 0 : 1);
  });
}

test("a lost Action response stays uncertain and never sends twice", async () => {
  features = ["actions"];
  dropAct = true;
  const { auth, binding } = await paired();
  const view = actionView();
  view.digest = await appActionDigest(issuer, view);
  await expect(auth.act(binding, view, "deny")).rejects.toThrow("uncertain");
  await expect(auth.act(binding, view, "deny")).rejects.toThrow("uncertain");
  expect(operations.filter((operation) => operation === "act")).toHaveLength(1);
});

test("action reads are fresh, digest checked, and belong to the vault session", async () => {
  const { auth, binding } = await paired();
  // The fake Cloud's view has an incorrect digest: the SDK must reject it before the UI sees it.
  await expect(auth.action(binding, actionView().actionId)).rejects.toThrow("INVALID_RESPONSE");
  await expect(auth.action(binding, actionView().actionId)).rejects.toThrow("INVALID_RESPONSE");
  expect(operations.filter((operation) => operation === "action")).toHaveLength(2);
});

test("expired, hidden and offline Actions are refused before sending", async () => {
  const { auth, binding } = await paired();
  await expect(auth.act(binding, { ...actionView(), expiresAt: pairedAt }, "approve")).rejects.toThrow("stale");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await expect(auth.act(binding, actionView(), "approve")).rejects.toThrow("stale");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await expect(auth.act(binding, actionView(), "approve")).rejects.toThrow("stale");
  expect(operations).not.toContain("act");
});

const deviceChange = (): import("./authenticator").DeviceChange => {
  // real clock: the authenticator under test compares expiry with the real clock.
  const now = Date.now();
  return {
    changeId: crypto.randomUUID(),
    kind: "revoke",
    device: { id: crypto.randomUUID(), name: "Old phone" },
    endSessions: true,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
};

for (const status of [200, 409, 403, 500]) {
  test(`device change HTTP ${status} reserves once and drops only a settled or stale request`, async () => {
    features = ["device-changes"];
    actStatus = status;
    const { auth, binding } = await paired();
    for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
    expect(auth.states()[binding.id]?.changes).toEqual([pendingChange]);
    expect(operations).toContain("inbox");
    if (status === 200) await auth.decideChange(binding, pendingChange, "approve");
    else await expect(auth.decideChange(binding, pendingChange, "approve")).rejects.toThrow(status === 409 ? "stale" : "uncertain");
    await expect(auth.decideChange(binding, pendingChange, "deny")).rejects.toThrow("uncertain");
    expect(operations.filter((item) => item === "change")).toHaveLength(1);
    expect(auth.states()[binding.id]?.changes).toHaveLength(status === 200 || status === 409 ? 0 : 1);
  });
}

test("a lost device change response reserves the request across models", async () => {
  features = ["device-changes"];
  dropAct = true;
  const { auth, binding } = await paired();
  await expect(auth.decideChange(binding, pendingChange, "deny")).rejects.toThrow("uncertain");
  const other = createRoot((stop) => {
    const firstDispose = dispose;
    dispose = () => {
      firstDispose();
      stop();
    };
    return createAuthenticator(vault);
  });
  await expect(other.decideChange(binding, pendingChange, "deny")).rejects.toThrow("uncertain");
  expect(operations.filter((item) => item === "change")).toHaveLength(1);
});

test("expired, hidden and offline device changes leave state before any send", async () => {
  features = ["device-changes"];
  const { auth, binding } = await paired();
  for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
  // real clock: the authenticator under test compares expiry with the real clock.
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  await expect(auth.decideChange(binding, { ...pendingChange, expiresAt: expiredAt }, "approve")).rejects.toThrow("stale");
  expect(auth.states()[binding.id]?.changes).toEqual([]);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await expect(auth.decideChange(binding, pendingChange, "approve")).rejects.toThrow("stale");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await expect(auth.decideChange(binding, pendingChange, "approve")).rejects.toThrow("stale");
  expect(operations).not.toContain("change");
});

test("an open sign-in stays open with its offline note when the phone loses its connection", async () => {
  features = ["login-context"];
  pendingLogins = [{ ...login(), context: loginContext }];
  const { auth, binding } = await paired();
  for (let i = 0; i < 100 && !auth.states()[binding.id]; i++) await Bun.sleep(10);
  const { render } = await import("solid-js/web");
  const { createComponent } = await import("solid-js");
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const preferences: Preferences = {
    locale: () => "en",
    language: () => "en",
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const stop = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    for (let i = 0; i < 50 && !document.querySelector("dialog[open]"); i++) await Bun.sleep(10);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(dialog.querySelector(".auth-decision__details[data-context]")).not.toBeNull();
    // The real offline event clears the polled list; that is no answer about the request.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await Bun.sleep(30);
    expect(auth.states()[binding.id]).toBeUndefined();
    expect(document.querySelector("dialog[open]")).toBe(dialog);
    expect(dialog.querySelector(".auth-decision__hint")?.hasAttribute("data-offline")).toBe(true);
    const choices = [...dialog.querySelectorAll<HTMLButtonElement>(".auth-decision-actions__choices button")];
    expect(choices.every((button) => button.disabled)).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBe(dialog);
    expect(dialog.querySelector(".auth-decision__hint")?.hasAttribute("data-offline")).toBe(false);
    expect(choices.every((button) => !button.disabled)).toBe(true);
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    stop();
  }
});
