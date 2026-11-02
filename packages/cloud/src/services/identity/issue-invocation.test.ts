import { describe, expect, mock, spyOn, test } from "bun:test";
import { bindResourceAppAccess } from "../../_internal/app-access-resources";
import { person } from "../../_internal/define-app.test-fixture";
import { appAccess } from "../../contracts/app-access";
import type { RequestAuthority } from "../../server/middleware/auth";
import type { AccessSubject } from "../../server/services/access";
import * as appAccessService from "../app-access";
import * as appAccessMetrics from "../app-access-metrics";
import type { InvocationAuthority } from "./invocation-token";
import { issueInvocationToken } from "./issue-invocation";

const params = {
  targetAppId: "demo",
  callingAppId: "core",
  operation: "capability.query:read",
  schemaHash: null,
  authority: {
    sub: person.id,
    principal_type: "user" as const,
    access_subject_type: "user" as const,
    access_subject_id: person.id,
    credential_kind: "session" as const,
    session_kind: "app" as const,
    scopes: [],
  },
};
const current = (): RequestAuthority => ({
  actor: {
    kind: "user",
    user: person,
    sessionKind: "app",
    delegation: { kind: "invocation", callingAppId: "core", credentialKind: "session", invocationId: "test" },
  },
  accessSubject: { type: "user", userId: person.id },
  credentialKind: "invocation",
  scopes: [],
});

describe("checked invocation issuer", () => {
  test.each(["during the probe", "after the allow"])("preserves cancellation %s without a denial metric or signing", async (phase) => {
    const deadline = new AbortController();
    const reason = new DOMException("search cancelled", "AbortError");
    const timeout = spyOn(AbortSignal, "timeout");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const denied = spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    const hasAnyRight = mock(async (_subject: AccessSubject, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      if (phase === "during the probe") deadline.abort(reason);
      return true;
    });
    const declaration = appAccess.resources({
      adapters: {
        workspace: { hasAnyRight },
      },
    });
    const stop = bindResourceAppAccess("demo", declaration);
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    const original = appAccessService.canUseApp;
    const access =
      phase === "after the allow"
        ? spyOn(appAccessService, "canUseApp").mockImplementation(async (...args) => {
            const allowed = await original(...args);
            deadline.abort(reason);
            return allowed;
          })
        : null;
    try {
      await expect(
        issueInvocationToken(params, {
          signal: deadline.signal,
          getApp: async () => ({ id: "demo", access: { kind: "resources", adapters: ["workspace"] } }),
          resolve: async () => current(),
          sign,
        }),
      ).rejects.toBe(reason);
      expect(signals).toEqual([deadline.signal]);
      expect(hasAnyRight).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(8_000);
      expect(denied).not.toHaveBeenCalled();
      expect(errors.mock.calls.filter(([source]) => source === "[app-access]")).toEqual([]);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      stop();
      timeout.mockRestore();
      access?.mockRestore();
      denied.mockRestore();
      errors.mockRestore();
    }
  });

  test("denies missing apps, failed registry reads and denied principals before signing", async () => {
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    for (const getApp of [
      async () => null,
      async () => {
        throw new Error("registry unavailable");
      },
      async () => ({ id: "demo", access: appAccess.roles(["admin"]) }),
    ]) {
      await expect(issueInvocationToken(params, { getApp, resolve: async () => current(), sign })).rejects.toMatchObject({
        code: "app_access_denied",
      });
    }
    expect(sign).not.toHaveBeenCalled();
  });

  test("keeps mobile-session and scope constraints, and does not sign for an inactive principal", async () => {
    const sign = mock(async () => {
      throw new Error("signed after access check");
    });
    let seen: unknown;
    const resolve = async (value: InvocationAuthority) => {
      seen = value;
      return current();
    };
    await expect(
      issueInvocationToken(params, { getApp: async () => ({ id: "demo", access: appAccess.signedIn() }), resolve, sign }),
    ).rejects.toThrow("signed after access check");
    expect(seen).toEqual(params.authority);
    expect(sign).toHaveBeenCalledWith(params);
    sign.mockClear();
    await expect(
      issueInvocationToken(params, { getApp: async () => ({ id: "demo" }), resolve: async () => null, sign }),
    ).rejects.toMatchObject({ code: "app_access_denied" });
    expect(sign).not.toHaveBeenCalled();
  });
});
