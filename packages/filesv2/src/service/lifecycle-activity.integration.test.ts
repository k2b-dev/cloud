import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, FilegateError } from "@k2b/filegate";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { activityFilegate } from "../../test/activity-filegate";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { Configuration } from "../contracts";
import { bindings } from "../data/bases";
import { type NewOperation, type Operation, operations } from "../data/operations";
import { migrate } from "../migrate";
import { journalAction, type LifecycleMkdir, purgeActivity, recoverActivity, type UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";
import { createDirectoryLifecycle } from "./lifecycle";

const suite = suiteFor("database", "nats");
const old = new Date("2020-03-02T10:00:00Z");
const now = new Date("2030-05-14T12:00:00Z");
type History = {
  id: string;
  operation_id: string;
  root: string;
  path_before: string | null;
  action: string;
  state: string;
  actor_kind: string;
  actor_user_id: string | null;
  via: string;
  request_id: string | null;
  calling_app: string | null;
  invocation_id: string | null;
  origin: string | null;
  heartbeat_at: Date;
  started_at: Date;
  finished_at: Date | null;
  detail: { adopted?: boolean; lifecycle_mkdirs?: LifecycleMkdir[]; job?: string };
  xmin: string;
};
type Mutation = { method: string; path: string; root: string; endpoint: string };

suite("lifecycle committed history with real Filegate and Core audit", () => {
  const ownedPrefix = `filesv2-lifecycle-activity-${Bun.randomUUIDv7()}`;
  let ownsPrefix = false;
  let caseNumber = 0;
  let rejectRootProbe = false;
  const probeParents: string[] = [];
  let processSync: ProcessSync | undefined;
  let storage: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let config: Configuration & { token: string; tokenConfigured: boolean; unreadable: boolean };
  let client: Filegate;
  let service: ReturnType<typeof createFilesService>;
  let lifecycle: ReturnType<typeof createDirectoryLifecycle>;
  let owner: Extract<RequestActor, { kind: "user" }>;
  let administrator: Extract<RequestActor, { kind: "user" }>;
  let retrying: Extract<RequestActor, { kind: "user" }>;
  const mutations: Mutation[] = [];
  let beforeMutation: ((mutation: Mutation) => Promise<void>) | undefined;
  let loseResponse: ((mutation: Mutation) => boolean) | undefined;
  const root = () => client.root("cloud");
  const home = () => `${config.cloud.prefix}/users/alice`;
  const history = () => sql<History[]>`SELECT *,xmin::text FROM filesv2.activity ORDER BY id`;
  const entry = async (id: string) => (await sql<History[]>`SELECT *,xmin::text FROM filesv2.activity WHERE operation_id=${id}::uuid`)[0]!;
  const call = (): UserFilesCall => ({
    ...testCall(administrator),
    accessSubject: { type: "user", userId: owner.user.id },
    via: "agent",
    requestId: "original-lifecycle-request",
    callingApp: "assistant",
    invocationId: "original-lifecycle-invocation",
    origin: "assistant",
  });
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const endpoint = url.pathname.split("/").at(-1)!;
      let mutation: Mutation | undefined;
      if (
        (request.method === "POST" && ["directories", "transfers"].includes(endpoint)) ||
        (request.method === "DELETE" && endpoint === "files")
      ) {
        const path =
          request.method === "DELETE"
            ? url.searchParams.get("path")!
            : z.object({ path: z.string() }).parse(await request.clone().json()).path;
        if (path.split("/").at(-1)?.startsWith(".filesv2-owner-")) {
          const parent = path.split("/").slice(0, -1).join("/");
          if (request.method === "POST") probeParents.push(parent);
          if (rejectRootProbe && (!parent || parent === ".")) throw new FilegateError(403, "permission_denied", "root is read-only");
        } else {
          mutation = { method: request.method, endpoint, path, root: decodeURIComponent(url.pathname.split("/")[3]!) };
          mutations.push(mutation);
          await beforeMutation?.(mutation);
        }
      }
      const response = await fetch(input, init);
      if (mutation && response.ok && loseResponse?.(mutation)) throw new Error("lost lifecycle response");
      return response;
    },
    { preconnect: fetch.preconnect },
  );

  async function provision(targetCall = call()) {
    return service.provision(targetCall, { area: "cloud", kind: "users", identityId: owner.user.id });
  }
  async function archive() {
    await provision();
    return service.archive(call(), { area: "cloud", kind: "users", name: "alice" });
  }
  async function fail(kind: "intent" | "audit", active = true) {
    if (active) await sql`INSERT INTO filesv2.lifecycle_test_failures(kind) VALUES(${kind}) ON CONFLICT DO NOTHING`;
    else await sql`DELETE FROM filesv2.lifecycle_test_failures WHERE kind=${kind}`;
  }
  async function assertAtomic(id: string, action: Operation["action"], original = call()) {
    const op = await operations.get(id);
    const row = await entry(id);
    expect(op).toMatchObject({ state: "complete", activity_recorded: true });
    expect(row).toMatchObject({
      state: "done",
      actor_kind: "user",
      actor_user_id: administrator.user.id,
      via: original.via,
      request_id: original.requestId,
      calling_app: original.callingApp,
      invocation_id: original.invocationId,
      origin: original.origin,
    });
    const [journal] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM filesv2.operations WHERE id=${id}::uuid`;
    const events = await sql<
      { action: string; actor_user_id: string; request_id: string; metadata: { historyId: string }; xmin: string }[]
    >`
      SELECT *,xmin::text FROM audit.events WHERE target_id=${id} AND action=${`filesv2.${action}`}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: administrator.user.id, request_id: original.requestId, xmin: row.xmin });
    expect(events[0]!.metadata.historyId).toBe(row.id);
    expect(journal?.xmin).toBe(row.xmin);
  }
  async function pending(action: Operation["action"], mkdirs: LifecycleMkdir[] = []) {
    const id = crypto.randomUUID();
    const snapshot = action === "create" ? null : await root().stat(home());
    const value: NewOperation = {
      id,
      area: "cloud",
      kind: "users",
      name: "alice",
      root: "cloud",
      server_url: config.url,
      action,
      source: home(),
      target: action === "archive" ? `${config.cloud.prefix}/archive/${id}/contents` : null,
      base_id: (await bindings.path("cloud", home()))?.id ?? null,
      archive_id: null,
      actor_id: administrator.user.id,
      actor_name: administrator.user.uid,
      snapshot,
    };
    return operations.insert(value, call(), mkdirs);
  }

  beforeAll(async () => {
    await assertPrivateDatabase();
    processSync = await startProcessSync({ application: "filesv2" });
    storage = await activityFilegate();
    const { token, url } = storage;
    config = {
      activityRetentionDays: 365,
      url,
      token,
      tokenConfigured: true,
      unreadable: false,
      cloud: {
        enabled: true,
        root: "cloud",
        prefix: ownedPrefix,
        homes: "users",
        groups: "groups",
        archive: "archive",
        autoCreate: false,
        autoArchive: false,
      },
      freeipa: { enabled: false, root: "freeipa", prefix: ownedPrefix, homes: "users", groups: "groups", archive: "archive" },
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
    };
    client = new Filegate({ baseUrl: config.url, transferBaseUrl: config.url, token });
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await sql`CREATE TABLE auth.user_posix(user_id uuid PRIMARY KEY,managed_by text,uid_number integer,primary_gid_number integer,primary_group_id uuid,home_directory text,login_shell text)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid)`.simple();
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`.simple();
    await sql`CREATE TABLE auth.ipa_user_effective_groups(user_id uuid,group_name text)`.simple();
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text)`.simple();
    await migrate();
    await migrateAudit();
    await sql`INSERT INTO settings.entries(key,value) VALUES('linux.identity_config',${await secrets.encrypt(
      JSON.stringify({
        enabled: true,
        rangeStart: 200000,
        rangeEnd: 200100,
        homeTemplate: "/home/{username}",
        loginShell: "/bin/bash",
      }),
    )})`;
    if (testActor.kind !== "user") throw new Error("expected user fixture");
    owner = { ...testActor, user: { ...testActor.user } };
    administrator = { ...owner, user: { ...owner.user, id: "10000000-0000-4000-8000-000000000002", uid: "bob", roles: ["user", "admin"] } };
    retrying = { ...administrator, user: { ...administrator.user, id: "10000000-0000-4000-8000-000000000003", uid: "carol" } };
    const deps = {
      identities: {
        ...accountIdentities,
        self: async (actor: RequestActor) => {
          const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
          if (!user) throw new FilesError("forbidden", 403);
          return {
            user: { id: user.id, username: user.uid, provider: user.provider, profile: user.profile, posix: null },
            availability: { localLinuxEnabled: true, freeipaEnabled: false },
          };
        },
        groups: async () => ({ items: [], nextCursor: null }),
      },
      displayNames: resolveDisplayNames,
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      publicOrigin: async () => "https://cloud.example.test",
      userById: async () => null,
      transfer: fetch,
      connect: (configuration: typeof config) => connectFilegate(configuration, transport),
    };
    service = createFilesService(deps);
    lifecycle = createDirectoryLifecycle(deps);
    await sql`CREATE TABLE filesv2.lifecycle_test_failures(kind text PRIMARY KEY)`.simple();
    await sql`CREATE FUNCTION filesv2.reject_lifecycle_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM filesv2.lifecycle_test_failures WHERE kind='intent')
          THEN RAISE EXCEPTION 'lifecycle intent unavailable'; END IF;
        RETURN NEW;
      END $$`.simple();
    await sql`CREATE TRIGGER reject_lifecycle_intent BEFORE INSERT ON filesv2.activity FOR EACH ROW EXECUTE FUNCTION filesv2.reject_lifecycle_intent()`.simple();
    await sql`CREATE FUNCTION audit.reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.target_type='filesv2.directory' AND EXISTS (SELECT 1 FROM filesv2.lifecycle_test_failures WHERE kind='audit')
          THEN RAISE EXCEPTION 'lifecycle audit unavailable'; END IF;
        RETURN NEW;
      END $$`.simple();
    await sql`CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.reject_lifecycle_audit()`.simple();
    await root().mkdir(ownedPrefix, { ownership: { dirMode: "0700" } });
    ownsPrefix = true;
  }, 30_000);
  beforeEach(async () => {
    beforeMutation = async (mutation) => {
      // This independent read observes only committed rows, for every direct
      // and automatic lifecycle effect rather than only the final directory.
      const rows = await sql<History[]>`SELECT * FROM filesv2.activity WHERE operation_id IS NOT NULL AND state IN ('pending','unclear')`;
      expect(
        rows.some(
          (row) =>
            row.root === mutation.root &&
            (row.path_before === mutation.path || row.detail.lifecycle_mkdirs?.some((binding) => binding.path === mutation.path)),
        ),
      ).toBe(true);
    };
    loseResponse = undefined;
    rejectRootProbe = false;
    probeParents.length = 0;
    mutations.length = 0;
    await sql`TRUNCATE filesv2.activity,filesv2.operations,filesv2.trash,filesv2.bases,filesv2.maintenance,filesv2.lifecycle_test_failures,audit.events CASCADE`.simple();
    for (const actor of [owner, administrator, retrying])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${actor.user.id}::uuid,${actor.user.uid},'local','user',${actor !== owner})
        ON CONFLICT(id) DO UPDATE SET uid=EXCLUDED.uid,profile='user',admin=EXCLUDED.admin`;
    config.cloud.prefix = `${ownedPrefix}/case-${++caseNumber}`;
    config.cloud.autoCreate = false;
    config.cloud.autoArchive = false;
    await root().mkdir(config.cloud.prefix, { ownership: { dirMode: "0700" } });
  });
  afterAll(async () => {
    try {
      if (ownsPrefix)
        await root()
          .remove(ownedPrefix, true)
          .catch((error: unknown) => {
            if (!(error instanceof FilegateError && error.status === 404)) throw error;
          });
    } finally {
      try {
        await processSync?.stop();
      } finally {
        await storage?.stop();
      }
    }
  });

  test("direct provision commits journal, original call and exact ancestor/ACL bindings before the first effect", async () => {
    beforeMutation = async (mutation) => {
      const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending'`;
      expect(op).toBeDefined();
      const row = await entry(op!.id);
      expect(row).toMatchObject({ state: "pending", actor_user_id: administrator.user.id, via: "agent" });
      expect(row.detail.lifecycle_mkdirs?.some((binding) => binding.path === mutation.path)).toBe(true);
      expect(row.started_at).toEqual(op!.created_at);
      expect(await sql`SELECT 1 FROM audit.events`).toHaveLength(0);
    };
    const created = await provision();
    expect(mutations.some((mutation) => mutation.path === home())).toBe(true);
    const row = await entry(created.id);
    expect(row.action).toBe("place.provision");
    const target = row.detail.lifecycle_mkdirs?.find((binding) => binding.path === home());
    expect(target?.options.ownership).toEqual({ dirMode: "0700" });
    expect(target?.options.acl?.access?.entries).toHaveLength(3);
    await assertAtomic(created.id, "create");
  });

  for (const refusal of [
    new FilegateError(403, "permission_denied", "denied"),
    new FilegateError(409, "path_conflict", "conflict"),
    new FilegateError(501, "acl_not_supported", "ACLs unavailable"),
    new FilegateError(501, "unsupported_storage_layout", "cross-device publication refused"),
  ]) {
    test(`definitive provision refusal ${refusal.status} ${refusal.code} permits a retry with the original intent`, async () => {
      const check = beforeMutation;
      beforeMutation = async (mutation) => {
        await check?.(mutation);
        if (mutation.path === home()) throw refusal;
      };
      await expect(provision()).rejects.toThrow();
      const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending'`;
      expect(op?.effect_started).toBe(false);
      expect((await entry(op!.id)).state).toBe("pending");
      beforeMutation = check;
      await service.retry(testCall(retrying), op!.id);
      await assertAtomic(op!.id, "create");
      expect(await history()).toHaveLength(1);
    });
  }
  test("definitive move refusal permits retry but a lost response still cannot authorize another send", async () => {
    await provision();
    const check = beforeMutation;
    beforeMutation = async (mutation) => {
      await check?.(mutation);
      if (mutation.endpoint === "transfers") throw new FilegateError(403, "permission_denied", "denied");
    };
    await expect(service.archive(call(), { area: "cloud", kind: "users", name: "alice" })).rejects.toThrow();
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending' AND action='archive'`;
    expect(op?.effect_started).toBe(false);
    beforeMutation = check;
    await service.retry(testCall(retrying), op!.id);
    await assertAtomic(op!.id, "archive");
  });
  test("group provisioning probes only the nearest existing parent and reuses its committed UID", async () => {
    config.freeipa.root = "cloud";
    config.freeipa.prefix = config.cloud.prefix;
    rejectRootProbe = true;
    try {
      const target = `${config.cloud.prefix}/groups/engineering`;
      const created = await lifecycle.provisionCandidate(
        config,
        {
          area: "freeipa",
          kind: "groups",
          identity_id: "20000000-0000-4000-8000-000000000009",
          identity_name: "engineering",
          root: "cloud",
          path: target,
          uid_number: null,
          gid_number: 200009,
        },
        administrator.user.id,
        administrator.user.uid,
        call(),
      );
      expect(probeParents).toEqual([config.cloud.prefix]);
      const row = await entry(created.id);
      const planned = row.detail.lifecycle_mkdirs?.find((entry) => entry.path === target)?.options.ownership;
      const node = await root().stat(target);
      expect(planned?.uid).toBe(node.uid);
      expect(node.gid).toBe(200009);
      await assertAtomic(created.id, "create");
    } finally {
      config.freeipa.root = "freeipa";
      config.freeipa.prefix = ownedPrefix;
    }
  });
  test("automatic provision records the person via system without a grant subject; repeated reads add nothing", async () => {
    config.cloud.autoCreate = true;
    const baseId = `cloud:users:${owner.user.id}`;
    await service.list(testCall(owner), { baseId, path: "" });
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "place.provision",
      state: "done",
      actor_kind: "user",
      actor_user_id: owner.user.id,
      via: "system",
      request_id: null,
      detail: { job: "automatic-provision" },
    });
    await service.list(testCall(owner), { baseId, path: "" });
    expect(await history()).toHaveLength(1);
  });

  test("automatic provision fails before all user-data writes when intent storage fails", async () => {
    config.cloud.autoCreate = true;
    await fail("intent");
    await expect(service.list(testCall(owner), { baseId: `cloud:users:${owner.user.id}`, path: "" })).rejects.toThrow(
      "lifecycle intent unavailable",
    );
    expect(mutations).toHaveLength(0);
    expect(await history()).toHaveLength(0);
    expect(await sql`SELECT 1 FROM filesv2.operations`).toHaveLength(0);
  });

  test("automatic provision keeps its original person and system channel after audit failure and an administrative retry", async () => {
    config.cloud.autoCreate = true;
    await fail("audit");
    await expect(service.list(testCall(owner), { baseId: `cloud:users:${owner.user.id}`, path: "" })).rejects.toThrow(
      "lifecycle audit unavailable",
    );
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending'`;
    const count = mutations.length;
    await fail("audit", false);
    await service.retry(testCall(retrying), op!.id);
    expect(mutations).toHaveLength(count);
    expect(await entry(op!.id)).toMatchObject({
      state: "done",
      actor_kind: "user",
      actor_user_id: owner.user.id,
      via: "system",
      request_id: null,
    });
    const [event] = await sql<
      { actor_user_id: string; xmin: string }[]
    >`SELECT *,xmin::text FROM audit.events WHERE action='filesv2.create'`;
    expect(event).toMatchObject({ actor_user_id: owner.user.id, xmin: (await entry(op!.id)).xmin });
  });

  test("archive and restore complete the same journal/history/audit transaction and preserve ownership", async () => {
    const archived = await archive();
    await assertAtomic(archived.id, "archive");
    const original = (await operations.get(archived.id))!.snapshot!;
    const restored = await service.restore(call(), archived.id, { confirmPath: home() });
    expect(await root().stat(home())).toMatchObject({ uid: original.uid, gid: original.gid, mode: original.mode });
    await assertAtomic(restored.id, "restore");
    expect((await operations.get(archived.id))?.state).toBe("restored");
    expect((await entry(restored.id)).action).toBe("place.restore");
  });

  for (const method of ["adminDelete", "deleteDirectory", "deleteArchive"] as const) {
    test(`${method} completes deletion, journal, history and security audit together`, async () => {
      await provision();
      let deleted: { id: string };
      if (method === "deleteArchive") {
        const archived = await service.archive(call(), { area: "cloud", kind: "users", name: "alice" });
        deleted = await service.deleteArchive(call(), archived.id, { confirmPath: archived.path });
        expect((await operations.get(archived.id))?.state).toBe("deleted");
      } else if (method === "deleteDirectory") {
        deleted = await service.deleteDirectory(call(), { area: "cloud", kind: "users", name: "alice", confirmPath: home() });
      } else {
        await root().put(`${home()}/evidence.txt`, new Blob(["original"]));
        deleted = await service.adminDelete(call(), {
          area: "cloud",
          kind: "users",
          name: "alice",
          path: "evidence.txt",
          confirmPath: `${home()}/evidence.txt`,
        });
      }
      expect((await entry(deleted.id)).action).toBe("item.purge");
      await assertAtomic(deleted.id, "delete");
    });
  }

  test("automatic archive records the system and commits its audit with history", async () => {
    await provision();
    config.cloud.autoArchive = true;
    await sql`DELETE FROM auth.users WHERE id=${owner.user.id}::uuid`;
    const result = await lifecycle.maintain();
    expect(result.archived).toBe(1);
    const [row] = (await history()).filter((row) => row.action === "place.archive");
    expect(row).toMatchObject({
      state: "done",
      actor_kind: "system",
      actor_user_id: null,
      via: "system",
      detail: { job: "automatic-archive" },
    });
    const [event] = await sql<
      { actor_user_id: string | null; xmin: string }[]
    >`SELECT *,xmin::text FROM audit.events WHERE action='filesv2.archive'`;
    expect(event).toMatchObject({ actor_user_id: null, xmin: row!.xmin });
  });

  test("automatic archive intent failure makes no mutation; audit failure leaves a pending journal for maintenance", async () => {
    await provision();
    config.cloud.autoArchive = true;
    await sql`DELETE FROM auth.users WHERE id=${owner.user.id}::uuid`;
    mutations.length = 0;
    await fail("intent");
    expect((await lifecycle.maintain()).archived).toBe(0);
    expect(mutations).toHaveLength(0);
    expect(await sql`SELECT 1 FROM filesv2.operations WHERE action='archive'`).toHaveLength(0);
    await fail("intent", false);
    await fail("audit");
    expect((await lifecycle.maintain()).archived).toBe(0);
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE action='archive'`;
    expect((await entry(op!.id)).state).toBe("pending");
    const count = mutations.length;
    await sql`UPDATE filesv2.activity SET heartbeat_at=${old} WHERE operation_id=${op!.id}::uuid`;
    await fail("audit", false);
    await lifecycle.maintain();
    expect(mutations).toHaveLength(count);
    expect(await entry(op!.id)).toMatchObject({ state: "done", actor_kind: "system", via: "system", heartbeat_at: old });
  });

  for (const action of ["create", "archive", "restore", "delete"] as const) {
    test(`${action}: an intent failure commits no journal and makes zero user-data mutations`, async () => {
      const archived = action === "restore" ? await archive() : null;
      if (action !== "create" && action !== "restore") await provision();
      const count = (await history()).length;
      mutations.length = 0;
      await fail("intent");
      const run = () =>
        action === "create"
          ? provision()
          : action === "archive"
            ? service.archive(call(), { area: "cloud", kind: "users", name: "alice" })
            : action === "restore"
              ? service.restore(call(), archived!.id, { confirmPath: home() })
              : service.deleteDirectory(call(), { area: "cloud", kind: "users", name: "alice", confirmPath: home() });
      await expect(run()).rejects.toThrow("lifecycle intent unavailable");
      expect(mutations).toHaveLength(0);
      expect(await history()).toHaveLength(count);
      expect(await sql`SELECT 1 FROM filesv2.operations WHERE state='pending'`).toHaveLength(0);
    });

    test(`${action}: an audit failure leaves both records pending; another actor retries the saved receipt exactly once`, async () => {
      const archived = action === "restore" ? await archive() : null;
      if (action !== "create" && action !== "restore") await provision();
      await fail("audit");
      const run = () =>
        action === "create"
          ? provision()
          : action === "archive"
            ? service.archive(call(), { area: "cloud", kind: "users", name: "alice" })
            : action === "restore"
              ? service.restore(call(), archived!.id, { confirmPath: home() })
              : service.deleteDirectory(call(), { area: "cloud", kind: "users", name: "alice", confirmPath: home() });
      await expect(run()).rejects.toThrow("lifecycle audit unavailable");
      const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending'`;
      expect(op).toMatchObject({ action, state: "pending", effect_started: true });
      expect(op!.receipt).not.toBeNull();
      expect((await entry(op!.id)).state).toBe("pending");
      expect(await sql`SELECT 1 FROM audit.events WHERE target_id=${op!.id}`).toHaveLength(0);
      const effectCount = mutations.length;
      await fail("audit", false);
      const retryCall = { ...testCall(retrying), via: "cli" as const, requestId: "retry-request" };
      await service.retry(retryCall, op!.id);
      await service.retry(retryCall, op!.id);
      expect(mutations).toHaveLength(effectCount);
      expect((await history()).filter((row) => row.operation_id === op!.id)).toHaveLength(1);
      await assertAtomic(op!.id, action);
    });
  }

  test("lost mkdir response stays unclear; an ordinary directory never proves creation and is never recreated", async () => {
    loseResponse = (mutation) => mutation.endpoint === "directories" && mutation.path === home();
    await expect(provision()).rejects.toThrow("lost lifecycle response");
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE state='pending'`;
    expect(op).toMatchObject({ action: "create", receipt: null, effect_started: true });
    expect((await root().stat(home())).directory).toBe(true);
    const count = mutations.length;
    loseResponse = undefined;
    rejectRootProbe = false;
    probeParents.length = 0;
    await expect(service.retry(testCall(retrying), op!.id)).rejects.toMatchObject({ code: "operation_unresolved" });
    await sql`UPDATE filesv2.activity SET heartbeat_at=${old},started_at=${old},next_check_at=${old} WHERE operation_id=${op!.id}::uuid`;
    await recoverActivity({ now, config, connect: connectFilegate });
    expect((await entry(op!.id)).state).toBe("unclear");
    expect(mutations).toHaveLength(count);
    expect((await operations.get(op!.id))?.state).toBe("pending");
  });

  test("lost restore response stays unclear, even with matching source snapshot at the ordinary destination", async () => {
    const archived = await archive();
    loseResponse = (mutation) => mutation.endpoint === "transfers";
    await expect(service.restore(call(), archived.id, { confirmPath: home() })).rejects.toThrow("lost lifecycle response");
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE action='restore'`;
    expect(op).toMatchObject({ state: "pending", receipt: null, effect_started: true });
    const count = mutations.length;
    loseResponse = undefined;
    rejectRootProbe = false;
    probeParents.length = 0;
    await expect(service.retry(testCall(retrying), op!.id)).rejects.toMatchObject({ code: "operation_unresolved" });
    await sql`UPDATE filesv2.activity SET heartbeat_at=${old},started_at=${old},next_check_at=${old} WHERE operation_id=${op!.id}::uuid`;
    await recoverActivity({ now, config, connect: connectFilegate });
    expect((await entry(op!.id)).state).toBe("unclear");
    expect(mutations).toHaveLength(count);
    expect((await operations.get(archived.id))?.state).toBe("complete");
  });

  test("UUID archive evidence reconciles in stale maintenance without a second move or heartbeat refresh", async () => {
    await provision();
    await fail("audit");
    loseResponse = (mutation) => mutation.endpoint === "transfers";
    await expect(service.archive(call(), { area: "cloud", kind: "users", name: "alice" })).rejects.toThrow("lifecycle audit unavailable");
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE action='archive'`;
    expect(op!.target).toEndWith(`/${op!.id}/contents`);
    // Model a crash after Filegate's response, before the receipt was persisted.
    await sql`UPDATE filesv2.operations SET receipt=NULL WHERE id=${op!.id}::uuid`;
    await sql`UPDATE filesv2.activity SET heartbeat_at=${old},started_at=${old},next_check_at=${old} WHERE operation_id=${op!.id}::uuid`;
    await fail("audit", false);
    loseResponse = undefined;
    rejectRootProbe = false;
    probeParents.length = 0;
    const count = mutations.length;
    await lifecycle.maintain();
    expect(mutations).toHaveLength(count);
    expect((await entry(op!.id)).heartbeat_at).toEqual(old);
    await assertAtomic(op!.id, "archive");
  });

  test("lost deletion response is not success and a replacement is never removed", async () => {
    await provision();
    loseResponse = (mutation) => mutation.method === "DELETE";
    await expect(service.deleteDirectory(call(), { area: "cloud", kind: "users", name: "alice", confirmPath: home() })).rejects.toThrow(
      "lost lifecycle response",
    );
    const [op] = await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE action='delete'`;
    const count = mutations.length;
    loseResponse = undefined;
    rejectRootProbe = false;
    probeParents.length = 0;
    await expect(service.retry(testCall(retrying), op!.id)).rejects.toMatchObject({ code: "operation_unresolved" });
    await root().mkdir(home(), { ownership: { dirMode: "0755" } });
    await expect(service.retry(testCall(retrying), op!.id)).rejects.toMatchObject({ code: "source_changed" });
    expect((await root().stat(home())).mode).toMatch(/755$/);
    expect(mutations).toHaveLength(count);
    expect((await entry(op!.id)).state).toBe("pending");
  });

  test("maintenance does not execute pending user writes or renew their heartbeat; recovery can mark them unclear", async () => {
    await provision();
    const op = await pending("delete");
    await sql`UPDATE filesv2.activity SET heartbeat_at=${old},started_at=${old},next_check_at=${old} WHERE operation_id=${op.id}::uuid`;
    const count = mutations.length;
    await lifecycle.maintain();
    await lifecycle.maintain();
    expect((await entry(op.id)).heartbeat_at).toEqual(old);
    expect((await operations.get(op.id))?.effect_started).toBe(false);
    expect(mutations).toHaveLength(count);
    await recoverActivity({ now, config, connect: connectFilegate });
    expect((await entry(op.id)).state).toBe("unclear");
  });

  test("legacy journal adoption retains its actor and unknown channel once; purged terminal history never resurrects", async () => {
    await provision();
    const id = crypto.randomUUID();
    const node = await root().stat(home());
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,snapshot,actor_id,actor_name,created_at,updated_at)
      VALUES(${id}::uuid,'cloud','users','cloud',${config.url},'alice','delete',${home()},${node}::jsonb,${owner.user.id}::uuid,'alice',${old},${old})`;
    await service.retry(testCall(retrying), id);
    const row = await entry(id);
    expect(row).toMatchObject({
      actor_kind: "user",
      actor_user_id: owner.user.id,
      via: "unknown",
      state: "done",
      started_at: old,
      detail: { adopted: true },
    });
    expect(row.detail.job).toBeUndefined();
    const [event] = await sql<{ actor_user_id: string }[]>`SELECT * FROM audit.events WHERE target_id=${id} AND action='filesv2.delete'`;
    expect(event?.actor_user_id).toBe(owner.user.id);
    await purgeActivity({ now, retentionDays: 365 });
    expect(await sql`SELECT 1 FROM filesv2.activity WHERE operation_id=${id}::uuid`).toHaveLength(0);
    await service.retry(testCall(retrying), id);
    expect(await operations.history(id)).toBeNull();
    expect(await sql`SELECT 1 FROM filesv2.activity WHERE operation_id=${id}::uuid`).toHaveLength(0);
  });

  test("an executable unclear operation survives retention and only expires after journal completion", async () => {
    await provision();
    const op = await pending("delete");
    await sql`UPDATE filesv2.activity SET state='unclear',started_at=${old},heartbeat_at=${old} WHERE operation_id=${op.id}::uuid`;
    await purgeActivity({ now, retentionDays: 365 });
    expect((await entry(op.id)).state).toBe("unclear");
    await service.retry(testCall(retrying), op.id);
    expect((await entry(op.id)).state).toBe("done");
    await purgeActivity({ now, retentionDays: 365 });
    expect(await sql`SELECT 1 FROM filesv2.activity WHERE operation_id=${op.id}::uuid`).toHaveLength(0);
  });

  test("legacy terminal adoption uses journal dates and produces no invented security audit", async () => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,state,actor_id,created_at,updated_at)
      VALUES(${id}::uuid,'cloud','users','cloud',${config.url},'alice','create',${home()},'complete',${owner.user.id}::uuid,${old},${old})`;
    await service.retry(testCall(retrying), id);
    const row = await entry(id);
    expect(row).toMatchObject({
      state: "done",
      via: "unknown",
      actor_user_id: owner.user.id,
      started_at: old,
      finished_at: old,
      detail: { adopted: true },
    });
    expect(await sql`SELECT 1 FROM audit.events`).toHaveLength(0);
  });

  test("persisted mkdir bindings reject forged paths, ownership, ACLs, other effects and duplicate allowed writes", async () => {
    const parent = `${config.cloud.prefix}/users`;
    const allowed = home();
    const mkdirs: LifecycleMkdir[] = [
      { path: parent, options: { ownership: { dirMode: "0700" } } },
      {
        path: allowed,
        options: {
          ownership: { dirMode: "0700" },
          acl: {
            access: {
              entries: [
                { tag: "owner", permissions: "rwx" },
                { tag: "owningGroup", permissions: "---" },
                { tag: "other", permissions: "---" },
              ],
            },
          },
        },
      },
    ];
    const op = await pending("create", mkdirs);
    // Mutating the caller's plan after commit cannot change the guard's authority.
    mkdirs.push({ path: `${config.cloud.prefix}/forged`, options: {} });
    const facade = connectFilegate(config, transport);
    const connected = facade.root("cloud");
    const mismatch = { code: "activity_scope_mismatch" };
    const id = (await entry(op.id)).id;
    await journalAction(id, async () => {
      await expect(connected.mkdir(`${config.cloud.prefix}/forged`)).rejects.toMatchObject(mismatch);
      await expect(connected.mkdir(parent, { ownership: { dirMode: "0755" } })).rejects.toMatchObject(mismatch);
      await expect(connected.mkdir(allowed, { ownership: { dirMode: "0700" } })).rejects.toMatchObject(mismatch);
      await expect(facade.root("freeipa").mkdir(parent, mkdirs[0]!.options)).rejects.toMatchObject(mismatch);
      await expect(
        connectFilegate({ ...config, url: "http://other-filegate.example.test" })
          .root("cloud")
          .mkdir(parent, mkdirs[0]!.options),
      ).rejects.toMatchObject(mismatch);
      await expect(connected.put(parent, new Blob(["forged"]))).rejects.toMatchObject(mismatch);
      await expect(connected.remove(parent, true)).rejects.toMatchObject(mismatch);
      await connected.mkdir(parent, mkdirs[0]!.options);
      await expect(connected.mkdir(parent, mkdirs[0]!.options)).rejects.toMatchObject(mismatch);
      await connected.mkdir(allowed, mkdirs[1]!.options);
      await expect(connected.as({ uid: 1001, gid: 1001 }).mkdir(allowed, mkdirs[1]!.options)).rejects.toMatchObject(mismatch);
    });
    expect(mutations.map((mutation) => mutation.path)).toEqual([parent, allowed]);
    await expect(connected.mkdir(allowed, mkdirs[1]!.options)).rejects.toMatchObject({ code: "activity_scope_missing" });
  });

  test("archive scope binds server, both roots, source, target, move and every option, once", async () => {
    await provision();
    const op = await pending("archive");
    const parent = op.target!.split("/").slice(0, -1).join("/");
    const archiveRoot = `${config.cloud.prefix}/archive`;
    await root().mkdir(archiveRoot, { ownership: { dirMode: "0700" } });
    await root().mkdir(parent, { ownership: { dirMode: "0700" } });
    mutations.length = 0;
    const connected = connectFilegate(config, transport).root("cloud");
    const id = (await entry(op.id)).id;
    const mismatch = { code: "activity_scope_mismatch" };
    await journalAction(id, async () => {
      await expect(connected.transfer(`${home()}/other`, "cloud", op.target!, { move: true, onConflict: "error" })).rejects.toMatchObject(
        mismatch,
      );
      await expect(connected.transfer(home(), "freeipa", op.target!, { move: true, onConflict: "error" })).rejects.toMatchObject(mismatch);
      await expect(connected.transfer(home(), "cloud", `${op.target!}-other`, { move: true, onConflict: "error" })).rejects.toMatchObject(
        mismatch,
      );
      await expect(connected.transfer(home(), "cloud", op.target!, { move: false, onConflict: "error" })).rejects.toMatchObject(mismatch);
      await expect(connected.transfer(home(), "cloud", op.target!, { move: true, onConflict: "rename" })).rejects.toMatchObject(mismatch);
      await expect(
        connected.transfer(home(), "cloud", op.target!, { move: true, onConflict: "error", ownership: { dirMode: "0777" } }),
      ).rejects.toMatchObject(mismatch);
      await expect(connected.remove(home(), true)).rejects.toMatchObject(mismatch);
      await connected.transfer(home(), "cloud", op.target!, { move: true, onConflict: "error" });
      await expect(connected.transfer(home(), "cloud", op.target!, { move: true, onConflict: "error" })).rejects.toMatchObject(mismatch);
    });
    expect(mutations).toHaveLength(1);
  });

  test("deletion scope allows only its original source with recursive=true, once", async () => {
    await provision();
    const op = await pending("delete");
    const connected = connectFilegate(config, transport).root("cloud");
    const count = mutations.length;
    await journalAction((await entry(op.id)).id, async () => {
      await expect(connected.remove(`${home()}/other`, true)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      await expect(connected.remove(home(), false)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      await expect(connected.mkdir(home())).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      await connected.remove(home(), true);
      await expect(connected.remove(home(), true)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
    });
    expect(mutations).toHaveLength(count + 1);
  });

  test("retire is idempotent and an audit failure rolls back both lifecycle and new history", async () => {
    await provision();
    const count = (await history()).length;
    await fail("audit");
    await expect(service.retire(call(), { area: "cloud", kind: "users", name: "alice" })).rejects.toThrow("lifecycle audit unavailable");
    expect((await bindings.path("cloud", home()))?.lifecycle).toBe("active");
    expect(await history()).toHaveLength(count);
    await fail("audit", false);
    const retired = await service.retire(call(), { area: "cloud", kind: "users", name: "alice" });
    await service.retire(call(), { area: "cloud", kind: "users", name: "alice" });
    const rows = (await history()).filter((row) => row.action === "place.retire");
    expect(rows).toHaveLength(1);
    const [event] = await sql<
      { xmin: string }[]
    >`SELECT xmin::text FROM audit.events WHERE target_id=${retired.id} AND action='filesv2.retire'`;
    const [base] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM filesv2.bases WHERE id=${retired.id}::uuid`;
    expect(event?.xmin).toBe(rows[0]!.xmin);
    expect(base?.xmin).toBe(rows[0]!.xmin);
  });
});
