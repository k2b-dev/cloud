import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { RequestActor } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, type Node } from "@k2b/filegate";
import { sql } from "bun";
import { bindings } from "../data/bases";
import { migrate } from "../migrate";
import { createFilesService } from ".";

const url = process.env.FILESV2_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Files service and durable bindings", () => {
  const nodes = new Map<string, Node>();
  let leases = 0;
  let config = {
    url: "http://filegate:4000",
    token: "backend-test-secret",
    tokenConfigured: true,
    cloud: { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" },
    freeipa: { enabled: true, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
  };
  const set = async (key: string, value: unknown) => {
    const encrypted = await secrets.encrypt(value);
    await sql`INSERT INTO settings.entries(key,value) VALUES(${key},${encrypted}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  };
  const directory = (root: string, path: string, uid = 1001, gid = 2001, mode = "0770", directory = true) => {
    const node = { root, path, uid, gid, mode, directory, size: directory ? 0 : 12, modified: new Date().toISOString() };
    nodes.set(`${root}:${path}`, node);
    return node;
  };
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = new URL(input instanceof Request ? input.url : input.toString());
      const parts = req.pathname.split("/");
      const root = parts[3]!;
      const operation = parts[4];
      if (!operation)
        return Response.json({
          name: root,
          index: { enabled: root === "cloud" },
          versioning: { enabled: false },
          stats: null,
          versions: 0,
          versionBytes: 0,
          activeUploads: 0,
          available: 1000,
          capacity: 2000,
        });
      if (operation === "downloads") {
        leases++;
        return Response.json({ method: "GET", url: "http://localhost:4000/signed", expires: "2099-01-01T00:00:00Z" });
      }
      const path = req.searchParams.get("path") ?? ".";
      const node = nodes.get(`${root}:${path}`);
      if (!node) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
      if (operation === "acl") {
        const mode = Number.parseInt(node.mode, 8);
        const permission = (bits: number) => `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
        return Response.json({
          entries: [
            { tag: "owner", permissions: permission((mode >> 6) & 7) },
            { tag: "owningGroup", permissions: permission((mode >> 3) & 7) },
            { tag: "other", permissions: permission(mode & 7) },
          ],
        });
      }
      if (operation === "entries")
        return Response.json({
          items: [...nodes.values()].filter(
            (item) => item.root === root && item.path.startsWith(`${path}/`) && !item.path.slice(path.length + 1).includes("/"),
          ),
        });
      return Response.json(node);
    },
    { preconnect: fetch.preconnect },
  );
  const service = createFilesService({
    identities: accountIdentities,
    bindings,
    readConfiguration: async () => config,
    writeConfiguration: async (input) => {
      config = { ...input, token: input.token || config.token, tokenConfigured: true };
    },
    connect: (configuration) => new Filegate({ baseUrl: configuration.url, token: configuration.token, fetch: transport }),
  });
  const user = async (
    name: string,
    provider: "local" | "ipa" = "local",
    admin = false,
    profile: "user" | "guest" = "user",
  ): Promise<RequestActor> => {
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${name},${provider},${profile},${admin}) RETURNING id`;
    if (provider === "ipa") await sql`INSERT INTO auth.user_posix VALUES(${row!.id},'ipa',1001,2001)`;
    return {
      kind: "user",
      user: UserSchema.parse({
        id: row!.id,
        uid: name,
        provider,
        profile,
        roles: admin ? ["user", "admin"] : [profile],
        givenname: "",
        sn: "",
        displayName: name,
        mail: null,
        avatarHash: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
        ipa:
          provider === "local"
            ? null
            : {
                uidNumber: 1001,
                phone: null,
                employeeType: null,
                mobile: null,
                address: { street: null, postalCode: null, city: null, state: null },
                passwordExpires: null,
                lastLoginIpa: null,
                syncedAt: null,
                sshPublicKeys: [],
                sshFingerprints: [],
              },
      }),
    };
  };
  const id = (actor: RequestActor) => (actor.kind === "user" ? actor.user.id : "");
  beforeAll(async () => {
    if (
      !url ||
      new URL(process.env.DATABASE_URL ?? "postgres://invalid/").pathname !== new URL(url).pathname ||
      new URL(url).pathname !== "/cloud_filesv2_backend_test"
    )
      throw new Error("Dedicated Filesv2 backend database required");
    await migrate();
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups(user_id uuid,group_name text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.bases,auth.users,auth.user_posix,auth.groups,auth.user_groups_v2,auth.group_groups_v2,auth.ipa_user_effective_groups,settings.entries CASCADE`.simple();
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    await set("freeipa.enable", true);
    config.cloud.enabled = true;
    config.freeipa.enabled = true;
    nodes.clear();
    leases = 0;
    for (const root of ["cloud", "freeipa"]) {
      directory(root, ".", 0, 0, "0755");
      directory(root, "users", 0, 0, "0755");
      directory(root, "groups", 0, 0, "0755");
    }
  });
  test("external IPA home is detected without index/provisioning and direct lease checks current Unix rights", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/report", 1001, 2001, "0640", false);
    const bases = await service.bases(actor);
    expect(bases.items[0]?.status).toBe("existing");
    const baseId = bases.items[0]!.id;
    const listed = await service.list(actor, { baseId });
    expect(listed.items[0]?.name).toBe("report");
    expect((await service.download(actor, { baseId, path: "report" })).method).toBe("GET");
    expect(leases).toBe(1);
    directory("freeipa", "users/alice/report", 999, 999, "0600", false);
    await expect(service.download(actor, { baseId, path: "report" })).rejects.toMatchObject({ code: "forbidden" });
    expect(leases).toBe(1);
    directory("freeipa", "users/alice", 1001, 2001, "0600");
    await expect(service.download(actor, { baseId, path: "report" })).rejects.toMatchObject({ code: "forbidden" });
  });
  test("Cloud adoption remains stable after POSIX allocation, provider off/on, and hides top-level trash", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 99, 99);
    directory("cloud", "users/admin/trash", 99, 99);
    directory("cloud", "users/admin/report", 99, 99, "0600", false);
    expect((await service.bases(admin)).items[0]?.status).toBe("unassigned");
    const base = await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await sql`INSERT INTO auth.user_posix VALUES(${id(admin)},'local',200001,200001)`;
    await set("freeipa.enable", false);
    expect((await service.list(admin, { baseId: base.id })).items.map((item) => item.name)).toEqual(["report"]);
    await expect(service.download(admin, { baseId: base.id, path: "trash/report" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.download(admin, { baseId: base.id, path: "../other" })).rejects.toMatchObject({ code: "invalid_path" });
    config.cloud.enabled = false;
    await expect(service.list(admin, { baseId: base.id })).rejects.toMatchObject({ code: "area_disabled" });
    config.cloud.enabled = true;
    expect((await service.download(admin, { baseId: base.id, path: "report" })).method).toBe("GET");
  });
  test("retained claim denies a reused username and concurrent identity claims cannot take over coordinates", async () => {
    const first = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    await service.bases(first);
    await sql`DELETE FROM auth.users WHERE id=${id(first)}::uuid`;
    const second = await user("alice", "ipa");
    expect((await service.bases(second)).items[0]?.reason).toBe("binding_conflict");
    const a = {
      area: "cloud" as const,
      kind: "groups" as const,
      identity_id: crypto.randomUUID(),
      identity_name: "team",
      root: "cloud",
      path: "groups/team",
      uid_number: null,
      gid_number: 200003,
    };
    const b = { ...a, identity_id: crypto.randomUUID() };
    await Promise.all([bindings.claim(a), bindings.claim(b)]);
    const rows = await sql`SELECT * FROM filesv2.bases WHERE root='cloud' AND path='groups/team'`;
    expect(rows).toHaveLength(1);
    expect([a.identity_id, b.identity_id]).toContain(rows[0].identity_id);
  });
  test("guest and global Cloud prerequisite denial occurs before leases", async () => {
    const guest = await user("guest", "local", false, "guest");
    await expect(service.bases(guest)).rejects.toMatchObject({ code: "forbidden" });
    const actor = await user("alice");
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: false, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    expect((await service.bases(actor)).issues).toContainEqual({ area: "cloud", code: "local_linux_disabled" });
    expect(leases).toBe(0);
  });
  test("admin inventory preserves unknown totals, marks ineligible folders, and never returns token", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "groups/logical", 99, 99);
    await sql`INSERT INTO auth.groups(name,provider,gid_number) VALUES('logical','local',NULL)`;
    const result = await service.admin(admin, { area: "cloud", kind: "groups", after: "fs:" });
    expect(result.root?.bytes).toBeNull();
    expect(result.items[0]?.reason).toBe("identity_ineligible");
    expect(JSON.stringify(result)).not.toContain("backend-test-secret");
    expect("token" in result.configuration).toBeFalse();
  });
  test("IPA user can read an adopted local POSIX group but loses it immediately when membership is removed", async () => {
    const actor = await user("alice", "ipa");
    const admin = await user("admin", "local", true);
    directory("freeipa", "users/alice");
    directory("cloud", "groups/team", 99, 99);
    directory("cloud", "groups/team/file", 99, 99, "0600", false);
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES('team','local',200003) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    const base = await service.adopt(admin, { area: "cloud", kind: "groups", identityId: group!.id });
    expect((await service.download(actor, { baseId: base.id, path: "file" })).method).toBe("GET");
    await sql`DELETE FROM auth.user_groups_v2`;
    await expect(service.download(actor, { baseId: base.id, path: "file" })).rejects.toMatchObject({ code: "not_found" });
  });
});
