import { afterEach, expect, spyOn, test } from "bun:test";
import * as provider from "@k2b/cloud/capabilities/server";
import { type CodeContext, codePageOwnerPersonName, isCodePageMember, readCodeOwner } from "./access";
import { readModelNames } from "./read-model/names";

const owner = { kind: "resource" as const, ref: { type: "mail.mailbox", id: "m1" } };
const authority = (credentialKind: string) =>
  ({
    actor: { kind: "user", user: { id: "u1", uid: "u1", roles: [] } },
    accessSubject: { type: "user", userId: "u1" },
    credentialKind,
    scopes: [],
  }) as never;
const manifest = {
  appId: "mail",
  types: [{ localId: "mailbox", reader: "mailbox.read" }],
  queries: [{ localId: "mailbox.read" }],
  actions: [],
};
const answer = { ok: true, data: { data: { view: { title: "info@", permission: "admin" } } } };
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("under a capability invocation the owner is asked through the nested query, which is the only allowed way", async () => {
  spies.push(spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: { manifest } } as never));
  const direct = spyOn(provider, "invokeCapabilityWithDataSchema");
  spies.push(direct);
  const asked: unknown[] = [];
  const query = (async (invocation: unknown) => {
    asked.push(invocation);
    return answer;
  }) as never;
  const context: CodeContext = { authority: authority("invocation"), query, ownerReaderAnswer: null };
  expect(await readCodeOwner(owner, context)).toEqual({ title: "info@", admin: true });
  expect(await readCodeOwner(owner, context)).toEqual({ title: "info@", admin: true });
  const names = await readModelNames([], context, [], [owner.ref, { ...owner.ref, id: "other-mailbox" }]);
  expect(names.target(owner.ref)).toEqual({ name: "info@", readable: true });
  expect(names.target({ ...owner.ref, id: "other-mailbox" })).toMatchObject({ readable: false, unavailable: true });
  expect(JSON.stringify(names.target({ ...owner.ref, id: "other-mailbox" }))).not.toContain("info@");
  expect(asked).toEqual([{ appId: "mail", capabilityId: "mailbox.read", input: { id: "m1" }, signal: undefined }]);
  expect(direct).not.toHaveBeenCalled();
});

test("a session keeps asking directly under its own authority", async () => {
  spies.push(spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: { manifest } } as never));
  const direct = spyOn(provider, "invokeCapabilityWithDataSchema").mockResolvedValue(answer as never);
  spies.push(direct);
  expect(await readCodeOwner(owner, { authority: authority("session") })).toEqual({ title: "info@", admin: true });
  expect(direct).toHaveBeenCalledTimes(1);
});

const viewer = (profile: "user" | "guest", credentialKind = "session") =>
  ({
    actor: { kind: "user", user: { id: "u1", uid: "lea", displayName: "Lea Muster", roles: [], profile } },
    accessSubject: { type: "user", userId: "u1" },
    credentialKind,
  }) as never;

test("F26: members read the name of the person who owns a Code page; visitors, guests and workloads never do", () => {
  expect(isCodePageMember(viewer("user"))).toBe(true);
  expect(codePageOwnerPersonName(viewer("user"), "Jana Probe")).toBe("Jana Probe");
  for (const other of [viewer("guest"), viewer("user", "api_key"), viewer("user", "oauth"), {}])
    expect(codePageOwnerPersonName(other, "Jana Probe")).toBeNull();
  // A workload acting for nobody, or a session whose subject is someone else, is no member.
  expect(
    isCodePageMember({
      actor: { kind: "service_account", serviceAccount: { id: "sa", kind: "code", status: "active" } },
      accessSubject: { type: "service_account", serviceAccountId: "sa" },
      credentialKind: "session",
    } as never),
  ).toBe(false);
  expect(isCodePageMember({ ...(viewer("user") as object), accessSubject: { type: "user", userId: "someone-else" } } as never)).toBe(false);
  expect(codePageOwnerPersonName(viewer("user"), null)).toBeNull();
});

test("F26 leaves readCodeOwner alone: it names a person only to that person, also to readers of the Code", async () => {
  const self = { authority: { ...(viewer("user") as object), scopes: [] } as never };
  expect(await readCodeOwner({ kind: "person", userId: "u1" }, self)).toEqual({ title: "Lea Muster", admin: true });
  expect(await readCodeOwner({ kind: "person", userId: "someone-else" }, self)).toBeNull();
});
