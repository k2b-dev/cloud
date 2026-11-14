import { afterEach, expect, spyOn, test } from "bun:test";
import * as provider from "@k2b/cloud/capabilities/server";
import { readCodeOwner } from "./access";

const owner = { kind: "resource" as const, ref: { type: "mail.mailbox", id: "m1" } };
const authority = (credentialKind: string) =>
  ({
    actor: { kind: "user", user: { id: "u1", uid: "u1", roles: [] } },
    accessSubject: { type: "user", userId: "u1" },
    credentialKind,
    scopes: [],
  }) as never;
const manifest = { appId: "mail", types: [{ localId: "mailbox", reader: "mailbox.read" }], queries: [{ localId: "mailbox.read" }] };
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
  expect(await readCodeOwner(owner, { authority: authority("invocation"), query })).toEqual({ title: "info@", admin: true });
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
