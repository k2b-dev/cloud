import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { type CapabilityExecutionContext, UserSchema } from "@k2b/cloud/contracts";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities } from "@k2b/cloud/services";
import { Filegate, FilegateError } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor, testInfra } from "../../../scripts/fixtures/test-infra";
import { filesCapabilities } from "../src/capabilities";
import type { Configuration } from "../src/contracts";
import { bindings } from "../src/data/bases";
import { withRootLock } from "../src/data/operations";
import { migrate } from "../src/migrate";
import { createFilesService, filesService } from "../src/service";
import { currentActivityId, fileAction, type Intent, purgeActivity, recoverActivity } from "../src/service/activity";
import { FilesError } from "../src/service/errors";
import { connectFilegate, type FilesFilegate } from "../src/service/filegate-facade";
import { testActor, testCall } from "./files-call";
import { assertPrivateDatabase, localFilegateToken } from "./private-database";

const suite = suiteFor("database", "filegate", "nats");
const now = new Date("2030-05-15T12:00:00Z");
const day = 86_400_000;
type State = "pending" | "done" | "failed" | "not_done" | "unclear";
type Row = {
  id: string;
  state: State;
  checks: number;
  started_at: Date;
  next_check_at: Date | number;
  finished_at: Date | null;
  actor_user_id: string | null;
  via: string;
  path_after: string;
  request_id: string | null;
  batch_id: string | null;
  error_code: string | null;
  detail: Record<string, unknown>;
  xmin: string;
};

