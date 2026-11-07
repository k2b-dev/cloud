import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { freeipa } from "../../server/services";
import { accountsAppService } from "../accounts/app";
import type { AccountsNotificationSender } from "../accounts/notification-sender";
import { transitionIpaUserToLocal } from "../accounts/switching";
import { session } from "../session";
import * as settings from "../settings";
import { addIpa } from "./users";

const suite = suiteFor("database", "valkey");
const now = new Date("2026-11-05T12:00:00Z");
const expiry = new Date("2027-11-05T12:00:00Z");
const uid = "reactivate-ada";
const mail = "ada@example.test";
const config = {
  "freeipa.enable": true,
  "freeipa.url": "fixture.invalid",
  "freeipa.service_user": "fixture",
  "freeipa.service_password": "fixture-only",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["cloud-users"],
};
const notFound = { result: null, error: { code: 4001, name: "NotFound", message: "not found", kind: "rpc" as const }, id: 0 };
const success = (result: unknown) => ({ result: { result }, error: null, id: 0 });
const remoteUsers = new Map<string, Record<string, unknown>>();
const memberships = new Map<string, Set<string>>();
let methods: string[] = [];
let failEnable = false;
let failRestore = false;
let id: string;
let database: Awaited<ReturnType<typeof useFreshDatabase>>;
const promote = () =>
  addIpa({ ipaSession: "fixture-session", data: { email: mail, givenname: "Ada", sn: "Lovelace" }, accountExpires: expiry });
const stored = async () =>
  (
    await sql`SELECT u.id, u.provider, p.uid_number, p.primary_gid_number, p.home_directory, p.login_shell
  FROM auth.users u LEFT JOIN auth.user_posix p ON p.user_id=u.id WHERE u.id=${id}::uuid`
  )[0]!;
const mutationMethods = () => methods.filter((method) => !["user_show", "group_show"].includes(method));

