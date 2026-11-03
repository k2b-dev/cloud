import { describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { bindResourceAppAccess } from "../../_internal/app-access-resources";
import { person } from "../../_internal/define-app.test-fixture";
import { appAccess } from "../../contracts/app-access";
import type { RequestAuthority } from "../../server/middleware/auth";
import type { AccessSubject } from "../../server/services/access";
import * as accountCategory from "../account-category-policy";
import * as appAccessService from "../app-access";
import * as appAccessMetrics from "../app-access-metrics";
import * as userService from "../session/user";
import type { CloudInvocationClaims, InvocationAuthority } from "./invocation-token";
import { issueInvocationToken, prepareFanoutIssuance, resolveIssuanceAuthority } from "./issue-invocation";

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

const demoRegistry = async () => [{ id: "demo", access: appAccess.signedIn() }];

describe("checked invocation issuer", () => {
  test("fanout decides app access with the reloaded authority: a phone's session never opens an admin-only app", async () => {
    const load = spyOn(userService, "loadCurrentUser").mockResolvedValue({ ...person, roles: ["user", "admin"] });
    const category = spyOn(accountCategory, "isAccountCategoryAllowed").mockResolvedValue(true);
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    try {
      // Discovery ran with the request's authority, where the phone session still lists the admin role.
      const issue = await prepareFanoutIssuance(
        { authority: params.authority, callingAppId: "core", entries: [{ appId: "demo" }] },
        { sign, groupsAdmin: [], registry: async () => [{ id: "demo", access: appAccess.roles(["admin"]) }] },
      );
      await expect(issue({ targetAppId: "demo", operation: params.operation, schemaHash: null })).rejects.toMatchObject({
        code: "app_access_denied",
      });
      expect(sign).not.toHaveBeenCalled();
    } finally {
      category.mockRestore();
      load.mockRestore();
    }
  });

  test.each(["app session", "scoped OAuth"])("fanout reloads %s authority once and retains its ceilings", async (credential) => {
    const load = spyOn(userService, "loadCurrentUser").mockResolvedValue({ ...person, roles: ["user", "admin"] });
    const category = spyOn(accountCategory, "isAccountCategoryAllowed").mockResolvedValue(true);
    const authority: InvocationAuthority =
      credential === "app session"
        ? params.authority
        : {
            sub: person.id,
            principal_type: "user",
            access_subject_type: "user",
            access_subject_id: person.id,
            credential_kind: "oauth",
            scopes: ["demo:read"],
          };
    const resolve = mock(async (...args: Parameters<typeof resolveIssuanceAuthority>) => {
      const resolved = await resolveIssuanceAuthority(...args);
      expect(resolved).toMatchObject({
        actor: { kind: "user", user: { roles: credential === "app session" ? ["user"] : ["user", "admin"] } },
        scopes: authority.scopes,
      });
      return resolved;
    });
    const sign = mock(async () => {
      throw new Error("reached signer");
    });
    try {
      const issue = await prepareFanoutIssuance(
        { authority, callingAppId: "core", entries: [{ appId: "demo" }] },
        { resolve, sign, groupsAdmin: [], registry: demoRegistry },
      );
      const target = { targetAppId: "demo", operation: params.operation, schemaHash: null };
      await expect(issue(target)).rejects.toThrow("reached signer");
      await expect(issue(target)).rejects.toThrow("reached signer");
      expect(load).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(2);
      expect(sign).toHaveBeenCalledWith({ ...target, authority, callingAppId: "core" });
    } finally {
      category.mockRestore();
      load.mockRestore();
    }
  });

  test("fanout reuses one resolution, preserves credential ceilings and rejects targets absent from discovery", async () => {
    const resolve = mock(async () => current());
    const sign = mock(async () => {
      throw new Error("reached signer");
    });
    const { authority, callingAppId, ...target } = params;
    const issue = await prepareFanoutIssuance(
      { authority, callingAppId, entries: [{ appId: "demo" }] },
      { resolve, sign, registry: demoRegistry },
    );
    await expect(issue(target)).rejects.toThrow("reached signer");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(authority, callingAppId, undefined, undefined);
    expect(sign).toHaveBeenCalledWith(params);
    sign.mockClear();
    await expect(issue({ ...target, targetAppId: "not-admitted" })).rejects.toMatchObject({ code: "app_access_denied" });
    expect(sign).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("fanout denies an inactive authority and cancellation before signing", async () => {
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    const { authority, callingAppId, ...target } = params;
    const deadline = new AbortController();
    const issue = await prepareFanoutIssuance(
      { authority, callingAppId, entries: [{ appId: "demo" }] },
      { resolve: async () => null, sign, signal: deadline.signal, registry: demoRegistry },
    );
    await expect(issue(target)).rejects.toMatchObject({ code: "app_access_denied" });
    const reason = new DOMException("cancelled", "AbortError");
    deadline.abort(reason);
    await expect(issue(target)).rejects.toBe(reason);
    expect(sign).not.toHaveBeenCalled();
  });

  test.each(["single", "fanout"])("%s issuance rejects a mismatched parent before signing", async (mode) => {
    const parent: CloudInvocationClaims = {
      ...params.authority,
      iss: "https://cloud.test",
      aud: "app:core",
      token_use: "invocation",
      act: { sub: "app:source" },
      op: params.operation,
      schema_hash: null,
      ver: 1,
      jti: "33333333-3333-4333-8333-333333333333",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_030,
    };
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    const resolve = async () => ({ ...current(), accessSubject: { type: "user" as const, userId: "changed-subject" } });
    const { authority, callingAppId, ...target } = params;
    const issued =
      mode === "single"
        ? issueInvocationToken({ ...params, parent }, { resolve, sign })
        : (
            await prepareFanoutIssuance(
              { authority, callingAppId, entries: [{ appId: "demo" }] },
              { resolve, sign, registry: demoRegistry },
            )
          )({
            ...target,
            parent,
          });
    await expect(issued).rejects.toMatchObject({ code: "app_access_denied" });
    expect(sign).not.toHaveBeenCalled();
  });

  test("fanout rechecks the credential ceiling at signing, so a key that expires during the batch signs nothing", async () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    setSystemTime(now);
    const agent: RequestAuthority = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdAt: "2026-01-01T00:00:00Z",
          createdBy: null,
        },
        delegatedUser: null,
        scopes: ["read"],
        credentialExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
      },
      accessSubject: { type: "service_account", serviceAccountId: "55555555-5555-4555-8555-555555555555" },
      credentialKind: "api_key",
      scopes: ["read"],
    };
    const sign = mock(async () => {
      throw new Error("reached signer");
    });
    const denied = spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {});
    try {
      const { authority, callingAppId, ...target } = params;
      const issue = await prepareFanoutIssuance(
        { authority, callingAppId, entries: [{ appId: "demo" }] },
        { resolve: async () => agent, sign, registry: demoRegistry },
      );
      await expect(issue(target)).rejects.toThrow("reached signer");
      setSystemTime(new Date(now.getTime() + 2_000));
      await expect(issue(target)).rejects.toMatchObject({ code: "app_access_denied" });
      expect(sign).toHaveBeenCalledTimes(1);
      expect(denied).toHaveBeenCalledWith("demo");
    } finally {
      denied.mockRestore();
      setSystemTime();
    }
  });

  test("fanout keeps a resource owner's outage unavailable, not denied, and records no denial", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const denied = spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {});
    const declaration = appAccess.resources({
      adapters: {
        workspace: {
          hasAnyRight: async () => {
            throw new Error("database unavailable");
          },
        },
      },
    });
    const stop = bindResourceAppAccess("demo", declaration);
    const sign = mock(async () => {
      throw new Error("must never sign");
    });
    try {
      const { authority, callingAppId, ...target } = params;
      const issue = await prepareFanoutIssuance(
        { authority, callingAppId, entries: [{ appId: "demo" }] },
        {
          resolve: async () => current(),
          sign,
          registry: async () => [{ id: "demo", access: { kind: "resources", adapters: ["workspace"] } }],
        },
      );
      await expect(issue(target)).rejects.toMatchObject({ code: "app_access_unavailable" });
      expect(denied).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    } finally {
      stop();
      denied.mockRestore();
      errors.mockRestore();
    }
  });

  test("fanout stops before reading the registry when the request ends during resolution", async () => {
    const deadline = new AbortController();
    const reason = new DOMException("search cancelled", "AbortError");
    const registry = mock(demoRegistry);
    const { authority, callingAppId } = params;
    await expect(
      prepareFanoutIssuance(
        { authority, callingAppId, entries: [{ appId: "demo" }] },
        {
          signal: deadline.signal,
          registry,
          resolve: async () => {
            deadline.abort(reason);
            return current();
          },
        },
      ),
    ).rejects.toBe(reason);
    expect(registry).not.toHaveBeenCalled();
  });

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
      expect(timeout).not.toHaveBeenCalled();
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
