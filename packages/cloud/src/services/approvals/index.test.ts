import { describe, expect, test } from "bun:test";
import { capabilityRequestHash } from "../../capabilities/claims";
import { APPROVAL_ACP_CLIENT, APPROVAL_CLIENT_HEADER } from "../../contracts/approvals";
import type { RequestActor } from "../../server/middleware/auth";
import { approvalArgsDigest, approvalDecisionChannel, approvalReviewDigest, approvalScopeFromToolName, request } from ".";

const actor: RequestActor = {
  kind: "user",
  sessionKind: "app",
  user: {
    id: crypto.randomUUID(),
    uid: "approval-test",
    provider: "local",
    profile: "user",
    roles: [],
    displayName: "Test",
    mail: null,
    givenname: "Test",
    sn: "User",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
};

describe("approval identity and binding", () => {
  test("records the deciding credential, including app sessions and in-process relays", () => {
    expect(approvalDecisionChannel({ credentialKind: "session" })).toBe("web_session");
    expect(approvalDecisionChannel({ credentialKind: "session", actor })).toBe("app_session");
    expect(approvalDecisionChannel({ credentialKind: "session", actor: { ...actor, sessionKind: undefined } })).toBe("web_session");
    for (const credentialKind of ["oauth", "api_key", "invocation"] as const)
      expect(approvalDecisionChannel({ credentialKind, actor })).toBe(credentialKind);
    expect(approvalDecisionChannel({ actor })).toBe("invocation");
  });
  test("an ACP bridge declares its channel regardless of the credential", () => {
    const headers = new Headers({ [APPROVAL_CLIENT_HEADER]: APPROVAL_ACP_CLIENT });
    for (const credentialKind of ["session", "oauth", "api_key", "invocation", undefined] as const) {
      expect(approvalDecisionChannel({ credentialKind, actor, client: headers.get(APPROVAL_CLIENT_HEADER) })).toBe("acp_bridge");
      expect(approvalDecisionChannel({ credentialKind, actor, client: "other" })).toBe(approvalDecisionChannel({ credentialKind, actor }));
      expect(approvalDecisionChannel({ credentialKind, actor, client: null })).toBe(approvalDecisionChannel({ credentialKind, actor }));
    }
  });
  test("uses the capability's owning app and preserves the complete local action name", () => {
    expect(approvalScopeFromToolName("spaces.task.create")).toEqual({ appId: "spaces", action: "task.create" });
    expect(approvalScopeFromToolName("local_bash")).toEqual({ appId: "assistant", action: "local_bash" });
  });
  test("shares the dispatcher's canonical digest", () => {
    expect(approvalArgsDigest({ z: 2, a: { b: 1, a: 0 } })).toBe(capabilityRequestHash({ a: { a: 0, b: 1 }, z: 2 }));
    expect(approvalReviewDigest(undefined)).toBe(capabilityRequestHash(null));
    expect(approvalReviewDigest({ message: "Write?" })).toBe(capabilityRequestHash({ message: "Write?" }));
  });
});

test("Code requests reject unrepresentable lifetimes before writing a request", async () => {
  for (const expiresInMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
    await expect(
      request({
        kind: "code_version",
        appId: "demo",
        action: "version.approve",
        authorUserId: "c5000000-0000-4000-8000-000000000001",
        approverRole: "admin",
        requester: { kind: "code_version", ref: "attempt", appId: "demo", href: "/code/demo/" },
        sentence: "Approve the version?",
        input: { versionId: "one" },
        expiresInMs,
      }),
    ).rejects.toThrow("Code approval expiry must be finite and fit in a JavaScript Date.");
  }
});
