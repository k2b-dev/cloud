import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { migrate as migrateAuth } from "../../../../core/src/migrate/core/auth";
import { freeipa } from "../../server/services";
import { addIpa, updateProfile } from "../ipa/users";
import * as local from "../providers/local/users";
import * as settings from "../settings";

const suite = suiteFor("database");
const prefix = `email-write-${crypto.randomUUID()}`;
const email = (name: string) => `${name}.${prefix}@example.test`;
const createLocal = (mail: string) => local.create({ data: { email: mail }, profile: "guest", accountExpires: null });
const createIpa = (mail: string) =>
  addIpa({ ipaSession: "fixture", data: { email: mail, givenname: "Test", sn: "Email" }, accountExpires: null });
const fixture = async (mail: string, provider = "local") => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid,provider,profile,mail)
    VALUES (${crypto.randomUUID()},${provider},'guest',${mail}) RETURNING id`;
  return row!.id;
};
const stored = async (id: string) =>
  (
    await sql<{ id: string; mail: string; display_name: string; provider: string }[]>`
  SELECT id,mail,display_name,provider FROM auth.users WHERE id=${id}::uuid`
  )[0]!;
const configuration = {
  "freeipa.enable": true,
  "freeipa.url": "fixture.invalid",
  "freeipa.service_user": "fixture",
  "freeipa.service_password": "fixture-only",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["cloud-users"],
};

suite("account email writes with legacy duplicates", () => {
  beforeAll(async () => {
    for (const [key, value] of Object.entries(configuration)) await settings.set(key, JSON.stringify(value));
  });
  beforeEach(() => {
    spyOn(freeipa.client, "call").mockResolvedValue({ result: { result: {} }, error: null, id: 1 });
  });
  afterEach(() => mock.restore());
  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE lower(mail) LIKE ${`%${prefix}%`}`;
    for (const key of Object.keys(configuration)) await settings.remove(key);
  });

  test("reruns the real authentication migration without rewriting or rejecting legacy duplicates", async () => {
    const address = email("upgrade");
    const ids = [await fixture(address), await fixture(address.toUpperCase()), await fixture(address, "ipa")];
    const before = await Promise.all(ids.map(stored));
    await migrateAuth();
    expect(await Promise.all(ids.map(stored))).toEqual(before);
  });

  test("normalizes new local addresses and serializes concurrent creation", async () => {
    const address = email("new");
    const results = await Promise.all([address, address.toUpperCase(), ` ${address} `, address].map(createLocal));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.status === 409)).toBe(true);
    const winner = results.find((r) => r.ok);
    if (!winner?.ok) throw new Error("Missing winning account");
    expect((await stored(winner.data.id)).mail).toBe(address);
    const ipaId = await fixture(email("ipa-owned").toUpperCase(), "ipa");
    expect(await createLocal(email("ipa-owned"))).toMatchObject({ ok: false, status: 409 });
    expect(await createIpa(email("ipa-owned"))).toMatchObject({ ok: false, status: 409 });
    expect((await stored(ipaId)).provider).toBe("ipa");
    expect(freeipa.client.call).not.toHaveBeenCalled();
  });

  test("preserves exact stored addresses and IDs for case and provider duplicates", async () => {
    const address = email("legacy");
    const first = await fixture(address);
    const second = await fixture(address.toUpperCase());
    const ipaId = await fixture(address, "ipa");
    for (const id of [first, second]) {
      const before = await stored(id);
      expect((await local.update({ id, data: { mail: ` ${address} `, displayName: "Edited" } })).ok).toBe(true);
      expect(await stored(id)).toMatchObject({ id, mail: before.mail, display_name: "Edited", provider: "local" });
      expect((await local.setProfile({ id, profile: "user", accountExpires: null })).ok).toBe(true);
      expect((await stored(id)).mail).toBe(before.mail);
    }
    expect(
      (await updateProfile({ id: ipaId, ipaSession: "fixture", data: { mail: address.toUpperCase(), displayName: "IPA edited" } })).ok,
    ).toBe(true);
    expect(await stored(ipaId)).toMatchObject({ id: ipaId, mail: address, display_name: "IPA edited", provider: "ipa" });
    expect(freeipa.client.call).toHaveBeenCalledWith(expect.objectContaining({ options: { displayname: "IPA edited" } }));
  });

  test("rejects actual email changes to occupied addresses before local or remote effects", async () => {
    const occupied = email("occupied");
    await fixture(occupied.toUpperCase());
    const localId = await fixture(email("local-edit"));
    const ipaId = await fixture(email("ipa-edit"), "ipa");
    expect(await local.update({ id: localId, data: { mail: occupied, displayName: "Rejected" } })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect((await stored(localId)).mail).toBe(email("local-edit"));
    expect((await stored(localId)).display_name).not.toBe("Rejected");
    expect(await updateProfile({ id: ipaId, ipaSession: "fixture", data: { mail: occupied } })).toMatchObject({ ok: false, status: 409 });
    expect(freeipa.client.call).not.toHaveBeenCalled();
    expect((await local.update({ id: localId, data: { mail: ` ${email("available").toUpperCase()} ` } })).ok).toBe(true);
    expect((await stored(localId)).mail).toBe(email("available"));
  });

  test("promotes a unique normalized local match without changing its ID or email spelling", async () => {
    const address = email("promotion");
    const id = await fixture(address.toUpperCase());
    const result = await createIpa(address);
    expect(result).toMatchObject({ ok: true, data: { id } });
    expect(await stored(id)).toMatchObject({ mail: address.toUpperCase(), provider: "ipa" });
  });

  test("retains exact legacy promotion selection without merging other duplicate accounts", async () => {
    const address = email("duplicate-promotion");
    const selected = await fixture(address);
    const other = await fixture(address.toUpperCase());
    expect(await createIpa(address)).toMatchObject({ ok: true, data: { id: selected } });
    expect((await stored(other)).provider).toBe("local");
    expect((await stored(other)).mail).toBe(address.toUpperCase());
  });

  test("holds a remote email change claim until the local mirror is committed", async () => {
    const id = await fixture(email("remote-before"), "ipa");
    const target = email("remote-after");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(freeipa.client, "call").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { result: { result: {} }, error: null, id: 1 };
    });
    const update = updateProfile({ id, ipaSession: "fixture", data: { mail: target } });
    await entered.promise;
    let completed = false;
    const create = createLocal(target.toUpperCase()).finally(() => {
      completed = true;
    });
    try {
      await Bun.sleep(50);
      expect(completed).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await update).ok).toBe(true);
    expect(await create).toMatchObject({ ok: false, status: 409 });
    expect((await stored(id)).mail).toBe(target);
  });

  test("serializes concurrent IPA creates and changes to the same new address", async () => {
    const address = email("concurrent-ipa-create");
    const created = await Promise.all([createIpa(address), createIpa(address.toUpperCase())]);
    expect(created.filter((result) => result.ok)).toHaveLength(1);
    expect(created.filter((result) => !result.ok)).toMatchObject([{ ok: false, status: 409 }]);
    expect(freeipa.client.call).toHaveBeenCalledTimes(1);
    const one = await fixture(email("concurrent-edit-one"), "ipa");
    const two = await fixture(email("concurrent-edit-two"), "ipa");
    const target = email("concurrent-ipa-edit");
    const changed = await Promise.all([one, two].map((id) => updateProfile({ id, ipaSession: "fixture", data: { mail: target } })));
    expect(changed.filter((result) => result.ok)).toHaveLength(1);
    expect(changed.filter((result) => !result.ok)).toMatchObject([{ ok: false, status: 409 }]);
    expect(freeipa.client.call).toHaveBeenCalledTimes(2);
  });

  test("failed FreeIPA requests leave the address available and release the claim", async () => {
    const id = await fixture(email("failed-before"), "ipa");
    const target = email("failed-after");
    spyOn(freeipa.client, "call").mockResolvedValue({
      result: null,
      error: { code: 4301, message: "Denied", name: "ACIError", kind: "rpc" },
      id: 1,
    });
    expect((await updateProfile({ id, ipaSession: "fixture", data: { mail: target } })).ok).toBe(false);
    expect((await stored(id)).mail).toBe(email("failed-before"));
    expect((await createLocal(target)).ok).toBe(true);
  });
});
