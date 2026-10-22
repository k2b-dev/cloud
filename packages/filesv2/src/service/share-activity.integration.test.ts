import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import type { Node } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { BaseSummary } from "../contracts";
import { type Binding, bindings } from "../data/bases";
import { shares } from "../data/shares";
import { migrateSharing } from "../data/sharing-migration";
import { migrate } from "../migrate";
import type { UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { joinPath } from "./paths";
import { createSharingService, type SharingAccess } from "./sharing";

const suite = suiteFor("database");
const stamp = "2030-05-15T12:00:00.000Z";
const otherId = "10000000-0000-4000-8000-000000000002";
const adminId = "10000000-0000-4000-8000-000000000003";
const bindingId = "20000000-0000-4000-8000-000000000001";
const otherBindingId = "20000000-0000-4000-8000-000000000002";
const home = "home/alice";
type History = {
  action: string;
  state: string;
  finished_at: Date | null;
  server_url: string;
  root: string;
  base_id: string;
  item_id: string | null;
  directory: boolean;
  path_before: string;
  name: string;
  share_id: string;
  batch_id: string | null;
  actor_kind: string;
  actor_user_id: string;
  via: string;
  request_id: string | null;
  invocation_id: string | null;
  calling_app: string | null;
  origin: string | null;
  detail: Record<string, unknown>;
};
type Audit = {
  action: string;
  outcome: string;
  actor_user_id: string;
  target_type: string;
  target_id: string;
  target_label: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
};

suite("share create/revoke atomic history and security audit", () => {
  if (testActor.kind !== "user") throw new Error("Expected user fixture");
  const actor = testActor;
  const other: Extract<RequestActor, { kind: "user" }> = { ...actor, user: { ...actor.user, id: otherId, uid: "other" } };
  const admin: Extract<RequestActor, { kind: "user" }> = {
    ...actor,
    user: { ...actor.user, id: adminId, uid: "admin", roles: ["user", "admin"] },
  };
  const call: UserFilesCall = {
    ...testCall(actor),
    // A grant subject is deliberately different from the actor whose identity is recorded.
    accessSubject: { type: "user", userId: otherId },
    via: "agent",
    requestId: "share-request",
    invocationId: "share-invocation",
    callingApp: "assistant",
    origin: "assistant",
  };
  const config = {
    activityRetentionDays: 365,
    url: "http://filegate.test:4000",
    token: "private-filegate-token",
    tokenConfigured: true,
    unreadable: false,
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
  const summary: BaseSummary = {
    id: `cloud:users:${actor.user.id}`,
    name: "alice",
    area: "cloud",
    kind: "users",
    status: "existing",
    reason: null,
    indexEnabled: true,
    versioningEnabled: false,
  };
  let binding: Binding;
  let denied = false;
  let missing = false;
  let authorizations = 0;
  let reads = 0;
  const nodes = new Map<string, Node>();
  let patch: ((access: SharingAccess, index: number) => SharingAccess) | null = null;
  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      reads++;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? "GET") !== "GET" || url.pathname !== "/v1/roots/cloud/stat")
        throw new Error(`Unexpected Filegate call: ${url.pathname}`);
      const node = nodes.get(url.searchParams.get("path") ?? "");
      return node && !missing ? Response.json(node) : Response.json({ code: "not_found", error: "not_found" }, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  const filegate = connectFilegate(config, transport);
  async function authorize(_actor: RequestActor, _base: string, path: string, directory?: boolean): Promise<SharingAccess> {
    authorizations++;
    if (denied) throw new FilesError("forbidden", 403);
    const target = joinPath(home, path);
    const root = filegate.root("cloud");
    const node = await root.stat(target);
    if (directory !== undefined && node.directory !== directory) throw new FilesError("not_directory", 400);
    const access: SharingAccess = {
      root,
      node,
      target,
      relative: path,
      inspection: { binding, candidate: { ...binding, name: "alice" }, summary },
      state: { config: { ...config }, unix: null, self: { user: { id: actor.user.id, username: "alice" } } },
    };
    return patch ? patch(access, authorizations) : access;
  }
  const service = createSharingService({
    authorized: authorize,
    async writableParent(requestActor, base, path) {
      const parent = path.split("/").slice(0, -1).join("/");
      return { ...(await authorize(requestActor, base, parent, true)), relative: path };
    },
    executionFor: () => null,
    async requireAdmin(requestActor) {
      if (requestActor.kind !== "user" || !requestActor.user.roles.includes("admin")) throw new FilesError("forbidden", 403);
    },
    async actorUserId(requestActor) {
      if (requestActor.kind !== "user") throw new FilesError("forbidden", 403);
      return requestActor.user.id;
    },
    async creatorActor() {
      return actor;
    },
    async validateUploadTarget() {
      throw new Error("Upload is outside this test");
    },
    bindings,
    readConfiguration: async () => config,
    connect: () => filegate,
    publicOrigin: async () => "https://cloud.test",
    ownershipFor: () => ({ mode: "0600" }),
  });
  const create = (input: Partial<Parameters<typeof service.createShare>[1]> = {}, requestCall = call) =>
    service.createShare(requestCall, {
      baseId: summary.id,
      kind: "download",
      paths: ["Docs/report.txt"],
      title: "Private link title",
      note: "Private internal note",
      publicNote: "Private public note",
      expiresIn: "unlimited",
      ...input,
    });
  const history = () => sql<History[]>`SELECT * FROM filesv2.activity ORDER BY started_at,id`;
  const audit = () => sql<Audit[]>`SELECT * FROM audit.events ORDER BY id`;
  const state = async () => ({
    shares: await sql<Record<string, unknown>[]>`SELECT * FROM filesv2.shares ORDER BY id`,
    history: await history(),
    audit: await audit(),
  });
  function expectContext(row: History, requestCall = call) {
    const user = requestCall.actor.kind === "user" ? requestCall.actor.user : requestCall.actor.delegatedUser;
    expect(row).toMatchObject({
      state: "done",
      actor_kind: "user",
      actor_user_id: user?.id,
      via: requestCall.via,
      request_id: requestCall.requestId,
      calling_app: requestCall.callingApp,
      origin: requestCall.origin,
      invocation_id: requestCall.invocationId,
    });
    expect(row.finished_at).toBeInstanceOf(Date);
  }
  function expectAudit(row: Audit | undefined, action: "create" | "revoke", id: string, count: number, requestCall = call) {
    const user = requestCall.actor.kind === "user" ? requestCall.actor.user : requestCall.actor.delegatedUser;
    expect(row).toMatchObject({
      action: `filesv2.share.${action}`,
      outcome: "allowed",
      actor_user_id: user?.id,
      target_type: "filesv2.share",
      target_id: id,
      target_label: null,
      request_id: requestCall.requestId,
    });
    expect(row?.metadata).toEqual({
      via: requestCall.via,
      calling_app: requestCall.callingApp,
      origin: requestCall.origin,
      invocation_id: requestCall.invocationId,
      item_count: count,
    });
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await migrate();
    await migrateAudit();
    await sql`CREATE FUNCTION filesv2.reject_share_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'share-history-failure' THEN RAISE EXCEPTION 'share history unavailable'; END IF;
        IF NEW.request_id = 'share-history-finish-failure' AND NEW.state = 'done' THEN RAISE EXCEPTION 'share history finish unavailable'; END IF;
        IF NEW.request_id = 'share-second-item-failure' AND NEW.name = 'other.txt' THEN RAISE EXCEPTION 'second share item unavailable'; END IF;
        RETURN NEW;
      END; $$`.simple();
    await sql`CREATE TRIGGER reject_share_test_history BEFORE INSERT OR UPDATE ON filesv2.activity
      FOR EACH ROW EXECUTE FUNCTION filesv2.reject_share_test_history()`.simple();
    await sql`CREATE FUNCTION audit.reject_share_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'share-audit-failure' THEN RAISE EXCEPTION 'share audit unavailable'; END IF;
        RETURN NEW;
      END; $$`.simple();
    await sql`CREATE TRIGGER reject_share_test_audit BEFORE INSERT ON audit.events
      FOR EACH ROW EXECUTE FUNCTION audit.reject_share_test_audit()`.simple();
  });
  beforeEach(async () => {
    setSystemTime(new Date(stamp));
    await sql`TRUNCATE filesv2.bases,filesv2.activity,auth.users,audit.events CASCADE`.simple();
    for (const current of [actor, other, admin])
      await sql`INSERT INTO auth.users(id,uid) VALUES(${current.user.id}::uuid,${current.user.uid})`;
    await sql`INSERT INTO filesv2.bases(id,area,kind,identity_id,identity_name,root,path)
      VALUES(${bindingId}::uuid,'cloud','users',${actor.user.id},'alice','cloud',${home})`;
    binding = (await bindings.byId(bindingId))!;
    denied = missing = false;
    authorizations = reads = 0;
    patch = null;
    nodes.clear();
    for (const [path, directory] of [
      ["", true],
      ["Docs", true],
      ["Docs/report.txt", false],
      ["Docs/other.txt", false],
      ["Elsewhere", true],
    ] as const) {
      nodes.set(joinPath(home, path), {
        root: "cloud",
        path: joinPath(home, path),
        id: `stable:${path || "home"}`,
        directory,
        size: directory ? 0 : 3,
        modified: stamp,
        uid: 1000,
        gid: 1000,
        mode: directory ? "0700" : "0600",
      });
    }
  });
  afterAll(() => setSystemTime());

  for (const input of [
    { kind: "download", paths: ["Docs/report.txt"], expected: ["Docs/report.txt"] },
    { kind: "download", paths: ["Docs"], expected: ["Docs"] },
    { kind: "download", paths: ["Docs/report.txt", "Elsewhere", "Docs", "Docs"], expected: ["Elsewhere", "Docs"] },
    { kind: "inbox", folder: "Docs", expected: ["Docs"] },
    { kind: "inbox", folder: "", expected: [""] },
  ] as const) {
    test(`${input.kind} ${input.expected.join(",") || "root"} records each top-level target once`, async () => {
      const grant = await create({ ...input, paths: input.kind === "download" ? [...input.paths] : [] });
      const rows = await history();
      expect(rows).toHaveLength(input.expected.length);
      for (const path of input.expected) {
        const node = nodes.get(joinPath(home, path))!;
        const row = rows.find((entry) => entry.path_before === node.path)!;
        expect(row).toMatchObject({
          action: "share.create",
          server_url: config.url,
          root: binding.root,
          base_id: binding.id,
          share_id: grant.id,
          path_before: node.path,
          name: node.path.split("/").at(-1),
          item_id: node.id,
          directory: node.directory,
          detail: {},
        });
        expectContext(row);
      }
      expect(new Set(rows.map((row) => row.batch_id)).size).toBe(1);
      if (rows.length > 1) expect(rows[0]?.batch_id).toBeString();
      else expect(rows[0]?.batch_id).toBeNull();
      const stored = (await shares.get(grant.id))!;
      expect(stored.server_url).toBe(config.url);
      expect(stored.target_snapshots).toEqual(
        input.expected.map((path) => {
          const node = nodes.get(joinPath(home, path))!;
          return { path: node.path, directory: node.directory, itemId: node.id ?? null };
        }),
      );
      expect(await audit()).toHaveLength(1);
      expectAudit((await audit())[0], "create", grant.id, rows.length);
    });
  }

  test("unindexed targets keep an explicitly absent stable identity", async () => {
    const node = nodes.get(`${home}/Docs/report.txt`)!;
    delete node.id;
    const grant = await create();
    expect((await shares.get(grant.id))?.target_snapshots?.[0]?.itemId).toBeNull();
    expect((await history())[0]?.item_id).toBeNull();
    await service.revokeShare(call, { id: grant.id });
    expect((await history())[1]?.item_id).toBeNull();
  });

  for (const via of ["web", "app", "api", "cli", "office", "agent", "app:notes"] as const) {
    test(`${via} retains the exact original actor/channel/request/execution on create and revoke`, async () => {
      const original: UserFilesCall = { ...call, via, requestId: `create-${via}` };
      const grant = await create({}, original);
      const revoking: UserFilesCall = { ...original, requestId: `revoke-${via}`, invocationId: "revoke-invocation" };
      await service.revokeShare(revoking, { id: grant.id });
      const rows = await history();
      expectContext(rows[0]!, original);
      expectContext(rows[1]!, revoking);
      expectAudit((await audit())[0], "create", grant.id, 1, original);
      expectAudit((await audit())[1], "revoke", grant.id, 1, revoking);
    });
  }

  test("password, tokens, URLs, titles, notes and raw target detail never enter audit metadata", async () => {
    const grant = await create({ password: "private-share-password" });
    await service.revokeShare(call, { id: grant.id });
    const stored = (await shares.get(grant.id))!;
    expect(stored.password_hash).toBeString();
    const serialized = JSON.stringify({ history: await history(), audit: await audit() });
    for (const value of [
      "private-share-password",
      config.token,
      grant.url,
      grant.url.split("/").at(-1)!,
      stored.token_hash,
      stored.password_hash!,
      "Private link title",
      "Private internal note",
      "Private public note",
    ])
      expect(serialized).not.toContain(value);
    for (const event of await audit()) {
      expect(Object.keys(event.metadata).sort()).toEqual(["calling_app", "invocation_id", "item_count", "origin", "via"]);
      expect(JSON.stringify(event.metadata)).not.toContain(home);
      expect(JSON.stringify(event.metadata)).not.toContain(config.url);
    }
  });

  test("creator revokes from snapshots after lost rights, missing files and expired history", async () => {
    const grant = await create({ paths: ["Docs", "Docs/other.txt", "Elsewhere"] });
    const original = (await shares.get(grant.id))!;
    // Model the eventual retention purge: revocation cannot rely on the original history rows.
    await sql`DELETE FROM filesv2.activity`;
    denied = missing = true;
    const beforeReads = reads;
    const beforeAuthorizations = authorizations;
    await sql`UPDATE filesv2.bases SET path='reused/elsewhere',root='other-root',lifecycle='retired' WHERE id=${binding.id}::uuid`;
    expect((await service.revokeShare(call, { id: grant.id })).state).toBe("revoked");
    expect(reads).toBe(beforeReads);
    expect(authorizations).toBe(beforeAuthorizations);
    const rows = await history();
    expect(rows.map((row) => ({ path: row.path_before, itemId: row.item_id, directory: row.directory }))).toEqual(
      expect.arrayContaining(original.target_snapshots!),
    );
    expect(rows).toHaveLength(original.target_snapshots!.length);
    for (const row of rows)
      expect(row).toMatchObject({
        action: "share.revoke",
        root: original.root,
        server_url: original.server_url,
        base_id: original.base_id,
      });
    expect(rows[0]?.batch_id).toBeString();
    expect(rows[0]?.batch_id).toBe(rows[1]?.batch_id);
    expectAudit((await audit())[1], "revoke", grant.id, 2);
  });

  test("another user is denied; only an explicitly authorized admin can revoke someone else's share", async () => {
    const grant = await create();
    const before = await state();
    for (const [requestCall, administrative] of [
      [testCall(other), false],
      [testCall(other), true],
      [testCall(admin), false],
    ] as const) {
      await expect(service.revokeShare(requestCall, { id: grant.id, admin: administrative })).rejects.toMatchObject({
        status: administrative ? 403 : 404,
      });
      expect(await state()).toEqual(before);
    }
    denied = true;
    const adminCall = { ...testCall(admin), via: "api" as const, requestId: "admin-revoke" };
    expect((await service.revokeShare(adminCall, { id: grant.id, admin: true })).state).toBe("revoked");
    expectContext((await history())[1]!, adminCall);
    expectAudit((await audit())[1], "revoke", grant.id, 1, adminCall);
    expect((await shares.get(grant.id))?.revoked_by).toBe(adminId);
  });

  test("repeated and concurrent revokes commit one history entry per target and one security event", async () => {
    const grant = await create({ paths: ["Docs/report.txt", "Docs/other.txt"] });
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => service.revokeShare({ ...call, requestId: `concurrent-${index}` }, { id: grant.id })),
    );
    expect(results.every((row) => row.state === "revoked")).toBe(true);
    const rows = (await history()).filter((row) => row.action === "share.revoke");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.batch_id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.request_id)).size).toBe(1);
    expect((await audit()).filter((row) => row.action === "filesv2.share.revoke")).toHaveLength(1);
    expect((await audit())[1]?.request_id).toBe(rows[0]?.request_id);
    const before = await state();
    await service.revokeShare(call, { id: grant.id });
    await service.revokeShare(testCall(admin), { id: grant.id, admin: true });
    expect(await state()).toEqual(before);
  });

  for (const requestId of ["share-history-failure", "share-history-finish-failure", "share-second-item-failure", "share-audit-failure"]) {
    for (const action of ["create", "revoke"] as const) {
      test(`${action} rolls back share, all history and audit on ${requestId}`, async () => {
        const grant = action === "revoke" ? await create({ paths: ["Docs/report.txt", "Docs/other.txt"] }) : null;
        const before = await state();
        const failing = { ...call, requestId };
        await expect(
          grant ? service.revokeShare(failing, { id: grant.id }) : create({ paths: ["Docs/report.txt", "Docs/other.txt"] }, failing),
        ).rejects.toThrow();
        expect(await state()).toEqual(before);
        // A failed revoke leaves the grant revocable; failure cannot consume its one history event.
        if (grant) {
          await service.revokeShare(call, { id: grant.id });
          expect((await history()).filter((row) => row.action === "share.revoke")).toHaveLength(2);
          expect((await audit()).filter((row) => row.action === "filesv2.share.revoke")).toHaveLength(1);
        }
      });
    }
  }

  for (const kind of ["download", "inbox"] as const) {
    test(`legacy ${kind} revokes without resolving hidden paths or inventing identity/type/server`, async () => {
      const grant = await create({ kind, folder: "Docs", paths: ["Docs/report.txt", "Docs/other.txt"] });
      await sql`UPDATE filesv2.shares SET server_url=NULL,target_snapshots=NULL WHERE id=${grant.id}::uuid`;
      await sql`DELETE FROM filesv2.activity`;
      await migrateSharing();
      await migrateSharing();
      expect((await shares.get(grant.id))?.target_snapshots).toBeNull();
      denied = missing = true;
      const beforeReads = reads;
      await service.revokeShare(call, { id: grant.id });
      expect(reads).toBe(beforeReads);
      const rows = await history();
      expect(rows.map((row) => row.path_before).sort()).toEqual(
        kind === "inbox" ? [`${home}/Docs`] : [`${home}/Docs/other.txt`, `${home}/Docs/report.txt`],
      );
      for (const row of rows)
        expect(row).toMatchObject({
          action: "share.revoke",
          server_url: "",
          root: "cloud",
          item_id: null,
          directory: false,
          detail: { snapshot_unknown: true, directory_unknown: true, server_unknown: true },
        });
    });
  }

  for (const change of ["server", "root", "binding", "base-path"] as const) {
    for (const stage of ["second-item", "common-folder"] as const) {
      test(`creation rejects ${change} drift at ${stage} across authorization reads`, async () => {
        patch = (access, index) => {
          if (index !== (stage === "second-item" ? 2 : 3)) return access;
          const changedBinding = {
            ...binding,
            ...(change === "binding" ? { id: otherBindingId } : {}),
            ...(change === "root" ? { root: "other-root" } : {}),
            ...(change === "base-path" ? { path: "home/reused" } : {}),
          };
          return {
            ...access,
            ...(change === "server"
              ? { state: { ...access.state, config: { ...access.state.config, url: "http://other-filegate.test" } } }
              : {}),
            ...(change === "root" ? { root: filegate.root("other-root"), node: { ...access.node, root: "other-root" } } : {}),
            inspection: { ...access.inspection, binding: changedBinding, candidate: { ...changedBinding, name: "alice" } },
          };
        };
        const before = await state();
        await expect(create({ paths: ["Docs/report.txt", "Docs/other.txt"] })).rejects.toMatchObject({
          code: "storage_changed",
          status: 409,
        });
        expect(await state()).toEqual(before);
      });
    }
  }

  test("failed target authorization and invalid input leave no grant, history or success audit", async () => {
    const before = await state();
    denied = true;
    for (const input of [{ kind: "download" as const }, { kind: "inbox" as const, folder: "Docs" }]) {
      await expect(create(input)).rejects.toMatchObject({ code: "forbidden", status: 403 });
      expect(await state()).toEqual(before);
    }
    denied = false;
    await expect(create({ paths: [] })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(create({ maxFileSize: 20, maxTotalSize: 10 })).rejects.toMatchObject({ code: "inbox_invalid_limits" });
    await expect(service.revokeShare(call, { id: otherBindingId })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await state()).toEqual(before);
  });
});
