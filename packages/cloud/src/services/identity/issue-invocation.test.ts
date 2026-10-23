import { describe, expect, mock, test } from "bun:test";
import { person } from "../../_internal/define-app.test-fixture";
import { appAccess } from "../../contracts/app-access";
import type { RequestAuthority } from "../../server/middleware/auth";
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
