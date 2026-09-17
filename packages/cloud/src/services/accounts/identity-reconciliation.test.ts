import { describe, expect, test } from "bun:test";
import type { IpaRpcResponse } from "../../server/services/freeipa/client";
import type { FreeIpaConfig } from "../freeipa-config";
import { parseIdentityShow, readUpstreamIdentity } from "./identity-reconciliation";

const absent: IpaRpcResponse = { id: 0, result: null, error: { kind: "rpc", code: 4001, name: "NotFound", message: "not found" } };
const success = (record: unknown): IpaRpcResponse => ({ id: 0, result: { result: record }, error: null });
const config: FreeIpaConfig = {
  enabled: true,
  configured: true,
  missingSettings: [],
  url: "ipa.test",
  serviceUser: "service",
  servicePassword: "test-only",
  groupsAdmin: [],
  groupsBaseSync: ["cloud"],
  groupsBaseIpaRealm: ["cloud"],
  groupsExcluded: ["external"],
  caCert: "",
  allowInsecure: false,
  syncGuard: { maxUserChanges: 10, maxUserChangePercent: 20, maxGroupDeletions: 5, maxGroupDeletionPercent: 20 },
};
describe("authoritative FreeIPA identity reconciliation", () => {
  test("caller cancellation reaches session and lookup and never establishes absence", async () => {
    const controller = new AbortController();
    let sessions = 0;
    let queries = 0;
    const deps = {
      config: async () => config,
      session: async (input: { signal?: AbortSignal }) => {
        sessions++;
        expect(input.signal?.aborted).toBe(false);
        return "session";
      },
      call: async (input: { signal?: AbortSignal }) => {
        queries++;
        expect(input.signal?.aborted).toBe(false);
        controller.abort();
        expect(input.signal?.aborted).toBe(true);
        return absent;
      },
    };
    expect(await readUpstreamIdentity({ kind: "users", name: "cancelled", signal: controller.signal }, deps)).toEqual({
      state: "unknown",
      reason: "provider_unavailable",
    });
    expect(queries).toBe(1);
    expect(await readUpstreamIdentity({ kind: "users", name: "cancelled", signal: controller.signal }, deps)).toEqual({
      state: "unknown",
      reason: "provider_unavailable",
    });
    expect(sessions).toBe(1);
  });
  test("a caller deadline aborts an in-flight session instead of waiting for the upstream timeout", async () => {
    const controller = new AbortController();
    const result = readUpstreamIdentity(
      { kind: "groups", name: "staff", signal: controller.signal },
      {
        config: async () => config,
        session: async ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
            controller.abort(new Error("caller budget exhausted"));
          }),
        call: async () => {
          throw new Error("must not query after aborted session");
        },
      },
    );
    expect(await result).toEqual({ state: "unknown", reason: "provider_unavailable" });
  });
  test("exact show errors prove absence only for structured NotFound", () => {
    expect(parseIdentityShow({ kind: "groups", name: "staff" }, absent)).toEqual({ state: "absent" });
    for (const error of [
      { kind: "rpc" as const, code: 4001, name: "SessionExpired", message: "not found" },
      { kind: "upstream" as const, code: 404, name: "FetchError", message: "not found" },
      { kind: "rpc" as const, code: 2100, name: "ACIError", message: "permission denied" },
    ])
      expect(parseIdentityShow({ kind: "groups", name: "staff" }, { id: 0, result: null, error }).state).toBe("unknown");
  });
  test("reads unsynced upstream identity numbers and rejects malformed or mismatched records", () => {
    const input = { kind: "users" as const, name: "external" };
    expect(parseIdentityShow(input, success({ uid: ["external"], uidnumber: ["4000"], gidnumber: ["6000"] }))).toEqual({
      state: "present",
      identity: { id: null, name: "external", uidNumber: 4000, gidNumber: 6000 },
      eligible: true,
    });
    for (const record of [
      null,
      [],
      {},
      { uid: ["wrong"] },
      { uid: ["external"], uidnumber: ["not-a-number"] },
      { uid: ["external"], gidnumber: ["1", "2"] },
    ])
      expect(parseIdentityShow(input, success(record)).state).toBe("unknown");
    expect(parseIdentityShow({ kind: "groups", name: "logical" }, success({ cn: ["logical"] }))).toMatchObject({
      state: "present",
      eligible: false,
    });
  });
  test("upstream lookup uses exact show without Cloud sync filters and keeps preserved users present", async () => {
    const calls: string[] = [];
    const result = await readUpstreamIdentity(
      { kind: "users", name: "external" },
      {
        config: async () => config,
        session: async () => "session",
        call: async (input) => {
          calls.push(input.method);
          expect(input.args).toEqual(["external"]);
          expect(input.options).toEqual({ all: true, no_members: true });
          return success({ uid: ["external"], uidnumber: ["4000"], gidnumber: ["6000"], preserved: true });
        },
      },
    );
    expect(calls).toEqual(["user_show"]);
    expect(result.state).toBe("present");
  });
  test("staged accounts remain present; two authoritative misses establish user absence", async () => {
    const calls: string[] = [];
    const deps = {
      config: async () => config,
      session: async () => "session",
      call: async (input: { method: string }) => {
        calls.push(input.method);
        return input.method === "user_show" ? absent : success({ uid: ["staged"] });
      },
    };
    expect(await readUpstreamIdentity({ kind: "users", name: "staged" }, deps)).toMatchObject({ state: "present", eligible: false });
    expect(calls).toEqual(["user_show", "stageuser_show"]);
    expect(await readUpstreamIdentity({ kind: "users", name: "missing" }, { ...deps, call: async () => absent })).toEqual({
      state: "absent",
    });
    expect(
      await readUpstreamIdentity(
        { kind: "users", name: "missing" },
        {
          ...deps,
          call: async (input) =>
            input.method === "user_show"
              ? absent
              : { id: 0, result: null, error: { kind: "rpc", code: 2100, name: "ACIError", message: "denied" } },
        },
      ),
    ).toEqual({ state: "unknown", reason: "provider_unavailable" });
  });
  test("disabled, unconfigured, failed sessions and transport failures never prove absence", async () => {
    let calls = 0;
    const deps = {
      config: async () => config,
      session: async () => "session",
      call: async () => {
        calls++;
        throw new Error("network");
      },
    };
    expect(
      await readUpstreamIdentity({ kind: "groups", name: "x" }, { ...deps, config: async () => ({ ...config, enabled: false }) }),
    ).toEqual({ state: "unknown", reason: "provider_disabled" });
    expect(
      await readUpstreamIdentity({ kind: "groups", name: "x" }, { ...deps, config: async () => ({ ...config, configured: false }) }),
    ).toEqual({ state: "unknown", reason: "provider_unavailable" });
    expect(calls).toBe(0);
    expect((await readUpstreamIdentity({ kind: "groups", name: "x" }, deps)).state).toBe("unknown");
    expect(
      (
        await readUpstreamIdentity(
          { kind: "groups", name: "x" },
          {
            ...deps,
            session: async () => {
              throw new Error("denied");
            },
          },
        )
      ).state,
    ).toBe("unknown");
  });
});
