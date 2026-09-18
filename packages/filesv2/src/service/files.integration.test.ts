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
  let sessionCounter = 0;
  let versionCounter = 0;
  const versions = new Map<string, Array<{ id: string; fileId: string; created: string; size: number; pinned: boolean; metadata?: Record<string, unknown>; copyMode: string; content: string }>>();
  const archives: Array<Array<{ root: string; path: string; archivePath: string }>> = [];
  let lostCommitResponse = false;
  const sessions = new Map<string, { id: string; root: string; path: string; size: number; received: number; state: string; ownership?: unknown; result?: Node }>();
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
      if (req.pathname === "/v1/downloads/archives") {
        const input = z.object({ items: z.array(z.object({ root: z.string(), path: z.string(), archivePath: z.string() })) }).parse(JSON.parse(String(init?.body)));
        archives.push(input.items);
        return Response.json({ url: "http://localhost:4000/archive", method: "POST", expires: "2099-01-01T00:00:00Z", manifest: "signed" });
      }
      const root = parts[3]!;
      const operation = parts[4];
      if (!operation)
        return Response.json({
          name: root,
          index: { enabled: root === "cloud" },
          versioning: { enabled: root === "cloud" },
          stats: null,
          versions: 0,
          versionBytes: 0,
          activeUploads: 0,
          available: 1000,
          capacity: 2000,
        });
      if (operation === "downloads" || operation === "thumbnail") {
        leases++;
        return Response.json({ method: "GET", url: "http://localhost:4000/signed", expires: "2099-01-01T00:00:00Z" });
      }
      if (operation === "uploads") {
        const sessionId = parts[6];
        const action = parts[7];
        const input = z
          .object({ path: z.string().optional(), size: z.number().optional(), onConflict: z.string().optional(), ownership: z.unknown().optional() })
          .parse(init?.body ? JSON.parse(String(init.body)) : {});
        if (!sessionId) {
          if (nodes.has(`${root}:${input.path}`) && input.onConflict !== "overwrite")
            return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const id = `session-${++sessionCounter}`;
          sessions.set(id, { id, root, path: input.path!, size: input.size!, received: 0, state: "open", ownership: input.ownership });
          return Response.json({
            session: { id, root, path: input.path, size: input.size, chunkSize: 4, expires: "2099-01-01T00:00:00Z", state: "open", segments: {}, received: 0 },
            lease: { url: `http://localhost:4000/lease/${id}`, expires: "2099-01-01T00:00:00Z", operations: ["status", "write", "abort"] },
          });
        }
        const session = sessions.get(sessionId);
        if (!session) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (action === "lease") return Response.json({ url: `http://localhost:4000/lease/${sessionId}/renewed`, expires: "2099-01-01T00:00:00Z", operations: ["status", "write"] });
        if (action === "commit") {
          if (session.state !== "open") return Response.json({ error: "conflict", message: "closed" }, { status: 409 });
          const ownership = z.object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional() }).parse(session.ownership ?? {});
          const node = { ...directory(root, session.path, ownership.uid ?? 0, ownership.gid ?? 0, ownership.mode ?? "0644", false), size: session.size };
          nodes.set(`${root}:${session.path}`, node);
          session.state = "committed";
          session.result = node;
          if (lostCommitResponse) {
            lostCommitResponse = false;
            throw new Error("lost_response");
          }
          return Response.json(node);
        }
        if (init?.method === "DELETE") {
          session.state = "aborted";
          return new Response(null, { status: 204 });
        }
        return Response.json({ ...session, chunkSize: 4, expires: "2099-01-01T00:00:00Z", segments: {} });
      }
      const body = z
        .object({
          path: z.string().optional(),
          targetRoot: z.string().optional(),
          targetPath: z.string().optional(),
          ownership: z.object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional(), dirMode: z.string().optional() }).optional(),
          acl: z.object({ default: z.unknown().optional() }).optional(),
          move: z.boolean().optional(),
          onConflict: z.string().optional(),
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
        const targetRoot = body.targetRoot ?? root;
        let target = body.targetPath!;
        const original = nodes.get(`${root}:${source}`);
        if (!original) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (nodes.has(`${targetRoot}:${target}`)) {
          if (body.onConflict !== "rename") return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const dot = body.targetPath!.slice(body.targetPath!.lastIndexOf("/") + 1).lastIndexOf(".");
          const stem = dot > 0 ? body.targetPath!.slice(0, body.targetPath!.length - (body.targetPath!.slice(body.targetPath!.lastIndexOf("/") + 1).length - dot)) : body.targetPath!;
          const ext = dot > 0 ? body.targetPath!.slice(stem.length) : "";
          for (let i = 1; nodes.has(`${targetRoot}:${target}`); i++) target = `${stem}-${String(i).padStart(2, "0")}${ext}`;
        }
        for (const [key, node] of [...nodes])
          if (node.root === root && (node.path === source || node.path.startsWith(source + "/"))) {
            if (body.move !== false) nodes.delete(key);
            const updated = {
              ...node,
              root: targetRoot,
              path: target + node.path.slice(source.length),
              ...(body.move === false && body.ownership ? { uid: body.ownership.uid ?? node.uid, gid: body.ownership.gid ?? node.gid, mode: node.directory ? (body.ownership.dirMode ?? node.mode) : (body.ownership.mode ?? node.mode) } : {}),
            };
            nodes.set(`${targetRoot}:${updated.path}`, updated);
          }
        if (body.move === false) return Response.json(nodes.get(`${targetRoot}:${target}`));
        if (lostMoveResponse) {
          lostMoveResponse = false;
          failMove = false;
          throw new Error("lost_response");
        }
        return Response.json(nodes.get(`${targetRoot}:${target}`));
      }
      const path = req.searchParams.get("path") ?? ".";
      if (operation === "versions") {
        const versionId = parts[5];
        const action = parts[6];
        // Direct version downloads carry the path in the body instead of the query.
        const vpath = req.searchParams.get("path") ?? (z.object({ path: z.string() }).parse(JSON.parse(String(init?.body ?? "{}"))).path);
        const fileVersions = () => versions.get(`${root}:${vpath}`) ?? [];
        if (!versionId) {
          if (init?.method === "POST") {
            const options = z.object({ pinned: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(init.body ? JSON.parse(String(init.body)) : {});
            const version = { id: `v${++versionCounter}`, fileId: "file", created: new Date().toISOString(), size: nodes.get(`${root}:${vpath}`)?.size ?? 0, pinned: options.pinned ?? false, metadata: options.metadata, copyMode: "copy", content: `content-of-${nodes.get(`${root}:${vpath}`)?.modified}` };
            versions.set(`${root}:${vpath}`, [version, ...fileVersions()]);
            return Response.json(version, { status: 201 });
          }
          return Response.json(fileVersions());
        }
        const version = fileVersions().find((item) => item.id === versionId);
        if (!version) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (action === "restore") {
          const node = nodes.get(`${root}:${vpath}`)!;
          const snapshot = { ...version, id: `v${++versionCounter}`, metadata: undefined, created: new Date().toISOString(), content: `content-of-${node.modified}` };
          versions.set(`${root}:${vpath}`, [snapshot, ...fileVersions()]);
          const restored = { ...node, modified: `restored:${version.id}` };
          nodes.set(`${root}:${vpath}`, restored);
          return Response.json(restored);
        }
        if (action === "downloads") {
          leases++;
          return Response.json({ method: "GET", url: `http://localhost:4000/signed/${versionId}`, expires: "2099-01-01T00:00:00Z" });
        }
        if (init?.method === "PATCH") {
          const options = z.object({ pinned: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(String(init.body)));
          Object.assign(version, { pinned: options.pinned ?? version.pinned, metadata: options.metadata });
          return Response.json(version);
        }
        if (init?.method === "DELETE") {
          versions.set(`${root}:${vpath}`, fileVersions().filter((item) => item.id !== versionId));
          return new Response(null, { status: 204 });
        }
        return Response.json(version);
      }
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
      if (operation === "search") {
        const q = req.searchParams.get("q")!.toLowerCase();
        const scanned = [...nodes.values()].filter((item) => item.root === root && item.path.startsWith(`${path}/`));
        if (scanned.length > Number(req.searchParams.get("maxEntries") ?? 0))
          return Response.json({ error: "limit_exceeded", message: "limit exceeded" }, { status: 413 });
        const items = scanned.filter((item) => item.path.split("/").at(-1)!.toLowerCase().includes(q)).sort((a, b) => a.path.localeCompare(b.path));
        return Response.json({ items, next: undefined });
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
    sessions.clear();
    versions.clear();
    archives.length = 0;
    lostCommitResponse = false;
    await sql`TRUNCATE filesv2.trash,filesv2.uploads,filesv2.operations,filesv2.maintenance,filesv2.bases,audit.events,auth.users,auth.user_posix,auth.groups,auth.user_groups_v2,auth.group_groups_v2,auth.ipa_user_effective_groups,settings.entries CASCADE`.simple();
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
  test("search hides trash and unreadable FreeIPA hits and reports scan limits", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Reports");
    directory("freeipa", "users/alice/Reports/q3-report.pdf", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Private", 999, 999, "0700");
    directory("freeipa", "users/alice/Private/secret-report.txt", 999, 999, "0600", false);
    directory("freeipa", "users/alice/trash");
    directory("freeipa", "users/alice/trash/old-report.txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const result = await service.search(actor, { baseId, q: "report" });
    expect(result.query).toBe("report");
    expect(result.items.map((item) => item.path)).toEqual(["Reports", "Reports/q3-report.pdf"]);
    expect((await service.search(actor, { baseId, path: "Reports", q: "REPORT" })).items).toHaveLength(1);
    await expect(service.search(actor, { baseId, path: "trash", q: "old" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.search(actor, { baseId, path: "Private", q: "secret" })).rejects.toMatchObject({ code: "forbidden" });
    for (let i = 0; i < 10_001; i++) directory("freeipa", `users/alice/Reports/bulk-${i}.txt`, 1001, 2001, "0640", false);
    await expect(service.search(actor, { baseId, path: "Reports", q: "bulk" })).rejects.toMatchObject({ code: "search_limited" });
  });
  test("mkdir requires write access to the parent, keeps user ownership and rejects reserved or existing paths", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/ReadOnly", 999, 2001, "0750");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const created = await service.mkdir(actor, { baseId, path: "Projects" });
    expect(created.entry).toMatchObject({ name: "Projects", path: "Projects", directory: true });
    expect(nodes.get("freeipa:users/alice/Projects")).toMatchObject({ uid: 1001, gid: 2001, mode: "0700" });
    expect((await service.mkdir(actor, { baseId, path: "Projects/2026" })).entry.path).toBe("Projects/2026");
    await expect(service.mkdir(actor, { baseId, path: "Projects" })).rejects.toMatchObject({ status: 409 });
    await expect(service.mkdir(actor, { baseId, path: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.mkdir(actor, { baseId, path: "trash/keep" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.mkdir(actor, { baseId, path: "ReadOnly/new" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.mkdir(actor, { baseId, path: "Missing/new" })).rejects.toMatchObject({ code: "not_found" });
    const admin = await user("admin", "local", true);
    config.cloud.autoCreate = true;
    const cloudBase = (await service.bases(admin)).items.find((base) => base.area === "cloud")!.id;
    await service.mkdir(admin, { baseId: cloudBase, path: "Notes" });
    expect(nodes.get("cloud:users/admin/Notes")).toMatchObject({ mode: "0700" });
  });
  test("uploads open a bound Filegate session and publish only after the owner commits a complete transfer", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Reports");
    directory("freeipa", "users/alice/existing.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/ReadOnly", 999, 2001, "0750");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const opened = await service.upload(actor, { baseId, path: "Reports/new.txt", size: 12, onConflict: "error" });
    expect(opened).toMatchObject({ path: "Reports/new.txt", size: 12, chunkSize: 4, url: `http://localhost:4000/lease/${opened.id}` });
    expect(sessions.get(opened.id)?.ownership).toEqual({ uid: 1001, gid: 2001, mode: "0600" });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_incomplete" });
    sessions.get(opened.id)!.received = 12;
    expect((await service.uploadLease(actor, { baseId, id: opened.id })).url).toContain("renewed");
    const committed = await service.commitUpload(actor, { baseId, id: opened.id });
    expect(committed.entry).toMatchObject({ path: "Reports/new.txt", size: 12, directory: false });
    expect(nodes.get("freeipa:users/alice/Reports/new.txt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
    // Repeating the commit is idempotent and no longer talks to Filegate.
    sessions.delete(opened.id);
    expect((await service.commitUpload(actor, { baseId, id: opened.id })).entry.path).toBe("Reports/new.txt");
    await expect(service.uploadLease(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_closed" });
    // Existing names are only replaced when the client asks for it.
    await expect(service.upload(actor, { baseId, path: "existing.txt", size: 1, onConflict: "error" })).rejects.toMatchObject({ status: 409 });
    const replace = await service.upload(actor, { baseId, path: "existing.txt", size: 1, onConflict: "overwrite" });
    expect(replace.path).toBe("existing.txt");
    await expect(service.upload(actor, { baseId, path: "Reports", size: 1, onConflict: "overwrite" })).rejects.toMatchObject({ code: "not_file" });
    await expect(service.upload(actor, { baseId, path: "ReadOnly/x.txt", size: 1, onConflict: "error" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.upload(actor, { baseId, path: "trash/x.txt", size: 1, onConflict: "error" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.upload(actor, { baseId, path: "huge.bin", size: 5000, onConflict: "error" })).rejects.toMatchObject({ code: "insufficient_space" });
    // Another user cannot commit, renew or abort a session they did not open.
    const bob = await user("bob", "ipa");
    directory("freeipa", "users/bob");
    await expect(service.commitUpload(bob, { baseId, id: replace.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.abortUpload(bob, { baseId, id: replace.id })).rejects.toMatchObject({ code: "not_found" });
    await service.abortUpload(actor, { baseId, id: replace.id });
    expect(sessions.get(replace.id)?.state).toBe("aborted");
    await expect(service.commitUpload(actor, { baseId, id: replace.id })).rejects.toMatchObject({ code: "upload_closed" });
    await service.abortUpload(actor, { baseId, id: replace.id });
  });
  test("a commit whose response was lost is recovered from the Filegate session record", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const opened = await service.upload(actor, { baseId, path: "lost.txt", size: 0, onConflict: "error" });
    lostCommitResponse = true;
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toThrow("lost_response");
    const recovered = await service.commitUpload(actor, { baseId, id: opened.id });
    expect(recovered.entry).toMatchObject({ path: "lost.txt", size: 0 });
    const gone = await service.upload(actor, { baseId, path: "expired.txt", size: 2, onConflict: "error" });
    sessions.get(gone.id)!.state = "expired";
    await expect(service.commitUpload(actor, { baseId, id: gone.id })).rejects.toMatchObject({ code: "upload_closed" });
  });
  test("rename, move and duplicate stay inside the base, need a writable parent and never touch trash", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/a.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Archive", 999, 2001, "0750");
    directory("freeipa", "users/alice/Archive/old.txt", 999, 2001, "0640", false);
    directory("freeipa", "users/alice/trash");
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.rename(actor, { baseId, path: "Docs/a.txt", name: "b.txt" })).entry.path).toBe("Docs/b.txt");
    await expect(service.rename(actor, { baseId, path: "Docs/b.txt", name: "../x.txt" })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(service.rename(actor, { baseId, path: "Docs", name: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.rename(actor, { baseId, path: "Archive/old.txt", name: "new.txt" })).rejects.toMatchObject({ code: "forbidden" });
    const moved = await service.move(actor, { baseId, paths: ["Docs/b.txt"], folder: "" });
    expect(moved.entries.map((entry) => entry.path)).toEqual(["b.txt"]);
    await expect(service.move(actor, { baseId, paths: ["Docs"], folder: "Docs" })).rejects.toMatchObject({ code: "move_into_self" });
    await expect(service.move(actor, { baseId, paths: ["b.txt"], folder: "Archive" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.move(actor, { baseId, paths: ["b.txt"], folder: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    const duplicated = await service.copy(actor, { baseId, paths: ["b.txt"], targetBaseId: baseId, folder: "" });
    expect(duplicated.entries[0]!.path).toBe("b-01.txt");
    expect(nodes.get("freeipa:users/alice/b-01.txt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
  });
  test("copies may cross bases but moves never leave a base", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/private.txt", 1001, 2001, "0640", false);
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups(name,provider,gid_number) VALUES('team','ipa',2002) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    await sql`INSERT INTO auth.ipa_user_effective_groups VALUES(${id(actor)},'team')`;
    directory("freeipa", "groups/team", 10001, 2002, "2770");
    directory("freeipa", "groups/team/shared.txt", 999, 2002, "0660", false);
    const bases = (await service.bases(actor)).items;
    const home = bases.find((base) => base.kind === "users")!.id;
    const team = bases.find((base) => base.kind === "groups")!.id;
    expect(group).toBeTruthy();
    const copied = await service.copy(actor, { baseId: home, paths: ["private.txt"], targetBaseId: team, folder: "" });
    expect(copied.base.id).toBe(team);
    expect(nodes.get("freeipa:groups/team/private.txt")).toMatchObject({ uid: 1001, gid: 2002, mode: "0660" });
    expect(nodes.has("freeipa:users/alice/private.txt")).toBeTrue();
    // The service has no cross-base move; a target folder always belongs to the source base.
    await expect(service.move(actor, { baseId: team, paths: ["shared.txt"], folder: "../../users/alice" })).rejects.toThrow();
    expect(nodes.has("freeipa:groups/team/shared.txt")).toBeTrue();
  });
  test("deleting moves entries into trash with a restorable record", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/note.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/note (1).txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const removed = await service.remove(actor, { baseId, paths: ["Docs/note.txt"] });
    expect(removed[0]).toMatchObject({ original: "Docs/note.txt", name: "note.txt", directory: false });
    expect(nodes.has("freeipa:users/alice/Docs/note.txt")).toBeFalse();
    expect(nodes.get("freeipa:users/alice/trash")).toMatchObject({ uid: 1001, gid: 2001, mode: "0700" });
    expect(nodes.has("freeipa:users/alice/trash/note.txt")).toBeTrue();
    expect((await service.list(actor, { baseId, path: "" })).items.map((item) => item.name)).toEqual(["Docs"]);
    const listed = await service.trash(actor, { baseId });
    expect(listed.entries.map((entry) => entry.original)).toEqual(["Docs/note.txt"]);
    await expect(service.remove(actor, { baseId, paths: ["trash/note.txt"] })).rejects.toMatchObject({ code: "reserved_path" });
    // A second delete of the same name lands beside the first, and restoring requires a free original path.
    directory("freeipa", "users/alice/Docs/note.txt", 1001, 2001, "0640", false);
    await service.remove(actor, { baseId, paths: ["Docs/note.txt"] });
    expect(nodes.has("freeipa:users/alice/trash/note-01.txt")).toBeTrue();
    const restored = await service.restoreTrash(actor, { baseId, id: removed[0]!.id });
    expect(restored.entry.path).toBe("Docs/note.txt");
    await expect(service.restoreTrash(actor, { baseId, id: removed[0]!.id })).rejects.toMatchObject({ code: "not_found" });
    const second = (await service.trash(actor, { baseId })).entries[0]!;
    await expect(service.restoreTrash(actor, { baseId, id: second.id })).rejects.toMatchObject({ status: 409 });
  });
  test("selections download as one signed archive of authorized entries", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/a.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/secret.txt", 999, 999, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const lease = await service.bundle(actor, { baseId, paths: ["Docs", "a.txt"] });
    expect(lease).toMatchObject({ method: "POST", manifest: "signed" });
    expect(archives[0]).toEqual([
      { root: "freeipa", path: "users/alice/Docs", archivePath: "Docs" },
      { root: "freeipa", path: "users/alice/a.txt", archivePath: "a.txt" },
    ]);
    await expect(service.bundle(actor, { baseId, paths: ["a.txt", "secret.txt"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.bundle(actor, { baseId, paths: ["trash"] })).rejects.toMatchObject({ code: "reserved_path" });
    expect(archives).toHaveLength(1);
  });
  test("versions are listed with comments, restored in place or as a copy, and deleted", async () => {
    const admin = await user("admin", "local", true);
    config.cloud.autoCreate = true;
    const baseId = (await service.bases(admin)).items.find((base) => base.area === "cloud")!.id;
    directory("cloud", "users/admin/report.txt", 0, 0, "0600", false);
    expect(await service.versions(admin, { baseId, path: "report.txt" })).toEqual([]);
    const filegate = new Filegate({ baseUrl: "http://filegate:4000", token: "backend-test-secret", fetch: transport }).root("cloud");
    const v1 = await filegate.snapshot("users/admin/report.txt", { metadata: { comment: "first" } });
    const commented = await service.commentVersion(admin, { baseId, path: "report.txt", id: v1.id, comment: "final draft" });
    expect(commented).toMatchObject({ id: v1.id, comment: "final draft", author: "admin" });
    expect((await service.versions(admin, { baseId, path: "report.txt" }))[0]).toMatchObject({ id: v1.id, comment: "final draft" });
    const asCopy = await service.restoreVersionAs(admin, { baseId, path: "report.txt", id: v1.id, name: "report-v1.txt" });
    expect(asCopy.entry.path).toBe("report-v1.txt");
    expect(nodes.get("cloud:users/admin/report-v1.txt")?.modified).toBe(`restored:${v1.id}`);
    // The current file is put back and the helper snapshot is removed again.
    expect(nodes.get("cloud:users/admin/report.txt")?.modified).not.toBe(`restored:${v1.id}`);
    expect((await service.versions(admin, { baseId, path: "report.txt" })).some((version) => version.id === v1.id)).toBeTrue();
    await expect(service.restoreVersionAs(admin, { baseId, path: "report.txt", id: v1.id, name: "report.txt" })).rejects.toMatchObject({ code: "invalid_path" });
    const restored = await service.restoreVersion(admin, { baseId, path: "report.txt", id: v1.id });
    expect(restored.entry.modified).toBe(`restored:${v1.id}`);
    expect((await service.versionDownload(admin, { baseId, path: "report.txt", id: v1.id })).url).toContain(v1.id);
    await service.deleteVersion(admin, { baseId, path: "report.txt", id: v1.id });
    expect((await service.versions(admin, { baseId, path: "report.txt" })).some((version) => version.id === v1.id)).toBeFalse();
    await expect(service.versions(admin, { baseId, path: "trash/x" })).rejects.toMatchObject({ code: "reserved_path" });
  });
  test("detail and thumbnails enforce current leaf rights, traversal and trash before any lease", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/photo.png", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.entry(actor, { baseId, path: "photo.png" })).entry.name).toBe("photo.png");
    expect((await service.thumbnail(actor, { baseId, path: "photo.png", size: "small" })).method).toBe("GET");
    expect(leases).toBe(1);
    directory("freeipa", "users/alice/photo.png", 999, 999, "0600", false);
    await expect(service.entry(actor, { baseId, path: "photo.png" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.thumbnail(actor, { baseId, path: "photo.png", size: "large" })).rejects.toMatchObject({ code: "forbidden" });
    for (const path of ["trash/photo.png", "../other", ""]) {
      await expect(service.entry(actor, { baseId, path })).rejects.toThrow();
      await expect(service.thumbnail(actor, { baseId, path, size: "small" })).rejects.toThrow();
    }
    expect(leases).toBe(1);
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