suite("Files activity with real storage", () => {
  const prefix = `filesv2-activity-${Bun.randomUUIDv7()}`;
  let processSync: ProcessSync | undefined;
  let client: Filegate;
  let facade: FilesFilegate;
  let config: Configuration & { token: string; tokenConfigured: boolean; unreadable: boolean };
  let service: ReturnType<typeof createFilesService>;
  let actor: Extract<RequestActor, { kind: "user" }>;
  let ipa: Extract<RequestActor, { kind: "user" }>;
  let bindingId: string;
  const copyGroup = { id: Bun.randomUUIDv7(), provider: "local" as const, name: "copy-team", gidNumber: 32002, personal: false };
  const home = `${prefix}/users/alice`;
  const baseId = () => `cloud:users:${actor.user.id}`;
  const intent = (name: string): Intent => ({
    action: "folder.create",
    serverUrl: config.url,
    root: "cloud",
    baseId: bindingId,
    directory: true,
    name,
    pathAfter: `${home}/${name}`,
  });
  const row = async (id: string) => (await sql<Row[]>`SELECT *,xmin::text FROM filesv2.activity WHERE id=${id}::uuid`)[0]!;
  async function seed(
    input: { state?: State; checks?: number; started?: Date; heartbeat?: Date; next?: Date; path?: string; actorId?: string } = {},
  ): Promise<string> {
    const id = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,directory,name,path_after,actor_kind,actor_user_id,via,started_at,heartbeat_at,next_check_at,checks)
      VALUES(${id}::uuid,${input.state ?? "pending"},'folder.create',${config.url},'cloud',${bindingId}::uuid,true,'seed',${input.path ?? `${home}/seed`},'user',${input.actorId ?? actor.user.id}::uuid,'web',${input.started ?? new Date(now.getTime() - day)},${input.heartbeat ?? new Date(now.getTime() - 120_000)},${input.next ?? new Date(now.getTime() - 1)},${input.checks ?? 0})`;
    return id;
  }
  const recover = (at = now, configuration = config) => recoverActivity({ now: at, connect: connectFilegate, config: configuration });
  beforeAll(async () => {
    await assertPrivateDatabase();
    processSync = await startProcessSync({ application: "filesv2" });
    const token = await localFilegateToken();
    config = {
      activityRetentionDays: 365,
      url: testInfra.filegate!,
      token,
      tokenConfigured: true,
      unreadable: false,
      cloud: {
        enabled: true,
        root: "cloud",
        prefix,
        homes: "users",
        groups: "groups",
        archive: "archive",
        autoCreate: false,
        autoArchive: false,
      },
      freeipa: { enabled: true, root: "freeipa", prefix, homes: "users", groups: "groups", archive: "archive" },
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
    };
    client = new Filegate({ baseUrl: config.url, transferBaseUrl: config.url, token });
    facade = connectFilegate(config);
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await migrate();
    await sql`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS display_name text, ADD COLUMN IF NOT EXISTS avatar_hash text`.simple();
    if (testActor.kind !== "user") throw new Error("expected user fixture");
    actor = { ...testActor, user: { ...testActor.user, id: Bun.randomUUIDv7(), uid: "alice" } };
    ipa = {
      ...actor,
      user: UserSchema.parse({
        ...actor.user,
        id: Bun.randomUUIDv7(),
        uid: "ipa-alice",
        provider: "ipa",
        ipa: {
          uidNumber: 31001,
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
    for (const user of [actor.user, ipa.user])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${user.id}::uuid,${user.uid},${user.provider},'user',false)`;
    for (const name of ["cloud", "freeipa"]) {
      await client.root(name).mkdir(prefix, { ownership: { dirMode: "0755" } });
      await client.root(name).mkdir(`${prefix}/users`, { ownership: { dirMode: "0755" } });
    }
    await client.root("cloud").mkdir(home, { ownership: { dirMode: "0700" } });
    await client.root("freeipa").mkdir(`${prefix}/users/ipa-alice`, { ownership: { uid: 31001, gid: 32001, dirMode: "0700" } });
    bindingId = (
      await bindings.claim({
        area: "cloud",
        kind: "users",
        identity_id: actor.user.id,
        identity_name: "alice",
        root: "cloud",
        path: home,
        uid_number: null,
        gid_number: null,
      })
    )[0]!.id;
    service = createFilesService({
      identities: {
        ...accountIdentities,
        self: async (requestActor) => {
          const user = requestActor.kind === "user" ? requestActor.user : requestActor.delegatedUser;
          if (!user) throw new FilesError("forbidden", 403);
          return {
            user: {
              id: user.id,
              username: user.uid,
              provider: user.provider,
              profile: user.profile,
              posix: user.provider === "ipa" ? { uidNumber: 31001, primaryGidNumber: 32001 } : null,
            },
            availability: { localLinuxEnabled: true, freeipaEnabled: true },
          };
        },
        groups: async () => ({ items: [copyGroup], nextCursor: null }),
        inventory: async () => {
          throw new FilesError("forbidden", 403);
        },
      },
      displayNames: resolveDisplayNames,
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      publicOrigin: async () => "https://cloud.test",
      userById: async () => null,
      transfer: fetch,
      connect: connectFilegate,
    });
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.activity`;
  });
  afterAll(async () => {
    try {
      if (client)
        for (const name of ["cloud", "freeipa"])
          await client
            .root(name)
            .remove(prefix, true)
            .catch(() => undefined);
    } finally {
      await processSync?.stop();
    }
  });

  test("intent insertion failure makes zero Filegate requests and leaves no folder", async () => {
    let sent = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init?.method && !["GET", "HEAD"].includes(init.method)) sent++;
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    // Count all mutation requests as well as verifying the externally visible result.
    const counted = createFilesService({ ...serviceDependencies(), connect: (configuration) => connectFilegate(configuration, transport) });
    await sql`CREATE OR REPLACE FUNCTION filesv2.reject_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intent unavailable'; END $$`.simple();
    await sql`CREATE TRIGGER reject_activity BEFORE INSERT ON filesv2.activity FOR EACH ROW EXECUTE FUNCTION filesv2.reject_activity()`.simple();
    try {
      await expect(counted.mkdir(testCall(actor), { baseId: baseId(), path: "fail-closed" })).rejects.toThrow("intent unavailable");
      expect(sent).toBe(0);
      await expect(client.root("cloud").stat(`${home}/fail-closed`)).rejects.toMatchObject({ status: 404 });
    } finally {
      await sql`DROP TRIGGER reject_activity ON filesv2.activity`.simple();
      await sql`DROP FUNCTION filesv2.reject_activity()`.simple();
    }
  });
  function serviceDependencies(): NonNullable<Parameters<typeof createFilesService>[0]> {
    return {
      identities: {
        ...accountIdentities,
        self: async () => ({
          user: { id: actor.user.id, username: "alice", provider: "local", profile: "user", posix: null },
          availability: { localLinuxEnabled: true, freeipaEnabled: true },
        }),
        groups: async () => ({ items: [], nextCursor: null }),
      },
      displayNames: resolveDisplayNames,
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      publicOrigin: async () => "https://cloud.test",
      userById: async () => null,
      transfer: fetch,
      connect: connectFilegate,
    };
  }
  function guardedTransport() {
    let sent = 0;
    const transport: typeof fetch = Object.assign(
      async () => {
        sent++;
        return Response.json({ path: `${home}/guarded`, directory: true });
      },
      { preconnect: fetch.preconnect },
    );
    return { client: connectFilegate(config, transport), transport, sent: () => sent };
  }
  test.each(["target", "parent", "ancestor"])("persisted folder intent permits its %s", async (part) => {
    const f = guardedTransport();
    const path = part === "target" ? `${home}/guarded` : part === "parent" ? home : prefix;
    await fileAction(
      testCall(actor),
      intent("guarded"),
      () => f.client.as({ uid: 31001, gid: 32001 }).root("cloud").as({ uid: 31001, gid: 32001 }).mkdir(path),
      async () => {},
    );
    expect(f.sent()).toBe(1);
    expect((await sql`SELECT state FROM filesv2.activity`)[0]).toMatchObject({ state: "done" });
  });
  test.each(["sibling", "child", "prefix", "root", "server"])("persisted folder intent refuses a different %s", async (part) => {
    const f = guardedTransport();
    const root =
      part === "server"
        ? connectFilegate({ ...config, url: "https://other.test" }, f.transport).root("cloud")
        : f.client.root(part === "root" ? "freeipa" : "cloud");
    const path =
      part === "sibling"
        ? `${home}/sibling`
        : part === "child"
          ? `${home}/guarded/child`
          : part === "prefix"
            ? `${home}-other`
            : `${home}/guarded`;
    await expect(
      fileAction(
        testCall(actor),
        intent("guarded"),
        () => root.mkdir(path),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "activity_scope_mismatch" });
    expect(f.sent()).toBe(0);
  });
  test("persisted folder intent refuses every other mutation before transport", async () => {
    const f = guardedTransport();
    const root = f.client.root("cloud");
    const path = `${home}/guarded`;
    const mutations = [
      () => root.put(path, new Blob(["data"])),
      () => root.createSession(path, 4),
      () => root.commitSession("session"),
      () => root.abortSession("session"),
      () => root.transfer(path, "cloud", `${home}/other`),
      () => root.restore(path, "version"),
      () => root.copyVersion(path, "version", "cloud", `${home}/other`),
      () => root.updateVersion(path, "version", { pinned: false }),
      () => root.deleteVersion(path, "version"),
      () => root.remove(path),
    ];
    await fileAction(
      testCall(actor),
      intent("guarded"),
      async () => {
        for (const mutate of mutations) await expect(mutate()).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      },
      async () => {},
    );
    expect(f.sent()).toBe(0);
  });
  test("changing the caller's intent cannot redirect a persisted scope", async () => {
    const f = guardedTransport();
    const input = intent("guarded");
    await fileAction(
      testCall(actor),
      input,
      async () => {
        input.pathAfter = `${home}/victim`;
        await expect(f.client.root("cloud").mkdir(input.pathAfter)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        await f.client.root("cloud").mkdir(`${home}/guarded`);
      },
      async () => {},
    );
    expect(f.sent()).toBe(1);
    expect((await sql`SELECT path_after FROM filesv2.activity`)[0]).toMatchObject({ path_after: `${home}/guarded` });
  });
  test("a closed persisted scope refuses an inherited asynchronous write", async () => {
    const f = guardedTransport();
    const release = Promise.withResolvers<void>();
    let stray: Promise<unknown> = Promise.resolve();
    await fileAction(
      testCall(actor),
      intent("guarded"),
      async () => {
        stray = release.promise.then(() => f.client.root("cloud").mkdir(`${home}/guarded`));
      },
      async () => {},
    );
    const refused = stray.catch((error: unknown) => error);
    release.resolve();
    expect(await refused).toMatchObject({ code: "activity_scope_missing" });
    expect(f.sent()).toBe(0);
  });
  test("a terminal finish is idempotent, including xmin and finished_at", async () => {
    let id = "";
    let before: Row | undefined;
    const finish = mock(async () => ({ itemAfterId: "must-not-be-written" }));
    await fileAction(
      testCall(actor),
      intent("terminal"),
      async () => {
        id = currentActivityId() ?? "";
        if (!id) throw new Error("missing activity");
        await sql`UPDATE filesv2.activity SET state='done',finished_at=${now} WHERE id=${id}::uuid`;
        before = await row(id);
        return "answer";
      },
      finish,
    );
    const after = await row(id);
    expect(finish).not.toHaveBeenCalled();
    expect(after.xmin).toBe(before!.xmin);
    expect(after.finished_at).toEqual(now);
    expect((await sql`SELECT id FROM filesv2.activity`).length).toBe(1);
  });
  test("recovery skips rows locked by another transaction", async () => {
    const id = await seed();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = sql.begin(async (tx) => {
      await tx`SELECT id FROM filesv2.activity WHERE id=${id}::uuid FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    void owner.catch(locked.reject);
    try {
      await locked.promise;
      expect(await recover()).toEqual({ checked: 0 });
    } finally {
      release.resolve();
      await owner;
    }
    expect(await recover()).toEqual({ checked: 1 });
  });
  test.each([
    [0, 60_000],
    [1, 300_000],
    [2, 1_800_000],
    [3, 21_600_000],
    [8, 21_600_000],
  ])("claim backoff uses old checks %i", async (checks, delay) => {
    const id = await seed({ checks });
    await recover();
    expect((await row(id)).checks).toBe(checks + 1);
    expect((await row(id)).next_check_at).toEqual(new Date(now.getTime() + delay));
  });
  test("fresh heartbeats and terminal rows never change", async () => {
    const ids = [await seed({ heartbeat: new Date(now.getTime() - 59_000) })];
    for (const state of ["done", "failed", "not_done"] as const) ids.push(await seed({ state }));
    const before = await Promise.all(ids.map(row));
    expect(await recover()).toEqual({ checked: 0 });
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });
  test("lost mkdir response remains unclear even when the folder exists", async () => {
    const path = `${home}/lost-response`;
    await client.root("cloud").mkdir(path);
    const id = await seed({ path });
    await recover();
    expect(await row(id)).toMatchObject({ state: "unclear", detail: { observed_after: { exists: true, directory: true } } });
    await recover(new Date(now.getTime() + 60_001));
    expect((await row(id)).state).toBe("unclear");
  });
  test("observations are unavailable on unreadable or failing storage", async () => {
    const id = await seed();
    await recoverActivity({
      now,
      config: null,
      connect: () => {
        throw new Error("must not connect");
      },
    });
    expect(await row(id)).toMatchObject({ state: "unclear", detail: { observed_after: { state: "unavailable" } } });
    await sql`UPDATE filesv2.activity SET next_check_at=${now} WHERE id=${id}::uuid`;
    await recoverActivity({
      now,
      config,
      connect: () => {
        throw new Error("storage down");
      },
    });
    expect(await row(id)).toMatchObject({ state: "unclear", detail: { observed_after: { state: "unavailable" } } });
  });
  test("seven-day unclear entries become final without claiming done", async () => {
    const id = await seed({ state: "unclear", started: new Date(now.getTime() - 7 * day) });
    await recover();
    const result = await row(id);
    expect(result.state).toBe("unclear");
    expect(result.detail.final).toBe(true);
    const [infinite] = await sql<
      { final: boolean }[]
    >`SELECT next_check_at='infinity'::timestamptz AS final FROM filesv2.activity WHERE id=${id}::uuid`;
    expect(infinite?.final).toBe(true);
    expect(await recover(new Date(now.getTime() + day))).toEqual({ checked: 0 });
  });
  test("claims are bounded to 50 and heartbeat/cancellation are honored", async () => {
    for (let i = 0; i < 51; i++) await seed();
    const heartbeat = mock(async () => {});
    expect(await recoverActivity({ now, config: null, connect: connectFilegate, heartbeat })).toEqual({ checked: 50 });
    expect(heartbeat).toHaveBeenCalledTimes(50);
    const controller = new AbortController();
    controller.abort();
    await expect(recoverActivity({ now, config: null, connect: connectFilegate, signal: controller.signal })).rejects.toThrow();
  });
  test("retention removes expired terminal/unclear rows and keeps pending and the boundary", async () => {
    const old = new Date(now.getTime() - 366 * day);
    for (const state of ["done", "failed", "unclear", "not_done"] as const) await seed({ state, started: old });
    const pending = await seed({ started: old });
    const boundary = await seed({ state: "done", started: new Date(now.getTime() - 365 * day) });
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 4 });
    expect((await row(pending)).state).toBe("pending");
    expect((await row(boundary)).state).toBe("done");
  });
  test("retention deletes at most 10000 rows per call", async () => {
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,directory,name,actor_kind,via,started_at)
      SELECT gen_random_uuid(),'done','folder.create',${config.url},'cloud',true,'expired','system','system',${new Date(now.getTime() - 366 * day)} FROM generate_series(1,10005)`;
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 10000 });
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 5 });
  });
  test("account deletion removes the person link without deleting history", async () => {
    const userId = Bun.randomUUIDv7();
    await sql`INSERT INTO auth.users(id) VALUES(${userId}::uuid)`;
    const id = await seed({ actorId: userId });
    await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    expect((await row(id)).actor_user_id).toBeNull();
    expect((await row(id)).state).toBe("pending");
  });
  test("a path as long as Files accepts fits the history indexes", async () => {
    // Noncompressible segments: a full-path B-tree key of this size exceeds PostgreSQL's entry limit.
    const segments = Array.from({ length: 21 }, () => Buffer.from(crypto.getRandomValues(new Uint8Array(150))).toString("base64url"));
    const path = `${home}/${segments.join("/")}`.slice(0, 4096);
    expect(path.length).toBe(4096);
    const name = path.split("/").at(-1)!;
    await fileAction(
      testCall(actor),
      { ...intent(name), pathBefore: path, pathAfter: path },
      async () => ({ id: null }),
      async () => undefined,
    );
    const [stored] = await sql<{ state: string; path_after: string }[]>`SELECT state,path_after FROM filesv2.activity`;
    expect(stored).toEqual({ state: "done", path_after: path });
  });
  test.each(["rename", "move", "copy"] as const)("%s cannot change storage when its history insert fails", async (action) => {
    const name = `blocked-${action}.txt`;
    const folder = `blocked-${action}-target`;
    await client.root("cloud").put(`${home}/${name}`, new Blob(["original"]));
    await client.root("cloud").mkdir(`${home}/${folder}`);
    let sent = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init?.method === "POST" && String(input).endsWith("/transfers")) sent++;
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const counted = createFilesService({ ...serviceDependencies(), connect: (configuration) => connectFilegate(configuration, transport) });
    await sql`CREATE OR REPLACE FUNCTION filesv2.reject_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intent unavailable'; END $$`.simple();
    await sql`CREATE TRIGGER reject_activity BEFORE INSERT ON filesv2.activity FOR EACH ROW EXECUTE FUNCTION filesv2.reject_activity()`.simple();
    try {
      if (action === "rename")
        await expect(counted.rename(testCall(actor), { baseId: baseId(), path: name, name: `renamed-${name}` })).rejects.toThrow(
          "intent unavailable",
        );
      else {
        const input = { baseId: baseId(), paths: [name], folder, targetBaseId: baseId() };
        const result = action === "move" ? await counted.move(testCall(actor), input) : await counted.copy(testCall(actor), input);
        expect(result.results[0]?.ok).toBe(false);
      }
      expect(sent).toBe(0);
      expect((await client.root("cloud").stat(`${home}/${name}`)).size).toBe(8);
      expect(await sql`SELECT id FROM filesv2.activity`).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER reject_activity ON filesv2.activity`.simple();
      await sql`DROP FUNCTION filesv2.reject_activity()`.simple();
    }
  });
  test("a move batch retains successful and refused entries under one batch ID", async () => {
    const root = client.root("cloud");
    await root.mkdir(`${home}/partial-source`);
    await root.mkdir(`${home}/partial-target`);
    for (const name of ["one.txt", "two.txt"]) await root.put(`${home}/partial-source/${name}`, new Blob(["data"]));
    await root.put(`${home}/partial-target/two.txt`, new Blob(["keep"]));
    const result = await service.move(testCall(actor), {
      baseId: baseId(),
      paths: ["partial-source/one.txt", "partial-source/two.txt"],
      folder: "partial-target",
    });
    expect(result.results.map((item) => item.ok)).toEqual([true, false]);
    const rows = await sql`SELECT * FROM filesv2.activity ORDER BY name`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "item.move", state: "done" });
    expect(rows[1]).toMatchObject({ action: "item.move", state: "failed", error_code: "path_conflict" });
    expect(rows[0]!.batch_id).toBe(rows[1]!.batch_id);
    expect(rows[0]!.batch_id).not.toBeNull();
  });
  test("rename and a normalized directory move record stable identity and one batch row per selection", async () => {
    const root = client.root("cloud");
    await root.mkdir(`${home}/rename-source`);
    await root.mkdir(`${home}/rename-source/child`);
    await root.mkdir(`${home}/move-target`);
    const original = await root.stat(`${home}/rename-source`);
    const call = {
      ...testCall(actor),
      via: "agent" as const,
      callingApp: "assistant",
      origin: "assistant",
      invocationId: "move-invocation",
    };
    await service.rename(call, { baseId: baseId(), path: "rename-source", name: "renamed" });
    const moved = await service.move(call, { baseId: baseId(), paths: ["renamed", "renamed/child"], folder: "move-target" });
    expect(moved.results).toHaveLength(1);
    const rows = await sql`SELECT * FROM filesv2.activity ORDER BY started_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: "item.rename",
      state: "done",
      path_before: `${home}/rename-source`,
      path_after: `${home}/renamed`,
      actor_user_id: actor.user.id,
      via: "agent",
      invocation_id: "move-invocation",
    });
    expect(rows[1]).toMatchObject({
      action: "item.move",
      state: "done",
      path_before: `${home}/renamed`,
      path_after: `${home}/move-target/renamed`,
      base_id: bindingId,
      base_after_id: bindingId,
    });
    expect(rows[1]!.batch_id).not.toBeNull();
    if ((await root.info()).stableIds) {
      expect(rows[0]!.item_id).toBe(original.id);
      expect(rows[1]!.item_after_id).toBe(original.id);
    }
  });
  test("same-folder copy records the returned conflict-renamed path and new identity", async () => {
    const root = client.root("cloud");
    await root.put(`${home}/copy-original.txt`, new Blob(["copy"]));
    const original = await root.stat(`${home}/copy-original.txt`);
    const copied = await service.copy(testCall(actor), {
      baseId: baseId(),
      paths: ["copy-original.txt"],
      targetBaseId: baseId(),
      folder: "",
    });
    expect(copied.results[0]?.ok).toBe(true);
    const rows = await sql`SELECT * FROM filesv2.activity`;
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry).toMatchObject({
      action: "item.copy",
      state: "done",
      path_before: `${home}/copy-original.txt`,
      root: "cloud",
      root_after: "cloud",
    });
    expect(entry.path_after).not.toBe(entry.path_before);
    expect((await root.stat(entry.path_after)).size).toBe(4);
    if ((await root.info()).stableIds) {
      expect(entry.item_id).toBe(original.id);
      expect(entry.item_after_id).not.toBe(original.id);
    }
  });
  test("copy holds the source publication lock while sending the identity-bound transfer", async () => {
    await client.root("cloud").put(`${home}/locked-copy.txt`, new Blob(["original"]));
    const source = await client.root("cloud").stat(`${home}/locked-copy.txt`);
    let checked = false;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init?.method === "POST" && String(input).endsWith("/transfers")) {
          await expect(
            withRootLock("cloud", async () => {
              throw new Error("source was not protected");
            }),
          ).rejects.toThrow("operation_busy");
          checked = true;
        }
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const copying = createFilesService({ ...serviceDependencies(), connect: (configuration) => connectFilegate(configuration, transport) });
    const result = await copying.copy(testCall(actor), {
      baseId: baseId(),
      paths: ["locked-copy.txt"],
      targetBaseId: baseId(),
      folder: "",
    });
    expect(result.results[0]?.ok).toBe(true);
    expect(checked).toBe(true);
    const [entry] = await sql`SELECT * FROM filesv2.activity`;
    expect(entry!.state).toBe("done");
    if ((await client.root("cloud").info()).stableIds) expect(entry!.item_id).toBe(source.id);
  });
  test("a transfer scope authorizes one effect only", async () => {
    const f = guardedTransport();
    const input: Intent = { ...intent("target"), action: "item.copy", pathBefore: `${home}/source`, onConflict: "rename" };
    await fileAction(
      testCall(actor),
      input,
      async () => {
        await f.client.root("cloud").transfer(`${home}/source`, "cloud", `${home}/target`, { onConflict: "rename" });
        await expect(
          f.client.root("cloud").transfer(`${home}/source`, "cloud", `${home}/target`, { onConflict: "rename" }),
        ).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      },
      async () => {},
    );
    expect(f.sent()).toBe(1);
  });
  test("cross-root copy records both bindings and roots through the real service", async () => {
    const cloudHome = `${prefix}/groups/copy-team`;
    await client.root("cloud").mkdir(`${prefix}/groups`);
    await client.root("cloud").mkdir(cloudHome);
    await bindings.claim({
      area: "cloud",
      kind: "groups",
      identity_id: copyGroup.id,
      identity_name: copyGroup.name,
      root: "cloud",
      path: cloudHome,
      uid_number: null,
      gid_number: copyGroup.gidNumber,
    });
    const source = `${prefix}/users/ipa-alice/cross-root.txt`;
    await client.root("freeipa").put(source, new Blob(["cross"]), { ownership: { uid: 31001, gid: 32001, mode: "0600" } });
    const copied = await service.copy(testCall(ipa), {
      baseId: `freeipa:users:${ipa.user.id}`,
      paths: ["cross-root.txt"],
      targetBaseId: `cloud:groups:${copyGroup.id}`,
      folder: "",
    });
    expect(copied.results[0]?.ok).toBe(true);
    const rows = await sql`SELECT * FROM filesv2.activity`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "item.copy",
      state: "done",
      root: "freeipa",
      root_after: "cloud",
      path_before: source,
      path_after: `${cloudHome}/cross-root.txt`,
    });
    expect(rows[0]!.base_id).not.toBe(rows[0]!.base_after_id);
  });
  test.each(["rename", "move", "copy"] as const)("a lost %s response never becomes done from appearance", async (action) => {
    const name = `lost-${action}.txt`;
    const folder = `lost-${action}-target`;
    await client.root("cloud").put(`${home}/${name}`, new Blob(["data"]));
    await client.root("cloud").mkdir(`${home}/${folder}`);
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, init);
        if (init?.method === "POST" && String(input).endsWith("/transfers") && response.ok) throw new Error("lost transfer response");
        return response;
      },
      { preconnect: fetch.preconnect },
    );
    const losing = createFilesService({ ...serviceDependencies(), connect: (configuration) => connectFilegate(configuration, transport) });
    if (action === "rename")
      await expect(losing.rename(testCall(actor), { baseId: baseId(), path: name, name: `renamed-${name}` })).rejects.toThrow(
        "lost transfer response",
      );
    else {
      const input = { baseId: baseId(), paths: [name], folder, targetBaseId: baseId() };
      const result = action === "move" ? await losing.move(testCall(actor), input) : await losing.copy(testCall(actor), input);
      expect(result.results[0]?.ok).toBe(false);
    }
    const [entry] = await sql`SELECT * FROM filesv2.activity`;
    expect(entry!.state).toBe("pending");
    await sql`UPDATE filesv2.activity SET started_at=${new Date(now.getTime() - day)},heartbeat_at=${new Date(now.getTime() - 120_000)},next_check_at=${now}`;
    await recover();
    const recovered = await row(entry!.id);
    expect(recovered.state).toBe("unclear");
    expect(recovered.detail.observed_before).toMatchObject({ exists: action === "copy" });
    expect(recovered.detail.observed_after).toMatchObject({ exists: true });
  });
  test.each(["source", "target", "target-root", "move", "conflict", "method"])(
    "persisted transfer intent rejects a different %s before transport",
    async (part) => {
      const f = guardedTransport();
      const root = f.client.as({ uid: 31001, gid: 32001 }).root("cloud");
      const input: Intent = { ...intent("target"), action: "item.move", pathBefore: `${home}/source`, rootAfter: "cloud" };
      await expect(
        fileAction(
          testCall(actor),
          input,
          () =>
            part === "method"
              ? root.remove(`${home}/source`)
              : root.transfer(
                  part === "source" ? `${home}/other` : `${home}/source`,
                  part === "target-root" ? "freeipa" : "cloud",
                  part === "target" ? `${home}/elsewhere` : `${home}/target`,
                  { move: part !== "move", onConflict: part === "conflict" ? "rename" : "error" },
                ),
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      expect(f.sent()).toBe(0);
    },
  );

  test("web mkdir records one done row with actor, path, and request context", async () => {
    const call = { ...testCall(actor), requestId: "web-request" };
    await service.mkdir(call, { baseId: baseId(), path: "web-folder" });
    const rows = await sql<Row[]>`SELECT * FROM filesv2.activity`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "done",
      action: "folder.create",
      via: "web",
      actor_user_id: actor.user.id,
      request_id: "web-request",
      path_after: `${home}/web-folder`,
      base_id: bindingId,
    });
  });
  test("mkdirs records only created paths with one batch id", async () => {
    const call = testCall(actor);
    const paths = ["batch", "batch/child"];
    await service.mkdirs(call, { baseId: baseId(), paths, dryRun: true });
    expect((await sql`SELECT id FROM filesv2.activity`).length).toBe(0);
    const result = await service.mkdirs(call, { baseId: baseId(), paths, dryRun: false });
    expect(result.results.map((r) => r.state)).toEqual(["created", "created"]);
    const rows = await sql<Row[]>`SELECT * FROM filesv2.activity ORDER BY path_after`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
    expect(rows[0]!.batch_id).not.toBeNull();
    expect(rows.every((r) => r.state === "done")).toBe(true);
    await service.mkdirs(call, { baseId: baseId(), paths, dryRun: false });
    expect((await sql`SELECT id FROM filesv2.activity`).length).toBe(2);
  });
  test("FreeIPA derived clients record mkdir and refuse unscoped writes", async () => {
    await service.mkdir(testCall(ipa), { baseId: `freeipa:users:${ipa.user.id}`, path: "derived" });
    const [entry] = await sql<Row[]>`SELECT * FROM filesv2.activity`;
    expect(entry).toMatchObject({
      state: "done",
      actor_user_id: ipa.user.id,
      root: "freeipa",
      path_after: `${prefix}/users/ipa-alice/derived`,
    });
    await expect(facade.as({ uid: 31001, gid: 32001 }).root("freeipa").mkdir(`${prefix}/users/ipa-alice/unscoped`)).rejects.toMatchObject({
      code: "activity_scope_missing",
    });
  });
  test("a late real response replaces unclear after recovery loses the owner", async () => {
    const ready = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const action = fileAction(
      testCall(actor),
      intent("late"),
      async () => {
        const node = await facade.root("cloud").mkdir(`${home}/late`);
        const id = currentActivityId();
        if (!id) throw new Error("missing activity");
        await sql`UPDATE filesv2.activity SET started_at=${new Date(now.getTime() - day)},heartbeat_at=${new Date(now.getTime() - 120_000)},next_check_at=${now} WHERE id=${id}::uuid`;
        ready.resolve(id);
        await release.promise;
        return node;
      },
      async (_tx, node) => ({ itemAfterId: node.id ?? null }),
      { heartbeatMs: 60_000 },
    );
    try {
      const id = await Promise.race([
        ready.promise,
        action.then(() => {
          throw new Error("owner ended before recovery barrier");
        }),
      ]);
      await recover();
      expect((await row(id)).state).toBe("unclear");
    } finally {
      release.resolve();
      await action;
    }
    const [finished] = await sql<Row[]>`SELECT * FROM filesv2.activity`;
    expect(finished!.state).toBe("done");
  });
  test("concurrent mkdir creates one folder, one done and one certain failed entry", async () => {
    const results = await Promise.allSettled([
      service.mkdir(testCall(actor), { baseId: baseId(), path: "race" }),
      service.mkdir(testCall(actor), { baseId: baseId(), path: "race" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rows = await sql<Row[]>`SELECT * FROM filesv2.activity ORDER BY state`;
    expect(rows.map((r) => [r.state, r.error_code])).toEqual([
      ["done", null],
      ["failed", "path_conflict"],
    ]);
    expect((await client.root("cloud").list(home)).items.filter((node) => node.path === `${home}/race`)).toHaveLength(1);
  });
  test("folder capability records app and agent provenance through the real service", async () => {
    const mkdir = spyOn(filesService, "mkdir").mockImplementation(service.mkdir);
    try {
      for (const [origin, expected] of [
        ["app", "app:notebooks"],
        ["assistant", "agent"],
      ] as const) {
        const context: CapabilityExecutionContext = {
          actor: {
            ...actor,
            delegation: { kind: "invocation", callingAppId: "notebooks", credentialKind: "session", invocationId: `invoke-${origin}` },
          },
          accessSubject: testCall(actor).accessSubject,
          user: actor.user,
          locale: "en",
          requestId: `request-${origin}`,
          origin,
          signal: new AbortController().signal,
        };
        const result = await filesCapabilities.actions["folder.create"].run({ baseId: baseId(), path: `cap-${origin}` }, context);
        expect(result.ok).toBe(true);
        const [entry] = await sql<Row[]>`SELECT * FROM filesv2.activity WHERE request_id=${context.requestId}`;
        expect(entry).toMatchObject({
          state: "done",
          via: expected,
          origin,
          request_id: context.requestId,
          calling_app: "notebooks",
          invocation_id: `invoke-${origin}`,
        });
      }
    } finally {
      mkdir.mockRestore();
    }
  });
  test("only a certain no-change error finalizes failed; ambiguous failures remain pending", async () => {
    for (const error of [new FilesError("forbidden", 403), new FilesError("not_found", 404), new Error("lost response")]) {
      await expect(
        fileAction(
          testCall(actor),
          intent(error.message),
          async () => {
            throw error;
          },
          async () => {},
        ),
      ).rejects.toBe(error);
    }
    const rows = await sql<Row[]>`SELECT * FROM filesv2.activity ORDER BY started_at,id`;
    expect(rows.map((r) => r.state)).toEqual(["failed", "failed", "pending"]);
    const original = new FilegateError(409, "path_conflict", "not sent by the facade");
    await expect(
      fileAction(
        testCall(actor),
        intent("fabricated"),
        async () => {
          throw original;
        },
        async () => {},
      ),
    ).rejects.toBe(original);
    expect((await sql<Row[]>`SELECT * FROM filesv2.activity WHERE name='fabricated'`)[0]!.state).toBe("pending");
  });
  test.each(["unclear", "done", "failed", "not_done"] as const)(
    "a certain mkdir refusal replaces only a nonterminal %s outcome",
    async (state) => {
      let requests = 0;
      const transport: typeof fetch = Object.assign(
        async () => {
          requests++;
          return Response.json({ error: "path_conflict", message: "exists" }, { status: 409 });
        },
        { preconnect: fetch.preconnect },
      );
      const refusing = connectFilegate(config, transport);
      let id = "";
      let before: Row | undefined;
      await expect(
        fileAction(
          testCall(actor),
          intent(`refused-${state}`),
          async () => {
            id = currentActivityId() ?? "";
            if (!id) throw new Error("missing activity");
            // Simulate recovery (or a terminal result) arriving before the owner's refusal.
            await sql`UPDATE filesv2.activity SET state=${state},started_at=${now},heartbeat_at=${now},next_check_at=${now},finished_at=${state === "unclear" ? null : now} WHERE id=${id}::uuid`;
            before = await row(id);
            return refusing.root("cloud").mkdir(`${home}/refused-${state}`);
          },
          async () => {},
        ),
      ).rejects.toMatchObject({ status: 409, code: "path_conflict" });
      expect(requests).toBe(1);
      const after = await row(id);
      if (state === "unclear") expect(after).toMatchObject({ state: "failed", error_code: "path_conflict" });
      else expect(after).toEqual(before);
    },
  );
  test("history move-back resolves the original stable item and records its new rename", async () => {
    const original = await service.mkdir(testCall(actor), { baseId: baseId(), path: "history-back-original" });
    const before = await client.root("cloud").stat(`${home}/history-back-original`);
    await service.rename(testCall(actor), { baseId: baseId(), path: original.entry.path, name: "history-back-moved" });
    const [activity] = await sql<{ id: string }[]>`SELECT id FROM filesv2.activity WHERE action='item.rename'`;
    expect((await service.activityRecovery(testCall(actor), { activityId: activity!.id })).canMoveBack).toBe(true);
    const restored = await service.moveActivityBack(testCall(actor), { activityId: activity!.id });
    expect(restored.entry.path).toBe("history-back-original");
    expect((await client.root("cloud").stat(`${home}/history-back-original`)).id).toBe(before.id);
    const rows = await sql<{ state: string; item_id: string; item_after_id: string }[]>`SELECT state,item_id,item_after_id
      FROM filesv2.activity WHERE action='item.rename' ORDER BY started_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: "done", item_id: before.id, item_after_id: before.id });
  });
  test("history move-back refuses a replacement at the former destination without publishing or recording a move", async () => {
    await service.mkdir(testCall(actor), { baseId: baseId(), path: "history-replaced-original" });
    await service.rename(testCall(actor), { baseId: baseId(), path: "history-replaced-original", name: "history-replaced-moved" });
    const [activity] = await sql<{ id: string }[]>`SELECT id FROM filesv2.activity WHERE action='item.rename'`;
    await client.root("cloud").remove(`${home}/history-replaced-moved`, true);
    const replacement = await client.root("cloud").mkdir(`${home}/history-replaced-moved`);
    await expect(service.moveActivityBack(testCall(actor), { activityId: activity!.id })).rejects.toMatchObject({ code: "source_changed" });
    expect((await client.root("cloud").stat(`${home}/history-replaced-moved`)).id).toBe(replacement.id);
    expect((await sql`SELECT id FROM filesv2.activity WHERE action='item.rename'`).length).toBe(1);
  });
  test("history restoration preserves a name conflict and records restoration under the chosen new name", async () => {
    await service.mkdir(testCall(actor), { baseId: baseId(), path: "history-trash-original" });
    const original = await client.root("cloud").stat(`${home}/history-trash-original`);
    await service.remove(testCall(actor), { baseId: baseId(), paths: ["history-trash-original"] });
    const [activity] = await sql<{ id: string }[]>`SELECT id FROM filesv2.activity WHERE action='item.trash'`;
    expect((await service.activityRecovery(testCall(actor), { activityId: activity!.id })).trash?.canRestore).toBe(true);
    const replacement = await client.root("cloud").mkdir(`${home}/history-trash-original`);
    await expect(service.restoreActivity(testCall(actor), { activityId: activity!.id })).rejects.toMatchObject({ code: "path_conflict" });
    const restored = await service.restoreActivity(testCall(actor), { activityId: activity!.id, name: "history-trash-restored" });
    expect(restored.entry.path).toBe("history-trash-restored");
    expect((await client.root("cloud").stat(`${home}/history-trash-restored`)).id).toBe(original.id);
    expect((await client.root("cloud").stat(`${home}/history-trash-original`)).id).toBe(replacement.id);
    expect(await sql`SELECT state FROM filesv2.activity WHERE action='item.restore'`).toMatchObject([{ state: "done" }]);
  });
  test("history recovery rechecks user eligibility before touching a recorded item", async () => {
    await service.mkdir(testCall(actor), { baseId: baseId(), path: "history-revoked-original" });
    await service.rename(testCall(actor), { baseId: baseId(), path: "history-revoked-original", name: "history-revoked-moved" });
    const [activity] = await sql<{ id: string }[]>`SELECT id FROM filesv2.activity WHERE action='item.rename'`;
    const guest: RequestActor = { ...actor, user: { ...actor.user, profile: "guest" } };
    await expect(service.moveActivityBack(testCall(guest), { activityId: activity!.id })).rejects.toMatchObject({ status: 403 });
    expect((await client.root("cloud").stat(`${home}/history-revoked-moved`)).directory).toBe(true);
    expect((await sql`SELECT id FROM filesv2.activity WHERE action='item.rename'`).length).toBe(1);
  });
  test("manual evidence recheck selects one stale entry despite its backoff and leaves neighboring entries untouched", async () => {
    const selected = await seed({ path: `${home}/history-recheck-selected` });
    const neighbor = await seed({ path: `${home}/history-recheck-neighbor` });
    // Relative to the same database clock used by recovery, independent of the calendar day this suite runs.
    await sql`UPDATE filesv2.activity SET started_at=now()-interval '1 day',heartbeat_at=now()-interval '2 minutes',next_check_at=now()+interval '6 hours'`;
    const checked = await service.recheckActivity(testCall(actor), { activityId: selected });
    expect(checked.state).toBe("unclear");
    expect((await row(selected)).checks).toBe(1);
    expect((await row(neighbor)).checks).toBe(0);
    // A second manual click cannot bypass the fresh claim just acquired by the first.
    await service.recheckActivity(testCall(actor), { activityId: selected });
    expect((await row(selected)).checks).toBe(1);
  });
});
