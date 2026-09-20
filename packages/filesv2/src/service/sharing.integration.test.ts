import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RequestActor } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { type ExecutionIdentity, Filegate, type Node, type Session, type WriteOptions } from "@k2b/filegate";
import { sql } from "bun";
import type { BaseSummary } from "../contracts";
import { type Binding, bindings } from "../data/bases";
import { shares, shareTokenHash } from "../data/shares";
import { migrateSharing } from "../data/sharing-migration";
import { sameUploadExecution, sameUploadOptions, uploads } from "../data/uploads";
import { migrate } from "../migrate";
import { FilesError } from "./errors";
import { createSharingService, type SharingAccess } from "./sharing";

const suite = process.env.FILESV2_SHARING_DATABASE_URL ? describe : describe.skip;
const actor: RequestActor = {
  kind: "user",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    uid: "alice",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Alice",
    sn: "Example",
    displayName: "Alice",
    mail: null,
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
const summary: BaseSummary = {
  id: `cloud:users:${actor.user.id}`,
  name: "alice",
  area: "cloud",
  kind: "users",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const node = (path: string, directory = false): Node => ({
  root: "cloud",
  path,
  directory,
  size: 3,
  modified: "2026-09-19T10:00:00Z",
  uid: 1000,
  gid: 1000,
  mode: directory ? "0700" : "0600",
});

suite("share authority, public privacy and durable inbox budgets", () => {
  let binding: Binding;
  let denied = false;
  let admin = false;
  let inactiveCreator = false;
  let missingReceipts = false;
  let loseCommit = false;
  let loseCreate = false;
  let execution: ExecutionIdentity | null = null;
  const archiveExecutions: Array<ExecutionIdentity | null> = [];
  const keys = new Map<string, string>();
  const createRequests: Array<{ key: string; options: WriteOptions; execution: ExecutionIdentity | null }> = [];
  let commitCalls = 0;
  let commitResultPatch: Partial<Node> | null = null;
  let authorizationCalls = 0;
  const validatedTargets: Array<{ target: string; path: string; root: string; server: string }> = [];
  const deniedPaths = new Set<string>();
  const listCalls: Array<{ path: string | null; after: string | null }> = [];
  const sessions = new Map<string, Session>();
  const config = {
    url: "http://filegate.test:4000",
    token: "test",
    tokenConfigured: true,
    cloud: {
      enabled: true,
      root: "cloud",
      prefix: "",
      homes: "home",
      groups: "groups",
      archive: "archive",
      autoCreate: false,
      autoArchive: true,
    },
    freeipa: { enabled: false, root: "freeipa", prefix: "", homes: "home", groups: "groups", archive: "archive" },
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
  };
  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname;
      if (path === "/v1/roots/cloud" && (!init?.method || init.method === "GET")) return Response.json({ available: 1e9 });
      if (path.endsWith("/entries")) {
        listCalls.push({ path: url.searchParams.get("path"), after: url.searchParams.get("after") });
        return Response.json({ items: [node("home/alice/Docs/public.txt"), node("home/alice/Docs/private.txt")], next: "next-page" });
      }
      if (path === "/v1/downloads/archives") {
        const identity = new Headers(init?.headers).get("X-Filegate-Execution");
        archiveExecutions.push(identity ? JSON.parse(identity) : null);
        return Response.json({ url: "http://filegate.test/direct/archive", expires: "2099-01-01T00:00:00Z", manifest: { items: [] } });
      }
      if (path.endsWith("/downloads/direct"))
        return Response.json({ url: "http://filegate.test/direct/read", expires: "2099-01-01T00:00:00Z" });
      if (path.endsWith("/sessions") && init?.method === "POST") {
        const {
          path,
          size,
          idempotencyKey,
          expiresIn: _expires,
          allowAbort: _abort,
          ...options
        } = JSON.parse(String(init.body)) as WriteOptions & {
          path: string;
          size: number;
          idempotencyKey: string;
          expiresIn?: number;
          allowAbort?: boolean;
        };
        const identity = new Headers(init.headers).get("X-Filegate-Execution");
        const scope: ExecutionIdentity | null = identity ? JSON.parse(identity) : null;
        createRequests.push({ key: idempotencyKey, options, execution: scope });
        let session = sessions.get(keys.get(idempotencyKey) ?? "");
        if (
          session &&
          (session.path !== path ||
            session.size !== size ||
            !sameUploadOptions(session.options, options) ||
            !sameUploadExecution(session.execution ?? null, scope))
        )
          return Response.json({ code: "conflict", error: "changed binding" }, { status: 409 });
        if (!session) {
          const id = randomUUID();
          session = {
            id,
            root: "cloud",
            path,
            size,
            chunkSize: 8 * 1024 * 1024,
            received: size,
            expires: new Date(Date.now() + 86_400_000).toISOString(),
            uploadedSegments: size ? 1 : 0,
            state: "open",
            options,
            ...(scope ? { execution: scope } : {}),
          };
          sessions.set(id, session);
          keys.set(idempotencyKey, id);
        }
        if (loseCreate) throw new Error("lost create response");
        return Response.json({
          session,
          ...(session.state === "open"
            ? {
                lease: {
                  url: `http://filegate.test/direct/${session.id}`,
                  expires: new Date(Date.now() + 300000).toISOString(),
                  operations: ["write", "abort", "status"],
                },
              }
            : {}),
        });
      }
      const match = path.match(/\/sessions\/([^/]+)(?:\/(lease|commit))?$/);
      if (match) {
        const session = sessions.get(match[1]!);
        if (!session || missingReceipts) return Response.json({ code: "not_found", error: "not_found" }, { status: 404 });
        const identity = new Headers(init?.headers).get("X-Filegate-Execution");
        if (JSON.stringify(session.execution ?? null) !== JSON.stringify(identity ? JSON.parse(identity) : null))
          return Response.json({ code: "forbidden", error: "execution" }, { status: 403 });
        if (match[2] === "lease")
          return Response.json({ url: "http://filegate.test/direct/renewed", expires: session.expires, operations: ["write"] });
        if (match[2] === "commit") {
          commitCalls++;
          session.state = "committed";
          session.result = { ...node(session.path), size: session.size, ...commitResultPatch };
          if (loseCommit) throw new Error("lost commit response");
          return Response.json(session.result);
        }
        if (init?.method === "DELETE") {
          session.state = "aborted";
          return new Response(null, { status: 204 });
        }
        return Response.json(session);
      }
      return Response.json({ code: "unexpected", error: path }, { status: 500 });
    },
    { preconnect: fetch.preconnect },
  );
  const filegate = new Filegate({ baseUrl: config.url, token: config.token, fetch: transport });
  const authorize = async (_actor: RequestActor, _baseId: string, path: string, directory = false): Promise<SharingAccess> => {
    authorizationCalls++;
    if (denied || deniedPaths.has(path)) throw new FilesError("forbidden", 403);
    return {
      root: execution ? filegate.root("cloud").as(execution) : filegate.root("cloud"),
      target: path ? `home/alice/${path}` : "home/alice",
      relative: path,
      node: node(path ? `home/alice/${path}` : "home/alice", directory),
      inspection: { binding, summary, candidate: { ...binding, name: "alice" } },
      state: { config, unix: null, self: { user: { id: actor.user.id, username: "alice" } } },
    };
  };
  const makeService = () =>
    createSharingService({
      authorized: authorize,
      async writableParent(requestActor, baseId, path) {
        const current = await authorize(requestActor, baseId, path.split("/").slice(0, -1).join("/"), true);
        return { ...current, relative: path };
      },
      executionFor: () => execution,
      async requireAdmin() {
        if (!admin) throw new FilesError("forbidden", 403);
      },
      async actorUserId(requestActor) {
        if (requestActor.kind !== "user") throw new FilesError("forbidden", 403);
        return requestActor.user.id;
      },
      async creatorActor() {
        if (inactiveCreator) throw new AccountIdentityError("identity_unavailable");
        return actor;
      },
      async validateUploadTarget(current, path) {
        validatedTargets.push({ target: current.target, path, root: current.root.name, server: current.state.config.url });
        if (denied) throw new FilesError("forbidden", 403);
      },
      bindings,
      readConfiguration: async () => config,
      connect: () => filegate,
      publicOrigin: async () => "https://cloud.test",
      ownershipFor: () => ({ mode: "0600" }),
    });
  const service = makeService();
  const create = (overrides: Partial<Parameters<typeof service.createShare>[1]> = {}) =>
    service.createShare(actor, {
      baseId: summary.id,
      kind: "inbox",
      folder: "Inbox",
      title: "Inbox",
      expiresIn: "unlimited",
      maxFileSize: 10,
      maxTotalSize: 10,
      ...overrides,
    });
  const token = (share: { url: string | null }) => share.url!.split("/").at(-1)!;
  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !== process.env.FILESV2_SHARING_DATABASE_URL ||
      !process.env.DATABASE_URL?.endsWith("/cloud_filesv2_sharing_test")
    )
      throw new Error("Use the isolated sharing test database");
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.bases CASCADE`;
    binding = (
      await bindings.claim({
        area: "cloud",
        kind: "users",
        identity_id: actor.user.id,
        identity_name: "alice",
        root: "cloud",
        path: "home/alice",
        uid_number: null,
        gid_number: null,
      })
    )[0]!;
    denied = false;
    admin = false;
    inactiveCreator = false;
    missingReceipts = false;
    loseCommit = false;
    loseCreate = false;
    execution = null;
    keys.clear();
    createRequests.length = 0;
    archiveExecutions.length = 0;
    commitCalls = 0;
    commitResultPatch = null;
    authorizationCalls = 0;
    validatedTargets.length = 0;
    sessions.clear();
    deniedPaths.clear();
    listCalls.length = 0;
    config.url = "http://filegate.test:4000";
  });
  test("hashes links, reveals their URL once, and keeps internal notes private", async () => {
    const share = await create({ note: "internal secret", publicNote: "hello visitors" });
    const saved = await shares.get(share.id);
    expect(saved?.token_hash).toBe(shareTokenHash(token(share)));
    expect(JSON.stringify(saved)).not.toContain(token(share));
    expect((await service.listShares(actor)).items[0]?.url).toBeNull();
    expect((await service.publicShare(token(share), "inbox")).note).toBe("hello visitors");
    const privateOnly = await create({ note: "old internal secret" });
    expect((await service.publicShare(token(privateOnly), "inbox")).note).toBeNull();
  });
  test("migrates existing bearer links to hashes without breaking their tokens", async () => {
    const share = await create();
    const secret = token(share);
    await sql`ALTER TABLE filesv2.shares ADD COLUMN token TEXT`;
    await sql`ALTER TABLE filesv2.shares ALTER COLUMN token_hash DROP NOT NULL`;
    await sql`UPDATE filesv2.shares SET token=${secret},token_hash=NULL WHERE id=${share.id}::uuid`;
    await migrateSharing();
    expect((await shares.byToken(secret))?.id).toBe(share.id);
    expect(
      await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='filesv2' AND table_name='shares' AND column_name='token'`,
    ).toHaveLength(0);
  });
  test("owners can list and revoke after losing access; other readers cannot manage their links", async () => {
    const share = await create();
    denied = true;
    await expect(service.publicShare(token(share), "inbox")).rejects.toMatchObject({ code: "not_found" });
    expect((await service.listShares(actor)).items).toHaveLength(1);
    const stranger: RequestActor = { ...actor, user: { ...actor.user, id: randomUUID() } };
    expect((await service.listShares(stranger)).items).toHaveLength(0);
    await expect(service.revokeShare(stranger, { id: share.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await service.revokeShare(actor, { id: share.id })).state).toBe("revoked");
  });
  test("inactive creators are hidden and admin list/revoke is independent of file access", async () => {
    const share = await create();
    inactiveCreator = true;
    await expect(service.publicShare(token(share), "inbox")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.listShares(actor, { admin: true })).rejects.toMatchObject({ code: "forbidden" });
    admin = true;
    denied = true;
    expect((await service.listShares(actor, { admin: true })).items).toHaveLength(1);
    expect((await service.revokeShare(actor, { id: share.id, admin: true })).state).toBe("revoked");
  });
  test("quota reservation is atomic across concurrent requests and rejects unsafe sizes", async () => {
    const share = await create();
    const results = await Promise.allSettled([
      service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 6 }),
      service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "b", size: 6 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(
      service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "c", size: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toBeDefined();
    await expect(service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "c", size: 11 })).rejects.toMatchObject({
      code: "inbox_file_limit",
    });
  });
  test("lost commit responses reconcile once, and completed bytes never become free again", async () => {
    const share = await create();
    const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 6 });
    loseCommit = true;
    expect(await service.publicInboxCommit(token(share), opened.id)).toEqual({ name: "a", size: 6 });
    expect(await service.publicInboxCommit(token(share), opened.id)).toEqual({ name: "a", size: 6 });
    expect(commitCalls).toBe(1);
    await expect(service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "b", size: 6 })).rejects.toMatchObject({
      code: "inbox_total_limit",
    });
    await service.revokeShare(actor, { id: share.id });
    expect(await service.publicInboxCommit(token(share), opened.id)).toEqual({ name: "a", size: 6 });
  });
  test("missing receipts retain reservations and are visible to admins", async () => {
    const share = await create();
    const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 10 });
    missingReceipts = true;
    await service.publicInboxAbort(token(share), opened.id);
    expect((await uploads.getForShare(opened.id, share.id))?.state).toBe("open");
    await expect(service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "b", size: 1 })).rejects.toMatchObject({
      code: "inbox_total_limit",
    });
    admin = true;
    expect((await service.adminUploadReservations(actor)).items[0]?.error).toBe("receipt_unknown");
  });
  test("expired receipts release their reservation even after link revocation", async () => {
    const share = await create();
    const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 10 });
    sessions.values().next().value!.state = "expired";
    await service.revokeShare(actor, { id: share.id });
    await service.reconcileInboxUploads();
    expect((await uploads.getForShare(opened.id, share.id))?.state).toBe("expired");
  });
  test("backend and session path changes fail closed without releasing quota", async () => {
    const share = await create();
    const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 10 });
    sessions.values().next().value!.path = "home/bob/a";
    await expect(service.publicInboxCommit(token(share), opened.id)).rejects.toMatchObject({ code: "upload_changed" });
    expect(commitCalls).toBe(0);
    config.url = "http://other-backend.test";
    await expect(service.publicInboxCommit(token(share), opened.id)).rejects.toMatchObject({ code: "upload_changed" });
    expect(commitCalls).toBe(0);
  });
  test("name listings include only completed uploads to this inbox, with private default", async () => {
    const first = await create({ showUploadNames: true });
    const second = await create();
    const opened = await service.publicInboxUpload(token(first), { idempotencyKey: randomUUID(), name: "received.txt", size: 3 });
    expect((await service.publicShare(token(first), "inbox")).uploadedNames).toEqual([]);
    await service.publicInboxCommit(token(first), opened.id);
    expect((await service.publicShare(token(first), "inbox")).uploadedNames).toEqual(["received.txt"]);
    expect((await service.publicShare(token(second), "inbox")).uploadedNames).toEqual([]);
  });
  test("shared folder pages filter unreadable children and reject paths outside the selection", async () => {
    const share = await create({ kind: "download", paths: ["Docs"] });
    deniedPaths.add("Docs/private.txt");
    const page = await service.publicShare(token(share), "download", { path: "Docs", after: "old-page" });
    expect(page.items.map((item) => item.name)).toEqual(["public.txt"]);
    expect(page.next).toBe("next-page");
    expect(listCalls[0]).toEqual({ path: "home/alice/Docs", after: "old-page" });
    expect((await service.publicShareDownload(token(share), "Docs/public.txt")).method).toBe("GET");
    await expect(service.publicShareDownload(token(share), "Docs/private.txt")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.publicShare(token(share), "download", { path: "Other" })).rejects.toMatchObject({ code: "not_found" });
  });
  test("share pagination exposes every row once and an aborted recovery tick does no work", async () => {
    await Promise.all(Array.from({ length: 51 }, (_, i) => create({ title: `Share ${i}` })));
    const first = await service.listShares(actor);
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = await service.listShares(actor, { after: first.next! });
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(51);
    expect(await service.reconcileInboxUploads({ signal: AbortSignal.abort() })).toEqual({ processed: 0, unresolved: 0 });
  });
  test("successful but mismatched commit results never complete an inbox reservation", async () => {
    const mismatches: Partial<Node>[] = [
      { root: "other" },
      { path: "home/bob/a" },
      { size: 4 },
      { directory: true },
      { path: "home/alice/Inbox/.." },
    ];
    for (const mismatch of mismatches) {
      const share = await create();
      const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 3 });
      commitResultPatch = mismatch;
      await expect(service.publicInboxCommit(token(share), opened.id)).rejects.toMatchObject({ code: "upload_changed" });
      const stored = await uploads.getForShare(opened.id, share.id);
      expect(stored?.state).toBe("open");
      expect(stored?.result).toBeNull();
      expect(stored?.error_code).toBe("receipt_unknown");
    }
  });
  test("renewal and commit validate the leaf on their original authorization snapshot", async () => {
    const share = await create();
    const opened = await service.publicInboxUpload(token(share), { idempotencyKey: randomUUID(), name: "a", size: 3 });
    validatedTargets.length = 0;
    let before = authorizationCalls;
    await service.publicInboxLease(token(share), opened.id);
    expect(authorizationCalls - before).toBe(1);
    before = authorizationCalls;
    await service.publicInboxCommit(token(share), opened.id);
    expect(authorizationCalls - before).toBe(1);
    expect(validatedTargets).toEqual([
      { target: "home/alice/Inbox", path: "Inbox/a", root: "cloud", server: "http://filegate.test:4000" },
      { target: "home/alice/Inbox", path: "Inbox/a", root: "cloud", server: "http://filegate.test:4000" },
    ]);
  });
  test("lost create responses replay the durable key after restart without reserving quota twice", async () => {
    const share = await create();
    const input = { idempotencyKey: randomUUID(), name: "a", size: 10 };
    loseCreate = true;
    await expect(service.publicInboxUpload(token(share), input)).rejects.toThrow("lost create response");
    const reservation = await uploads.getForShare(input.idempotencyKey, share.id);
    expect(reservation?.filegate_session_id).toBeNull();
    expect(reservation?.write_options).toEqual({ onConflict: "rename", ownership: { mode: "0600" } });
    expect(sessions.size).toBe(1);
    loseCreate = false;
    const restarted = makeService();
    await restarted.reconcileInboxUploads();
    const opened = await restarted.publicInboxUpload(token(share), input);
    expect(opened.state).toBe("open");
    expect(opened.url).toBeDefined();
    expect(opened.id).toBe(input.idempotencyKey);
    expect(sessions.size).toBe(1);
    expect(createRequests.map((request) => request.key)).toEqual([input.idempotencyKey, input.idempotencyKey]);
    await expect(restarted.publicInboxUpload(token(share), { ...input, name: "changed" })).rejects.toMatchObject({
      code: "upload_changed",
    });
    await expect(restarted.publicInboxUpload(token(share), { ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "inbox_total_limit",
    });
  });
  test("terminal create replay has no lease and records committed quota exactly once", async () => {
    const share = await create();
    const input = { idempotencyKey: randomUUID(), name: "a", size: 10 };
    loseCreate = true;
    await expect(service.publicInboxUpload(token(share), input)).rejects.toThrow();
    const session = sessions.values().next().value!;
    session.state = "committed";
    session.result = { ...node(session.path), size: 10 };
    loseCreate = false;
    const replayed = await makeService().publicInboxUpload(token(share), input);
    expect(replayed.state).toBe("committed");
    expect(replayed.url).toBeUndefined();
    expect(await service.publicInboxCommit(token(share), input.idempotencyKey)).toEqual({ name: "a", size: 10 });
    expect(commitCalls).toBe(0);
    expect(sessions.size).toBe(1);
    expect((await uploads.getForShare(input.idempotencyKey, share.id))?.state).toBe("committed");
  });
  test("create recovery requires the original current execution and stops after receipt retention", async () => {
    execution = { uid: 1001, gid: 1002, groups: [1003] };
    const share = await create();
    const input = { idempotencyKey: randomUUID(), name: "a", size: 10 };
    loseCreate = true;
    await expect(service.publicInboxUpload(token(share), input)).rejects.toThrow();
    loseCreate = false;
    execution = { uid: 1001, gid: 1002, groups: [1004] };
    await service.reconcileInboxUploads();
    expect(createRequests).toHaveLength(1);
    execution = { uid: 1001, gid: 1002, groups: [1003] };
    await sql`UPDATE filesv2.uploads SET created_at=now()-interval '7 days' WHERE id=${input.idempotencyKey}`;
    await service.reconcileInboxUploads();
    expect(createRequests).toHaveLength(1);
    expect((await uploads.getForShare(input.idempotencyKey, share.id))?.state).toBe("open");
  });
  test("revoking an inbox prevents create replay but known scoped terminal receipts still reconcile", async () => {
    execution = { uid: 1001, gid: 1002, groups: [1003] };
    const share = await create();
    const input = { idempotencyKey: randomUUID(), name: "a", size: 10 };
    loseCreate = true;
    await expect(service.publicInboxUpload(token(share), input)).rejects.toThrow();
    loseCreate = false;
    await service.revokeShare(actor, { id: share.id });
    await service.reconcileInboxUploads();
    expect(createRequests).toHaveLength(1);
    const session = sessions.values().next().value!;
    await uploads.attachSession(input.idempotencyKey, session);
    session.state = "expired";
    execution = null;
    await service.reconcileInboxUploads();
    expect((await uploads.getForShare(input.idempotencyKey, share.id))?.state).toBe("expired");
  });
  test("concurrent replays reserve once and aborted replay remains terminal", async () => {
    const share = await create();
    const input = { idempotencyKey: randomUUID(), name: "a", size: 10 };
    const [first, second] = await Promise.all([
      service.publicInboxUpload(token(share), input),
      service.publicInboxUpload(token(share), input),
    ]);
    expect(first.id).toBe(second.id);
    expect(sessions.size).toBe(1);
    await service.publicInboxAbort(token(share), first.id);
    const replay = await service.publicInboxUpload(token(share), input);
    expect(replay.state).toBe("aborted");
    expect(replay.url).toBeUndefined();
    expect((await service.publicInboxUpload(token(share), { ...input, idempotencyKey: randomUUID() })).state).toBe("open");
  });
  test("public ZIP leases carry creator execution without prewalking the shared tree", async () => {
    execution = { uid: 1001, gid: 1002, groups: [1003] };
    const share = await create({ kind: "download", paths: ["Docs"] });
    expect((await service.publicShareArchive(token(share))).method).toBe("POST");
    expect(archiveExecutions).toEqual([execution]);
    expect(listCalls).toHaveLength(0);
  });
});