suite("FreeIPA guest reactivation through the real account services", () => {
  beforeAll(async () => {
    database = await useFreshDatabase("ipa_reactivate");
  });
  for (const name of ["settings", "auth", "audit", "logging", "events"]) {
    beforeAll(async () => {
      const path = `../../../../core/src/migrate/core/${name}.ts`;
      await (await import(path)).migrate();
    });
  }
  beforeEach(async () => {
    setSystemTime(now);
    methods = [];
    failEnable = false;
    failRestore = false;
    remoteUsers.clear();
    memberships.clear();
    memberships.set("existing-project", new Set([uid]));
    memberships.set("cloud", new Set());
    memberships.set("cloud-users", new Set());
    for (const [key, value] of Object.entries(config)) await settings.set(key, value);
    const [user] = await sql`INSERT INTO auth.users(uid,provider,profile,mail) VALUES(${uid},'ipa','user',${mail}) RETURNING id`;
    id = user!.id;
    await sql`INSERT INTO auth.user_ipa_data(user_id,uid_number) VALUES(${id}::uuid,12345)`;
    await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,home_directory,login_shell)
      VALUES(${id}::uuid,'ipa',12345,23456,'/home/reactivate-ada','/bin/bash')`;
    // Real demotion deletes IPA details and keeps UID/mail and the POSIX association.
    await transitionIpaUserToLocal({ userId: id, targetProfile: "guest", accountExpires: null });
    expect(await sql`SELECT user_id FROM auth.user_ipa_data WHERE user_id=${id}::uuid`).toHaveLength(0);
    remoteUsers.set(uid, {
      uid: [uid],
      mail: [" ADA@EXAMPLE.TEST ", "ada.secondary@example.test"],
      ipauniqueid: ["entry-ada"],
      uidnumber: ["12345"],
      gidnumber: ["23456"],
      homedirectory: ["/home/reactivate-ada"],
      loginshell: ["/bin/bash"],
      krbprincipalexpiration: ["20260101000000Z"],
      nsaccountlock: [false],
    });
    spyOn(session, "revokeAllForUser").mockResolvedValue(0);
    spyOn(freeipa.session, "getServiceSession").mockResolvedValue("fixture-session");
    spyOn(freeipa.client, "call").mockImplementation(async ({ method, args = [], options = {} }) => {
      methods.push(method);
      const key = String(args[0]);
      const remote = remoteUsers.get(key);
      if (method === "user_show") return remote ? success({ ...remote }) : notFound;
      if (method === "user_add") {
        if (remote) return { ...notFound, error: { ...notFound.error, code: 4002, name: "DuplicateEntry", message: "already exists" } };
        const added = { uid: [key], ...options, uidnumber: ["34567"], gidnumber: ["45678"] };
        remoteUsers.set(key, added);
        return success(added);
      }
      if (method === "user_mod") {
        if (failRestore && options.krbprincipalexpiration === "20260101000000Z") {
          return { ...notFound, error: { ...notFound.error, code: 4301, name: "ACIError", message: "restore denied" } };
        }
        if (!remote) return notFound;
        Object.assign(remote, options);
        return success({ uid: [key] }); // IPA may omit unchanged POSIX fields.
      }
      if (method === "user_enable") {
        if (failEnable) return { ...notFound, error: { ...notFound.error, code: 4301, name: "ACIError", message: "enable denied" } };
        if (!remote) return notFound;
        remote.nsaccountlock = [false];
        return success(true);
      }
      if (method === "user_disable") {
        if (!remote) return notFound;
        remote.nsaccountlock = [true];
        return success(true);
      }
      if (method === "group_add_member") {
        const members = memberships.get(key);
        if (!members) return notFound;
        const names = options.user;
        if (!Array.isArray(names)) throw new Error("Expected user membership options");
        for (const name of names) members.add(String(name));
        return success({ member_user: [...members] });
      }
      if (method === "group_show") return success({ member_user: [...(memberships.get(key) ?? [])] });
      throw new Error(`Unexpected RPC ${method}`);
    });
  });
  afterEach(async () => {
    mock.restore();
    setSystemTime();
    await sql`DROP TRIGGER IF EXISTS reject_reactivation ON auth.users`;
    await sql`DELETE FROM auth.users WHERE uid=${uid} OR mail=${mail}`;
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("expired same person is reactivated with the original POSIX identity, password and memberships", async () => {
    const result = await promote();
    expect(result).toMatchObject({ ok: true, data: { id, uid, reactivated: true, accountExpires: expiry.toISOString() } });
    expect(await stored()).toMatchObject({
      id,
      provider: "ipa",
      uid_number: 12345,
      primary_gid_number: 23456,
      home_directory: "/home/reactivate-ada",
      login_shell: "/bin/bash",
    });
    expect(methods).not.toContain("user_add");
    expect(methods.lastIndexOf("group_add_member")).toBeLessThan(methods.lastIndexOf("user_mod"));
    expect(remoteUsers.get(uid)?.mail).toEqual([" ADA@EXAMPLE.TEST ", "ada.secondary@example.test"]);
    expect(remoteUsers.get(uid)?.krbprincipalexpiration).toBe("20271105120000Z");
    if (!result.ok) throw new Error(result.error);
    expect(remoteUsers.get(uid)?.userpassword).toBe(result.data._temporaryPassword);
    expect(result.data._temporaryPassword.length).toBeGreaterThanOrEqual(20);
    expect(memberships.get("existing-project")?.has(uid)).toBe(true);
    expect(memberships.get("cloud")?.has(uid)).toBe(true);
    expect(memberships.get("cloud-users")?.has(uid)).toBe(true);
    expect(await sql`SELECT * FROM auth.ipa_reactivations WHERE user_id=${id}::uuid`).toHaveLength(0);
  });

  test("disabled accounts are enabled and an unlimited approval clears remote expiry", async () => {
    Object.assign(remoteUsers.get(uid)!, { nsaccountlock: [true], krbprincipalexpiration: [] });
    const result = await addIpa({ ipaSession: "fixture", data: { email: mail, givenname: "Ada", sn: "Lovelace" }, accountExpires: null });
    expect(result.ok).toBe(true);
    expect(methods).toContain("user_enable");
    expect(remoteUsers.get(uid)?.nsaccountlock).toEqual([false]);
    expect(remoteUsers.get(uid)?.krbprincipalexpiration).toBe("");
  });

  test("an interrupted enable is recoverable after the password and expiry already changed", async () => {
    remoteUsers.get(uid)!.nsaccountlock = [true];
    failEnable = true;
    expect(await promote()).toMatchObject({ ok: false, status: 403 });
    expect((await stored()).provider).toBe("local");
    failEnable = false;
    expect(await promote()).toMatchObject({ ok: true, data: { id, reactivated: true } });
    expect(remoteUsers.get(uid)?.nsaccountlock).toEqual([false]);
    expect((await stored()).uid_number).toBe(12345);
  });

  test.each(["different mail", "missing mail", "different uidNumber", "active account"])(
    "refuses %s before any remote mutation",
    async (kind) => {
      const remote = remoteUsers.get(uid)!;
      if (kind === "different mail") remote.mail = ["someone-else@example.test"];
      else if (kind === "missing mail") remote.mail = [];
      else if (kind === "different uidNumber") remote.uidnumber = ["99999"];
      else remote.krbprincipalexpiration = [];
      expect(await promote()).toMatchObject({ ok: false, status: 409 });
      expect(mutationMethods()).toEqual([]);
      expect((await stored()).provider).toBe("local");
    },
  );

  test.each([false, true])(
    "a local re-link failure compensates access and preserves a retry claim (rollback failure: %s)",
    async (rollbackFails) => {
      failRestore = rollbackFails;
      await sql`CREATE OR REPLACE FUNCTION auth.reject_reactivation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.provider='local' AND NEW.provider='ipa' THEN RAISE EXCEPTION 'fixture relink failure'; END IF; RETURN NEW; END $$`;
      await sql`CREATE TRIGGER reject_reactivation BEFORE UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.reject_reactivation()`;
      await expect(promote()).rejects.toThrow("fixture relink failure");
      expect((await stored()).provider).toBe("local");
      expect(remoteUsers.get(uid)?.krbprincipalexpiration).toBe(rollbackFails ? "20271105120000Z" : "20260101000000Z");
      expect((await sql`SELECT remote_id FROM auth.ipa_reactivations WHERE user_id=${id}::uuid`)[0]?.remote_id).toBe(
        "ipauniqueid:entry-ada",
      );
      await sql`DROP TRIGGER reject_reactivation ON auth.users`;
      failRestore = false;
      const result = await promote();
      expect(result).toMatchObject({ ok: true, data: { id, reactivated: true } });
      expect((await stored()).uid_number).toBe(12345);
      expect(methods).not.toContain("user_add");
    },
  );

  test("a retry refuses a replaced remote identity even when its mail and UID match", async () => {
    memberships.delete("cloud-users");
    expect(await promote()).toMatchObject({ ok: false });
    expect(remoteUsers.get(uid)?.krbprincipalexpiration).toEqual(["20260101000000Z"]);
    remoteUsers.get(uid)!.ipauniqueid = ["replacement-entry"];
    methods = [];
    expect(await promote()).toMatchObject({ ok: false, status: 409 });
    expect(mutationMethods()).toEqual([]);
  });

  test("missing remote entries on retry and denied lookups never fall through to user_add", async () => {
    memberships.delete("cloud-users");
    expect(await promote()).toMatchObject({ ok: false });
    remoteUsers.delete(uid);
    methods = [];
    expect(await promote()).toMatchObject({ ok: false, status: 409 });
    expect(mutationMethods()).toEqual([]);
    spyOn(freeipa.client, "call").mockResolvedValue({
      ...notFound,
      error: { code: 4301, name: "ACIError", message: "denied", kind: "rpc" },
    });
    expect(await promote()).toMatchObject({ ok: false, status: 403 });
  });

  test("a missing former IPA account never silently replaces its stored POSIX identity", async () => {
    remoteUsers.clear();
    expect(await promote()).toMatchObject({ ok: false, status: 409 });
    expect(mutationMethods()).toEqual([]);
    expect((await stored()).uid_number).toBe(12345);
  });

  test("a guest without an IPA identity still uses user_add", async () => {
    remoteUsers.clear();
    await sql`DELETE FROM auth.user_posix WHERE user_id=${id}::uuid`;
    expect(await promote()).toMatchObject({ ok: true, data: { id, reactivated: false } });
    expect(mutationMethods()).toEqual(["user_add"]);
    expect((await stored()).uid_number).toBe(34567);
  });

  test("brand-new Cloud identities still publish the normal creation event", async () => {
    await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    remoteUsers.clear();
    const result = await promote();
    expect(result).toMatchObject({ ok: true, data: { reactivated: false } });
    if (!result.ok) throw new Error(result.error);
    expect(result.data.id).not.toBe(id);
    expect(mutationMethods()).toEqual(["user_add"]);
    expect(
      await sql`SELECT id FROM events.outbox WHERE payload->>'type'='core.user.created' AND payload->'data'->>'userId'=${result.data.id}`,
    ).toHaveLength(1);
  });

  test("approval records reactivation instead of creation and uses the existing welcome password path", async () => {
    await sql`INSERT INTO auth.account_requests(user_id,comment) VALUES(${id}::uuid,'Fixture request')`;
    const [request] = await sql`SELECT id FROM auth.account_requests WHERE user_id=${id}::uuid`;
    let deliveredPassword: string | undefined;
    const accepted = { id: "fixture", status: "queued" as const };
    const sender: AccountsNotificationSender = {
      sendFreeIpaWelcome: async ({ temporaryPassword }) => {
        deliveredPassword = temporaryPassword;
        return accepted;
      },
      sendLocalWelcome: async () => accepted,
      sendLoginLink: async () => accepted,
      sendRequestDenied: async () => accepted,
      sendAdministrativeMessage: async () => accepted,
    };
    const result = await accountsAppService.user.create({
      actor: { userId: id, uid, roles: ["admin"], provider: "local" },
      processedBy: id,
      notificationSender: sender,
      data: {
        provider: "ipa",
        email: mail,
        givenname: "Ada",
        sn: "Lovelace",
        requestId: request!.id,
      },
    });
    expect(result).toMatchObject({ ok: true, data: { id, notificationSent: true } });
    expect(deliveredPassword).toBe(String(remoteUsers.get(uid)?.userpassword));
    expect(await sql<{ action: string }[]>`SELECT action FROM audit.events WHERE target_id=${id} AND outcome='allowed'`).toContainEqual({
      action: "accounts.user.reactivate",
    });
    expect((await sql`SELECT status FROM auth.account_requests WHERE id=${request!.id}`)[0]?.status).toBe("completed");
  });
});
