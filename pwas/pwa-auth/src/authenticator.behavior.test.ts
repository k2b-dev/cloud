import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { appApproval } from "@k2b/cloud/browser/app-approval";
import { createRoot } from "solid-js";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
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
const { bindingId, storage } = await import("./storage");

const issuer = "https://cloud.example.org";
const account = { uid: "vkolb", displayName: "Valentin Kolb", mail: "valentin@example.org" };
const pairedAt = "2026-09-01T10:00:00.000Z";
const operations: string[] = [];
const vault: Vault = {
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
        });
      const command: { operation: string; decision?: string } = JSON.parse(String(init?.body)).proof.command;
      operations.push(command.operation);
      if (command.operation === "account") return Response.json({ account, device: { name: "iPhone", createdAt: pairedAt } });
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
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

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
