import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { RequestActor } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, type Node } from "@k2b/filegate";
import { sql } from "bun";
import { z } from "zod";
import { bindings } from "../data/bases";
import { migrate } from "../migrate";
import { createFilesService } from ".";

const url = process.env.FILESV2_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Files service and durable bindings", () => {
  const nodes = new Map<string, Node>();
  const defaults = new Map<string, unknown>();
  let lostMoveResponse = false;
  let failMove = false;
  let leases = 0;
  let reconciliations = 0;
  let config = {
    url: "http://filegate:4000",
    token: "backend-test-secret",
    tokenConfigured: true,
    cloud: {
      autoCreate: false,
      autoArchive: true,
      enabled: true,
      root: "cloud",
      prefix: "",
      homes: "users",
      groups: "groups",
      archive: "archive",
    },
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
      const body = z
        .object({
          path: z.string().optional(),
          targetRoot: z.string().optional(),
          targetPath: z.string().optional(),
          ownership: z.object({ uid: z.number().optional(), gid: z.number().optional(), dirMode: z.string().optional() }).optional(),
          acl: z.object({ default: z.unknown().optional() }).optional(),
        })
        .parse(init?.body ? JSON.parse(String(init.body)) : {});
      if (operation === "directories" && init?.method === "POST") {
        const target = body.path!;
        if (nodes.has(`${root}:${target}`)) return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
        const made = directory(root, target, body.ownership?.uid ?? 0, body.ownership?.gid ?? 0, body.ownership?.dirMode ?? "0755");
        if (body.acl?.default) defaults.set(`${root}:${target}`, body.acl.default);
        return Response.json(made);
      }
      if (operation === "transfers") {
        if (failMove) {
          failMove = false;
          throw new Error("unavailable");
        }
        const source = body.path!;
        const target = body.targetPath!;
        const original = nodes.get(`${root}:${source}`);
        if (!original) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (nodes.has(`${root}:${target}`)) return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
        for (const [key, node] of [...nodes])
          if (node.root === root && (node.path === source || node.path.startsWith(source + "/"))) {
            nodes.delete(key);
            const updated = { ...node, path: target + node.path.slice(source.length) };
            nodes.set(`${root}:${updated.path}`, updated);
          }
        if (lostMoveResponse) {
          lostMoveResponse = false;
          failMove = false;
          throw new Error("lost_response");
        }
        return Response.json(nodes.get(`${root}:${target}`));
      }
      const path = req.searchParams.get("path") ?? ".";
      if (operation === "files" && init?.method === "DELETE") {
        for (const [key, node] of [...nodes])
          if (node.root === root && (node.path === path || node.path.startsWith(path + "/"))) nodes.delete(key);
        return new Response(null, { status: 204 });
      }
      const node = nodes.get(`${root}:${path}`);
      if (!node) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
      if (operation === "acl") {
        if (req.searchParams.get("scope") === "default") return Response.json(defaults.get(`${root}:${path}`) ?? { entries: [] });
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
      if (operation === "entries") {
        const items = [...nodes.values()]
          .filter((item) => item.root === root && item.path.startsWith(`${path}/`) && !item.path.slice(path.length + 1).includes("/"))
          .sort((a, b) => a.path.localeCompare(b.path));
        const offset = Number((req.searchParams.get("after") ?? "cursor:0").slice(7));
        const limit = Number(req.searchParams.get("limit") ?? 50);
        return Response.json({
          items: items.slice(offset, offset + limit),
          next: offset + limit < items.length ? `cursor:${offset + limit}` : undefined,
        });
      }
      return Response.json(node);
    },
    { preconnect: fetch.preconnect },
  );
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      async reconcile(...args: Parameters<typeof accountIdentities.reconcile>) {
        reconciliations++;
        return accountIdentities.reconcile(...args);
      },
    },
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
    await sql`CREATE SCHEMA IF NOT EXISTS audit`.simple();
    await sql`CREATE TABLE IF NOT EXISTS audit.events(id bigserial primary key,action text,outcome text,actor_user_id uuid,actor_uid text,actor_provider text,actor_roles text[],target_type text,target_id text,target_label text,target_provider text,reason text,error_code text,error_message text,request_id text,metadata jsonb)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups(user_id uuid,group_name text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.operations,filesv2.maintenance,filesv2.bases,audit.events,auth.users,auth.user_posix,auth.groups,auth.user_groups_v2,auth.group_groups_v2,auth.ipa_user_effective_groups,settings.entries CASCADE`.simple();
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    await set("freeipa.enable", true);
    config.cloud.enabled = true;
    config.freeipa.enabled = true;
    config.cloud.autoCreate = false;
    config.cloud.autoArchive = true;
    defaults.clear();
    lostMoveResponse = false;
    failMove = false;
    nodes.clear();
    leases = 0;
    reconciliations = 0;
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
  test("summary reads skip directory reconciliation and retain unknown root statistics", async () => {
    const admin = await user("admin", "local", true);
    const result = await service.admin(admin, { area: "freeipa", kind: "users", includeEntries: "false" });
    expect(result.items).toEqual([]);
    expect(result.next).toBeNull();
    expect(result.root?.bytes).toBeNull();
    expect(reconciliations).toBe(0);
  });
  test("slow FreeIPA inventory returns unknown with a continuation instead of waiting for the upstream timeout", async () => {
    const admin = await user("admin", "local", true);
    await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const slowService = createFilesService({
      identities: {
        ...accountIdentities,
        async reconcile(_actor, input) {
          if (!input.signal) throw new Error("Inventory must supply its cancellation signal");
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else input.signal!.addEventListener("abort", () => resolve(), { once: true });
          });
          return { state: "unknown", reason: "provider_unavailable" };
        },
      },
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {
        throw new Error("Unexpected configuration write");
      },
      connect: (configuration) => new Filegate({ baseUrl: configuration.url, token: configuration.token, fetch: transport }),
    });
    const result = await slowService.admin(admin, { area: "freeipa", kind: "users" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: "alice",
      status: "unknown",
      reason: "identity_unknown",
      actions: { create: false, archive: false, delete: false },
    });
    expect(result.next).not.toBeNull();
    expect(nodes.has("freeipa:users/alice")).toBeTrue();
  }, 10_000);
  test("filtered inventory finds identities beyond the first source page", async () => {
    const admin = await user("admin", "local", true);
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
      SELECT ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'other-'||i,'local','user',false FROM generate_series(1,60) AS i`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
      VALUES('ffffffff-ffff-4fff-bfff-fffffffffffe','needle','local','user',false)`;
    const result = await service.admin(admin, { area: "cloud", kind: "users", q: "needle", status: "missing" });
    expect(result.items.map((item) => item.name)).toEqual(["needle"]);
    expect(result.next).toBeNull();
  });
  test("inventory cursors resume partial filesystem pages without losing or duplicating entries", async () => {
    const admin = await user("admin", "local", true);
    for (let i = 0; i < 24; i++) await user(`known-${i}`);
    for (let i = 0; i < 70; i++) directory("cloud", `users/orphan-${String(i).padStart(3, "0")}`);
    const names: string[] = [];
    let after: string | undefined;
    let partialFilesystemPage = false;
    for (let pages = 0; pages < 10; pages++) {
      const page = await service.admin(admin, { area: "cloud", kind: "users", after });
      expect(page.items.length).toBeLessThanOrEqual(50);
      names.push(...page.items.map((item) => item.name));
      if (page.next?.startsWith("fs:") && page.next !== "fs:") {
        const [, offset] = JSON.parse(Buffer.from(page.next.slice(3), "base64url").toString());
        partialFilesystemPage ||= offset > 0;
      }
      after = page.next ?? undefined;
      if (!after) break;
    }
    expect(after).toBeUndefined();
    expect(partialFilesystemPage).toBeTrue();
    expect(names).toHaveLength(95);
    expect(new Set(names).size).toBe(95);
  }, 30_000);
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
  test("auto provision is opt-in and retire prevents silent recreation", async () => {
    const admin = await user("admin", "local", true);
    expect((await service.bases(admin)).items[0]?.status).toBe("missing");
    config.cloud.autoCreate = true;
    expect((await service.bases(admin)).items[0]?.status).toBe("existing");
    expect(nodes.get("cloud:users/admin")?.mode).toBe("0700");
    await service.retire(admin, { area: "cloud", kind: "users", name: "admin" });
    nodes.delete("cloud:users/admin");
    expect((await service.bases(admin)).items[0]?.status).toBe("retired");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
  });
  test("archive journal survives lost move response, restores without changing ownership and forbids old-name reuse", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    directory("cloud", "users/admin/file", 0, 0, "0600", false);
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    lostMoveResponse = true;
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "admin" });
    expect(archived.state).toBe("complete");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
    const [journal] = await sql<{ snapshot: Node }[]>`SELECT snapshot FROM filesv2.operations WHERE id=${archived.id}::uuid`;
    expect(journal!.snapshot.uid).toBe(0);
    const archive = await service.archives(admin, { area: "cloud" });
    expect(archive.items[0]?.state).toBe("archived");
    await service.adminDelete(admin, { area: "cloud", archiveId: archived.id, path: "file", confirmPath: archived.path + "/file" });
    const [base] = await sql<{ lifecycle: string }[]>`SELECT lifecycle FROM filesv2.bases WHERE identity_id=${id(admin)}::uuid`;
    expect(base?.lifecycle).toBe("archived");
    await service.restore(admin, archived.id, { confirmPath: "users/admin" });
    expect(nodes.get("cloud:users/admin")?.mode).toBe("0700");
    expect((await service.bases(admin)).items[0]?.status).toBe("existing");
  });
  test("maintenance archives only proven removed users and explicit logical groups, never guest conversion or renamed identity", async () => {
    const admin = await user("admin", "local", true);
    const removed = await user("removed");
    const guest = await user("guest");
    const renamed = await user("renamed");
    for (const [name, actor] of [
      ["removed", removed],
      ["guest", guest],
      ["renamed", renamed],
    ] as const) {
      directory("cloud", `users/${name}`, 0, 0, "0700");
      await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) });
    }
    await sql`DELETE FROM auth.users WHERE id=${id(removed)}::uuid`;
    await sql`UPDATE auth.users SET profile='guest' WHERE id=${id(guest)}::uuid`;
    await sql`UPDATE auth.users SET uid='new-name' WHERE id=${id(renamed)}::uuid`;
    const totals = await service.maintain();
    expect(totals.archived).toBe(1);
    expect(nodes.has("cloud:users/removed")).toBeFalse();
    expect(nodes.has("cloud:users/guest")).toBeTrue();
    expect(nodes.has("cloud:users/renamed")).toBeTrue();
  });
  test("permanent deletion requires exact confirmation and service admin authorization", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await expect(
      service.deleteDirectory(actor, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" }),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "alice" }),
    ).rejects.toMatchObject({ code: "confirmation_mismatch" });
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" });
    expect(nodes.has("cloud:users/alice")).toBeFalse();
  });
  test("pending archive recovery refuses recreated source and changed server, then completes durable intent", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await sql`ALTER TABLE filesv2.operations ADD CONSTRAINT test_pause_finish CHECK (state<>'complete')`.simple();
    try {
      await expect(service.archive(admin, { area: "cloud", kind: "users", name: "admin" })).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE filesv2.operations DROP CONSTRAINT test_pause_finish`.simple();
    }
    const [pending] = await sql<
      { id: string; target: string; state: string }[]
    >`SELECT id,target,state FROM filesv2.operations WHERE action='archive'`;
    expect(pending?.state).toBe("pending");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
    directory("cloud", "users/admin", 0, 0, "0700");
    await expect(service.retry(admin, pending!.id)).rejects.toMatchObject({ code: "path_conflict" });
    expect(nodes.has("cloud:users/admin")).toBeTrue();
    nodes.delete("cloud:users/admin");
    config.url = "http://another-filegate:4000";
    await expect(service.retry(admin, pending!.id)).rejects.toMatchObject({ code: "configuration_changed" });
    config.url = "http://filegate:4000";
    expect((await service.retry(admin, pending!.id)).state).toBe("complete");
    expect((await service.retry(admin, pending!.id)).state).toBe("complete");
  });
  test("per-action archive destinations stay separate from active trees and survive default changes", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await expect(
      service.archive(admin, { area: "cloud", kind: "users", name: "admin", archivePath: "users/archived" }),
    ).rejects.toMatchObject({ code: "overlapping_paths" });
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "admin", archivePath: "retained/2026" });
    expect(archived.path.startsWith("retained/2026/")).toBeTrue();
    config.cloud.archive = "archive-new";
    expect((await service.archives(admin, { area: "cloud" })).items[0]?.canRestore).toBeTrue();
    await service.restore(admin, archived.id, { confirmPath: "users/admin" });
    expect(nodes.has("cloud:users/admin")).toBeTrue();
    config.cloud.archive = "archive";
  });
  test("whole-directory deletion retains known identity before optional auto-provisioning can recreate it", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" });
    config.cloud.autoCreate = true;
    expect((await service.bases(actor)).items[0]?.status).toBe("retired");
    expect(nodes.has("cloud:users/alice")).toBeFalse();
    await expect(service.provision(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({
      code: "retired",
    });
  });
  test("unknown orphan deletion leaves a path tombstone for a later same-name account", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/old-owner", 0, 0, "0700");
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "old-owner", confirmPath: "users/old-owner" });
    const actor = await user("old-owner");
    config.cloud.autoCreate = true;
    expect((await service.bases(actor)).items[0]?.status).toBe("retired");
    await expect(service.provision(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({
      code: "retired",
    });
    directory("cloud", "users/old-owner", 0, 0, "0700");
    await expect(service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({ code: "retired" });
  });
  test("repeating the original restore action rechecks identity eligibility before replaying a pending move", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) });
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "alice" });
    failMove = true;
    await expect(service.restore(admin, archived.id, { confirmPath: "users/alice" })).rejects.toThrow();
    await sql`UPDATE auth.users SET profile='guest' WHERE id=${id(actor)}::uuid`;
    await expect(service.restore(admin, archived.id, { confirmPath: "users/alice" })).rejects.toMatchObject({
      code: "identity_incomplete",
    });
    expect(nodes.has("cloud:users/alice")).toBeFalse();
    expect(nodes.has(`cloud:${archived.path}`)).toBeTrue();
  });
});
