import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { UserSchema } from "@k2b/cloud/contracts";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, FilegateError } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor, testInfra } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../core/src/migrate/core/audit";
import type { Configuration } from "../src/contracts";
import { bindings } from "../src/data/bases";
import { withRootLock } from "../src/data/operations";
import { migrate } from "../src/migrate";
import { createFilesService } from "../src/service";
import { assertPrivateDatabase, localFilegateToken } from "./private-database";

// These tests create and remove their own prefix in both roots.
const suite = suiteFor("database", "filegate", "nats");
suite("real Filegate directory lifecycle", () => {
  let processSync: ProcessSync | undefined;
  const prefix = `filesv2-test-${crypto.randomUUID()}`;
  const uid = 31001;
  const gid = 32001;
  let client: Filegate;
  let service: ReturnType<typeof createFilesService>;
  let admin: RequestActor;
  let ipaUser: RequestActor;
  let groupId: string;
  let configuration: Configuration & { token: string; tokenConfigured: boolean };
  const name = (actor: RequestActor) => (actor.kind === "user" ? actor.user.uid : "");
  const id = (actor: RequestActor) => (actor.kind === "user" ? actor.user.id : "");
  const set = async (key: string, value: unknown) => {
    const encrypted = await secrets.encrypt(value);
    await sql`INSERT INTO settings.entries(key,value) VALUES(${key},${encrypted}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  };
  const createUser = async (username: string, provider: "local" | "ipa", isAdmin = false): Promise<RequestActor> => {
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${username},${provider},'user',${isAdmin}) RETURNING id`;
    if (provider === "ipa") await sql`INSERT INTO auth.user_posix VALUES(${row!.id},'ipa',${uid},${gid})`;
    return {
      kind: "user",
      user: UserSchema.parse({
        id: row!.id,
        uid: username,
        provider,
        profile: "user",
        roles: isAdmin ? ["user", "admin"] : ["user"],
        givenname: "Test",
        sn: "",
        displayName: username,
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
                uidNumber: uid,
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
  beforeAll(async () => {
    processSync = await startProcessSync({ application: "filesv2" });
    await assertPrivateDatabase();
    const token = await localFilegateToken();
    client = new Filegate({ baseUrl: testInfra.filegate!, token });
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer,primary_group_id uuid,home_directory text,login_shell text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups(user_id uuid,group_name text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await migrate();
    await migrateAudit();
    await sql`TRUNCATE filesv2.operations,filesv2.bases,filesv2.maintenance,auth.user_groups_v2,auth.user_posix,auth.users,auth.groups,settings.entries CASCADE`.simple();
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    await set("freeipa.enable", true);
    configuration = {
      url: testInfra.filegate!,
      token,
      tokenConfigured: true,
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
      cloud: {
        enabled: true,
        root: "cloud",
        prefix,
        homes: "home",
        groups: "groups",
        archive: "archive",
        autoCreate: false,
        autoArchive: true,
      },
      freeipa: { enabled: true, root: "freeipa", prefix, homes: "home", groups: "groups", archive: "archive" },
    };
    for (const area of ["cloud", "freeipa"] as const) await client.root(area).mkdir(prefix, { ownership: { dirMode: "0755" } });
    admin = await createUser("files-lifecycle-admin", "local", true);
    ipaUser = await createUser("files-lifecycle-user", "ipa");
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES('files-lifecycle-group','ipa',${gid}) RETURNING id`;
    groupId = group!.id;
    // Upstream identity RPC is separately integration-tested by the platform.
    // Filegate, its POSIX filesystem, persistence, and actor checks are real here.
    const identities: typeof accountIdentities = {
      ...accountIdentities,
      async reconcile(actor, input) {
        if (input.provider !== "ipa") return accountIdentities.reconcile(actor, input);
        await accountIdentities.inventory(actor, { kind: "groups", provider: "local" });
        return {
          state: "present",
          identity: { id: null, name: input.name, uidNumber: input.kind === "users" ? uid : null, gidNumber: gid },
          eligible: true,
        };
      },
    };
    service = createFilesService({
      identities,
      displayNames: resolveDisplayNames,
      bindings,
      readConfiguration: async () => configuration,
      writeConfiguration: async (value) => {
        configuration = { ...value, token: value.token || token, tokenConfigured: true };
      },
      connect: () => client,
      publicOrigin: async () => "http://localhost:3000",
      userById: async (userId) => (ipaUser.kind === "user" && ipaUser.user.id === userId ? ipaUser.user : null),
      transfer: fetch,
    });
  }, 30_000);
  afterAll(async () => {
    await processSync?.stop();
    if (client)
      for (const area of ["cloud", "freeipa"] as const) {
        try {
          await client.root(area).remove(prefix, true);
        } catch (error) {
          if (!(error instanceof FilegateError && error.status === 404)) throw error;
        }
      }
  });

  test("FreeIPA provision, inherited rights, private archive, restore and administrator deletion", async () => {
    const root = client.root("freeipa");
    const home = `${prefix}/home/${name(ipaUser)}`;
    const groupPath = `${prefix}/groups/files-lifecycle-group`;
    await service.provision(admin, { area: "freeipa", kind: "users", identityId: id(ipaUser) });
    await service.provision(admin, { area: "freeipa", kind: "groups", identityId: groupId });
    expect(await root.stat(home)).toMatchObject({ uid, gid, mode: "0700", directory: true });
    expect(await root.stat(groupPath)).toMatchObject({ gid, mode: "2770", directory: true });
    expect((await root.getACL(groupPath, "default")).entries).toContainEqual({ tag: "owningGroup", permissions: "rwx" });
    const file = await root.put(`${groupPath}/document.txt`, new Blob(["group document"]));
    expect(file.gid).toBe(gid);
    expect(Number.parseInt(file.mode, 8) & 0o777).toBe(0o660);
    expect(Number.parseInt((await root.mkdir(`${groupPath}/nested`)).mode, 8) & 0o2777).toBe(0o2770);

    const archive = await service.archive(admin, { area: "freeipa", kind: "groups", name: "files-lifecycle-group" });
    expect(archive.state).toBe("complete");
    const wrapper = archive.path.split("/").slice(0, -1).join("/");
    expect(Number.parseInt((await root.stat(wrapper)).mode, 8) & 0o777).toBe(0o700);
    expect((await root.stat(wrapper)).uid).toBe((await root.stat(prefix)).uid);
    expect(await root.stat(archive.path)).toMatchObject({ gid, mode: "2770" });
    const volume = process.env.FILESV2_TEST_FREEIPA_VOLUME;
    if (volume) {
      const readAsMember = Bun.spawnSync([
        "docker",
        "run",
        "--rm",
        "--user",
        `${uid}:${gid}`,
        "--mount",
        `type=volume,src=${volume},dst=/data,readonly`,
        "--entrypoint",
        "cat",
        "oven/bun:1.4.2-alpine",
        `/data/${archive.path}/document.txt`,
      ]);
      expect(readAsMember.exitCode).not.toBe(0);
      expect(readAsMember.stderr.toString()).toContain("Permission denied");
    }
    const entries = await service.adminList(admin, { area: "freeipa", archiveId: archive.id, path: "" });
    expect(entries.items.map((item) => item.name)).toContain("document.txt");
    const lease = await service.adminDownload(admin, { area: "freeipa", archiveId: archive.id, path: "document.txt" });
    expect(await (await fetch(lease.url)).text()).toBe("group document");
    await expect(service.adminList(ipaUser, { area: "freeipa", archiveId: archive.id, path: "" })).rejects.toThrow();
    await expect(service.restore(admin, archive.id, { confirmPath: "wrong" })).rejects.toThrow();
    await root.mkdir(groupPath);
    await expect(service.restore(admin, archive.id, { confirmPath: groupPath })).rejects.toThrow();
    await root.remove(groupPath);
    await service.restore(admin, archive.id, { confirmPath: groupPath });
    expect(await root.stat(groupPath)).toMatchObject({ gid, mode: "2770" });
    expect(await root.getACL(groupPath, "default")).toEqual(await root.getACL(`${groupPath}/nested`, "default"));

    await root.mkdir(`${home}/trash`);
    await root.put(`${home}/trash/removed.txt`, new Blob(["discarded"]));
    const baseId = `freeipa:users:${id(ipaUser)}`;
    expect((await service.list(ipaUser, { baseId })).items.some((item) => item.name === "trash")).toBe(false);
    const trash = await service.adminList(admin, { area: "freeipa", kind: "users", name: name(ipaUser), path: "trash" });
    expect(trash.items[0]?.name).toBe("removed.txt");
    await expect(
      service.adminDelete(admin, { area: "freeipa", kind: "users", name: name(ipaUser), path: "trash/removed.txt", confirmPath: "wrong" }),
    ).rejects.toThrow();
    await service.adminDelete(admin, {
      area: "freeipa",
      kind: "users",
      name: name(ipaUser),
      path: "trash/removed.txt",
      confirmPath: `${home}/trash/removed.txt`,
    });
    expect((await service.bases(ipaUser)).items.find((item) => item.id === baseId)?.status).toBe("existing");
    await service.deleteDirectory(admin, { area: "freeipa", kind: "groups", name: "files-lifecycle-group", confirmPath: groupPath });
    await expect(root.stat(groupPath)).rejects.toThrow();
    const auditEvents = await sql<
      { action: string; outcome: string }[]
    >`SELECT action,outcome FROM audit.events WHERE actor_user_id=${id(admin)}::uuid`;
    for (const action of ["filesv2.archive", "filesv2.restore", "filesv2.delete"])
      expect(auditEvents).toContainEqual({ action, outcome: "allowed" });
  }, 60_000);

  test("WOPI and Markdown publish through real Filegate with stale-save protection on unmanaged storage", async () => {
    configuration.collabora = { url: "http://localhost:9980", internalUrl: "", wopiOrigin: "", documentFormat: "odf" };
    const baseId = `freeipa:users:${id(ipaUser)}`;
    const target = `${prefix}/home/${name(ipaUser)}/Conflict.odt`;
    const root = client.root("freeipa");
    await root.put(target, new Blob(["original"]), { ownership: { uid, gid, mode: "0600" } });
    const launch = await service.editor(ipaUser, { baseId, path: "Conflict.odt" });
    if (launch.kind === "markdown") throw new Error("Expected office editor");
    const fileId = new URL(launch.action).searchParams.get("WOPISrc")!.split("/").at(-1)!;
    const timestamp = (await service.editorFileInfo(launch.token, fileId)).LastModifiedTime;
    const saves = await Promise.allSettled(
      ["writer one", "writer two"].map((value) =>
        service.editorSave(launch.token, fileId, { timestamp, read: async () => new Blob([value]) }),
      ),
    );
    expect(saves.filter((result) => result.status === "fulfilled" && "modified" in result.value)).toHaveLength(1);
    for (const result of saves) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "operation_busy" });
      else if (!("modified" in result.value)) expect(result.value).toEqual({ conflict: true });
    }
    expect(await service.editorSave(launch.token, fileId, { timestamp, read: async () => new Blob(["stale retry"]) })).toEqual({
      conflict: true,
    });
    const current = await root.stat(target);
    const upload = await service.upload(ipaUser, {
      baseId,
      path: "Conflict.odt",
      size: 0,
      onConflict: "overwrite",
      idempotencyKey: crypto.randomUUID(),
      expectedRevision: `fs:${current.modified}:${current.size}`,
    });
    await withRootLock("freeipa", async () => {
      await expect(service.commitUpload(ipaUser, { baseId, id: upload.id })).rejects.toMatchObject({ code: "operation_busy" });
    });
    const saved = await service.editorSave(launch.token, fileId, { timestamp: null, read: async () => new Blob(["confirmed overwrite"]) });
    expect(saved).toHaveProperty("modified");
    await expect(service.commitUpload(ipaUser, { baseId, id: upload.id })).rejects.toMatchObject({ code: "write_conflict" });
    await service.abortUpload(ipaUser, { baseId, id: upload.id });
    expect(await (await root.contentRaw(target)).text()).toBe("confirmed overwrite");
    expect((await service.editorFileInfo(launch.token, fileId)).LastModifiedTime).toBe("modified" in saved ? saved.modified : "");
  }, 60_000);

  test("automatic Cloud creation and archival preserve daemon ownership and suppress reprovisioning", async () => {
    const root = client.root("cloud");
    const user = await createUser("files-lifecycle-local", "local");
    configuration.cloud.autoCreate = true;
    const base = (await service.bases(user)).items.find((item) => item.area === "cloud" && item.kind === "users")!;
    expect(base.status).toBe("existing");
    const daemon = await root.stat(prefix);
    expect(await root.stat(`${prefix}/home/${name(user)}`)).toMatchObject({ uid: daemon.uid, gid: daemon.gid });
    await sql`DELETE FROM auth.users WHERE id=${id(user)}::uuid`;
    expect((await service.maintain()).archived).toBe(1);
    const archives = await service.archives(admin, { area: "cloud", q: name(user) });
    expect(archives.items).toHaveLength(1);
    expect(archives.items[0]?.state).toBe("archived");
    const replacement = await createUser(name(user), "local");
    expect((await service.bases(replacement)).items[0]?.status).toBe("conflict");
    await expect(service.restore(admin, archives.items[0]!.id, { confirmPath: `${prefix}/home/${name(user)}` })).rejects.toThrow();
  }, 30_000);
});
