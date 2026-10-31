import { expect, test } from "bun:test";
import type { RequestActor, RequestAuthority } from "../../server/middleware/auth";
import { buildProjectedUser } from "../session/user";
import { approvalAdminActor } from "./authority";

const user = buildProjectedUser({
  id: "c5000000-0000-4000-8000-000000000001",
  uid: "reviewer",
  provider: "local",
  profile: "user",
  effective_admin: true,
});
const sessionActor: RequestActor = { kind: "user", user };
const personalActor: RequestActor = {
  kind: "service_account",
  serviceAccount: {
    id: "c5000000-0000-4000-8000-000000000002",
    name: "Personal CLI",
    kind: "user_delegated",
    status: "active",
    delegatedUserId: user.id,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: user.id,
    createdAt: "2026-10-31T00:00:00Z",
  },
  delegatedUser: user,
  scopes: [],
};
const authority = (actor: RequestActor, credentialKind: RequestAuthority["credentialKind"], scopes: string[] = []): RequestAuthority => ({
  actor,
  accessSubject: { type: "user", userId: user.id },
  credentialKind,
  scopes,
});

test("role credentials preserve phone, machine and scope ceilings", () => {
  expect(approvalAdminActor(user.id, authority(sessionActor, "session"))).toEqual(sessionActor);
  expect(approvalAdminActor(user.id, authority({ ...sessionActor, sessionKind: "app" }, "session"))).toBeNull();
  expect(approvalAdminActor(user.id, authority(personalActor, "api_key"))).toMatchObject({ kind: "user", user });
  expect(approvalAdminActor(user.id, authority(personalActor, "api_key", ["write"]))).toBeNull();
  expect(approvalAdminActor(user.id, authority(personalActor, "api_key", ["admin"]))).toMatchObject({ kind: "user", user });
  expect(approvalAdminActor(user.id, authority(sessionActor, "oauth", ["write"]))).toBeNull();
  expect(approvalAdminActor(user.id, authority(sessionActor, "oauth", ["admin"]))).toEqual(sessionActor);
  expect(approvalAdminActor(user.id, authority(sessionActor, "oauth", ["admin", "ai:inference"]))).toBeNull();
  expect(approvalAdminActor("c5000000-0000-4000-8000-000000000099", authority(sessionActor, "session"))).toBeNull();
  for (const kind of ["agent", "standalone", "resource_bound"] as const) {
    expect(
      approvalAdminActor(
        user.id,
        authority({ ...personalActor, serviceAccount: { ...personalActor.serviceAccount, kind } }, "api_key", ["admin"]),
      ),
    ).toBeNull();
  }
});

test("app invocations cannot decide role approvals, including a resumed turn's session authority", () => {
  for (const credentialKind of ["session", "oauth", "api_key", "mandate"] as const) {
    const actor: RequestActor = {
      ...sessionActor,
      delegation: { kind: "invocation", callingAppId: "demo", credentialKind, invocationId: "approval-test" },
    };
    expect(approvalAdminActor(user.id, authority(actor, "invocation", ["admin"]))).toBeNull();
    expect(approvalAdminActor(user.id, authority(actor, "session"))).toBeNull();
  }
  expect(approvalAdminActor(user.id, authority(sessionActor, "invocation", ["admin"]))).toBeNull();
});
