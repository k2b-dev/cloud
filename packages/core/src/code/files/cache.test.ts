import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CODE_FILE_LIMITS } from "@k2b/cloud/code";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { createGeneratedFileCache, REFUND_FILE } from "./cache";
import { testIdentity } from "./test-identity";

const NOW = new Date("2026-11-11T10:00:00.000Z");
afterEach(() => setSystemTime());
function fixture() {
  setSystemTime(NOW);
  const identity = testIdentity("generated-owner");
  const context: CapabilityExecutionContext = {
    ...identity,
    locale: "en",
    requestId: "request-one",
    origin: "app",
    signal: new AbortController().signal,
  };
  const entries = new Map<string, string>();
  const calls: { command: string; args: string[] }[] = [];
  const sealed = new Map<string, unknown>();
  let admission = 1;
  const store = createGeneratedFileCache({
    send: async (command, args) => {
      calls.push({ command, args });
      if (command === "EVAL") return admission;
      if (command === "SET") {
        entries.set(args[0]!, args[1]!);
        return "OK";
      }
      if (command === "GETDEL") {
        const value = entries.get(args[0]!);
        entries.delete(args[0]!);
        return value ?? null;
      }
      return 0;
    },
    seal: async (value) => {
      const id = `sealed-${sealed.size}`;
      sealed.set(id, value);
      return id;
    },
    unseal: async (id) => sealed.get(id),
  });
  return {
    context,
    store,
    calls,
    refuse: () => {
      admission = 0;
    },
  };
}
test("generated files reserve existing budgets, cache encrypted content with expiry and redeem once", async () => {
  const f = fixture();
  const reservation = await f.store.reserve(f.context);
  const ref = await f.store.put(new Uint8Array([1, 2, 3]), "report.pdf", "application/pdf", f.context, reservation);
  expect(f.calls[0]!.args.slice(3)).toEqual([
    String(CODE_FILE_LIMITS.files),
    String(CODE_FILE_LIMITS.fileBytes),
    String(CODE_FILE_LIMITS.totalBytes),
    "600",
  ]);
  expect(f.calls.find((call) => call.command === "SET")?.args.slice(1)).toEqual(["sealed-1", "EX", "600"]);
  expect(f.calls.find((call) => call.command === "EVAL" && call.args[0] === REFUND_FILE)?.args).toEqual([
    REFUND_FILE,
    "1",
    reservation,
    String(3 - CODE_FILE_LIMITS.fileBytes),
  ]);
  const result = await f.store.read(ref, f.context);
  expect(result.status).toBe(200);
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect((await f.store.read(ref, f.context)).status).toBe(410);
});
test("another person and an expired generated reference cannot spend the file", async () => {
  const f = fixture();
  const ref = await f.store.put(new Uint8Array([1]), "report.pdf", "application/pdf", f.context, "reservation");
  const other = { ...f.context, accessSubject: { type: "user" as const, userId: "another-person" } };
  expect((await f.store.read(ref, other)).status).toBe(403);
  expect(f.calls.filter((call) => call.command === "GETDEL")).toHaveLength(0);
  setSystemTime(new Date(NOW.getTime() + 600_000));
  expect((await f.store.read(ref, f.context)).status).toBe(403);
});
test("run and mandate bindings distinguish file readers and budget scopes", async () => {
  const f = fixture();
  f.context.actor.delegation = {
    kind: "invocation",
    callingAppId: "core",
    credentialKind: "mandate",
    invocationId: "call",
    mandateId: "mandate-one",
    workloadType: "code.version",
    workloadId: "version-one",
    workloadRun: "run-one",
    workloadGeneration: 1,
  };
  const reservation = await f.store.reserve(f.context);
  f.context.actor.delegation.workloadGeneration = 2;
  expect(await f.store.reserve(f.context)).toBe(reservation);
  const ref = await f.store.put(new Uint8Array([1]), "report.pdf", "application/pdf", f.context, reservation);
  f.context.actor.delegation.workloadRun = "run-two";
  expect((await f.store.read(ref, f.context)).status).toBe(403);
  expect(await f.store.reserve(f.context)).not.toBe(reservation);
});
test("ordinary calls by one principal share admission across request IDs", async () => {
  const f = fixture();
  const first = await f.store.reserve(f.context);
  f.context.requestId = "request-two";
  expect(await f.store.reserve(f.context)).toBe(first);
  f.context.accessSubject = { type: "user", userId: "another-person" };
  expect(await f.store.reserve(f.context)).not.toBe(first);
});
test("refused budgets and oversized output fail before caching; cancellation stops admission", async () => {
  const f = fixture();
  f.refuse();
  await expect(f.store.reserve(f.context)).rejects.toMatchObject({ code: "CODE_FILE_LIMIT" });
  await expect(
    f.store.put(new Uint8Array(CODE_FILE_LIMITS.fileBytes + 1), "big.pdf", "application/pdf", f.context, "reservation"),
  ).rejects.toMatchObject({ code: "CODE_FILE_LIMIT" });
  expect(f.calls.some((call) => call.command === "SET")).toBe(false);
  f.context.signal = AbortSignal.abort();
  await expect(f.store.reserve(f.context)).rejects.toBeDefined();
});
