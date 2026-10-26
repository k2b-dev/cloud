import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities } from "@k2b/cloud/services";
import { Filegate, FilegateError, type Node } from "@k2b/filegate";
import { DirectSession } from "@k2b/filegate/utils";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { activityFilegate } from "../../test/activity-filegate";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import {
  claimObservationRetries,
  knownActivity,
  knownIdentityActivity,
  type ObservationTarget,
  observationBlocked,
} from "../data/activity-observations";
import { bindings } from "../data/bases";
import { withRootLock } from "../data/operations";
import { migrate } from "../migrate";
import { entryRefId } from "../resource-ref";
import { createActivityObservations } from "./activity-observations";
import { signEditorToken } from "./collabora";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
const suite = suiteFor("database", "nats");
const observedAt = new Date("2030-05-15T12:00:00Z");
const confirmedAt = new Date("2030-05-14T12:00:00Z");

suite("contact observations with real Filegate and private history", () => {
  let storage: Awaited<ReturnType<typeof activityFilegate>>;
  let sync: ProcessSync;
  let client: Filegate;
  let config: Config;
  let cloudBinding: string;
  let ipaBinding: string;
  let otherBinding: string;
  const userId = Bun.randomUUIDv7();
  if (testActor.kind !== "user") throw new Error("Expected user fixture");
  const call = testCall({ ...testActor, user: { ...testActor.user, id: userId } });
  const baseId = `cloud:users:${userId}`;
  function files(
    connect = (configuration: Config, signal?: AbortSignal) => connectFilegate(configuration, undefined, signal),
    posix: { uidNumber: number; primaryGidNumber: number } | null = null,
    administrator = false,
  ) {
    return createFilesService({
      identities: {
        ...accountIdentities,
        self: async () => ({
          user: { id: userId, username: "alice", provider: posix ? "ipa" : "local", profile: "user", posix },
          availability: { localLinuxEnabled: true, freeipaEnabled: true },
        }),
        groups: async () => ({ items: [], nextCursor: null }),
        inventory: async () => {
          if (!administrator) throw new FilesError("forbidden", 403);
          return { items: [], nextCursor: null };
        },
      },
      displayNames: resolveDisplayNames,
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      publicOrigin: async () => "https://cloud.test",
      userById: async (id) => (id === userId && call.actor.kind === "user" ? call.actor.user : null),
      transfer: fetch,
      connect,
    });
  }
  const prefix = `observations-${Bun.randomUUIDv7()}`;
  const home = `${prefix}/users/alice`;
  const otherHome = `${prefix}/users/bob`;
  const path = `${home}/file.txt`;
  const target = (root = "cloud", at = path): ObservationTarget => ({
    serverUrl: config.url,
    root,
    baseId: root === "cloud" ? cloudBinding : ipaBinding,
    path: at,
  });
  const service = () =>
    createActivityObservations({ readConfiguration: async () => config, connect: connectFilegate, now: () => observedAt });
  const observations = () => sql<
    {
      action: string;
      actor_kind: string;
      actor_user_id: string | null;
      via: string;
      started_at: Date;
      finished_at: Date;
      detail: Record<string, unknown>;
      base_after_id: string | null;
      path_after: string | null;
    }[]
  >`
    SELECT * FROM filesv2.activity WHERE actor_kind='observed' ORDER BY id`;

  async function confirmed(node: Node, at = confirmedAt): Promise<string> {
    const id = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,item_after_id,directory,name,path_after,size,
      revision_after,actor_kind,via,started_at,finished_at,heartbeat_at)
      VALUES(${id}::uuid,'done',${node.directory ? "folder.create" : "file.create"},${config.url},${node.root},${node.root === "cloud" ? cloudBinding : ipaBinding}::uuid,
      ${node.id ?? null},${node.directory},'file.txt',${node.path},${node.size},${node.revision ?? null},'system','system',${at},${at},${at})`;
    return id;
  }
  async function put(root = "cloud", at = path, text = "aaaa"): Promise<Node> {
    // These writes deliberately bypass Cloud and its history; every observation itself uses the guarded façade.
    return client.root(root).put(at, new Blob([text]), { onConflict: "overwrite" });
  }
  async function openActivity(
    input: { root?: string; afterRoot?: string; before?: string; after?: string; state?: "pending" | "unclear"; action?: string } = {},
  ) {
    const id = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,root_after,base_id,directory,name,path_before,path_after,actor_kind,via)
      VALUES(${id}::uuid,${input.state ?? "pending"},${input.action ?? "item.move"},${config.url},${input.root ?? "cloud"},${input.afterRoot ?? null},
      ${cloudBinding}::uuid,true,'own work',${input.before ?? null},${input.after ?? null},'system','system')`;
    return id;
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    storage = await activityFilegate();
    sync = await startProcessSync({ application: "filesv2" });
    client = new Filegate({ baseUrl: storage.url, transferBaseUrl: storage.url, token: storage.token });
    const area = { enabled: true, prefix, homes: "users", groups: "groups", archive: "archive" };
    config = {
      url: storage.url,
      token: storage.token,
      unreadable: false,
      tokenConfigured: true,
      activityRetentionDays: 365,
      cloud: { ...area, root: "cloud", autoCreate: false, autoArchive: false },
      freeipa: { ...area, root: "freeipa" },
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
    };
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${userId}::uuid,'alice','Alice')`;
    for (const root of ["cloud", "freeipa"]) {
      await client.root(root).mkdir(prefix, { ownership: { dirMode: "0755" } });
      await client.root(root).mkdir(`${prefix}/users`, { ownership: { dirMode: "0755" } });
      await client.root(root).mkdir(home, { ownership: { dirMode: "0700" } });
      const binding = (
        await bindings.claim({
          area: root === "cloud" ? "cloud" : "freeipa",
          kind: "users",
          identity_id: userId,
          identity_name: "alice",
          root,
          path: home,
          uid_number: null,
          gid_number: null,
        })
      )[0]!;
      if (root === "cloud") cloudBinding = binding.id;
      else ipaBinding = binding.id;
    }
    await client.root("cloud").mkdir(otherHome);
    otherBinding = (
      await bindings.claim({
        area: "cloud",
        kind: "users",
        identity_id: Bun.randomUUIDv7(),
        identity_name: "bob",
        root: "cloud",
        path: otherHome,
        uid_number: null,
        gid_number: null,
      })
    )[0]!.id;
  }, 45_000);
  beforeEach(async () => {
    setSystemTime(observedAt);
    await sql`TRUNCATE filesv2.activity,filesv2.uploads,filesv2.trash,filesv2.operations`;
    await sql`UPDATE filesv2.bases SET lifecycle='active'`;
    await put();
  });
  afterEach(() => setSystemTime());
  afterAll(async () => {
    try {
      if (client) {
        const results = await Promise.allSettled(["cloud", "freeipa"].map((root) => client.root(root).remove(prefix, true)));
        const failures = results.flatMap((result) =>
          result.status === "rejected" && !(result.reason instanceof FilegateError && result.reason.status === 404) ? [result.reason] : [],
        );
        if (failures.length) throw new AggregateError(failures, "Observation fixture cleanup failed");
      }
    } finally {
      try {
        await sync?.stop();
      } finally {
        await storage?.stop();
      }
    }
  });

  test("held local root skips contact without breaking detail, stable lookup or upload start", async () => {
    // Real upload reservations and leases use the Postgres/Filegate clock, not the evidence fixture year.
    const [clock] = await sql<{ now: Date }[]>`SELECT current_timestamp AS now`;
    setSystemTime(clock!.now);
    const node = await client.root("cloud").stat(path);
    const evidence = await confirmed(node);
    await put("cloud", path, "outside");
    const ref = `n:${baseId}:${node.id}`;
    let uploadId = "";
    await withRootLock("cloud", async () => {
      expect(await service().check(target())).toBe(false);
      expect((await files().entry(call, { baseId, path: "file.txt" })).entry.path).toBe("file.txt");
      expect((await files().entryById(call, ref)).entry.path).toBe("file.txt");
      const session = await files().upload(call, {
        baseId,
        path: "file.txt",
        size: 4,
        onConflict: "overwrite",
        idempotencyKey: Bun.randomUUIDv7(),
      });
      uploadId = session.id;
      expect(session).toBeDefined();
    });
    const [scheduled] =
      await sql`SELECT observation_next_at,observation_error,observation_checks FROM filesv2.activity WHERE id=${evidence}::uuid`;
    expect(scheduled).toMatchObject({ observation_error: null, observation_checks: 0 });
    expect(scheduled!.observation_next_at.getTime()).toBeGreaterThan(observedAt.getTime());
    expect(await observations()).toHaveLength(0);
    await files().abortUpload(call, { baseId, id: uploadId });
    expect(await service().check(target())).toBe(true);
  });
  test("overwrite upload records the external comparison before its published overwrite", async () => {
    // Freeze the service clock beside the real reservation and lease timestamps.
    const [clock] = await sql<{ now: Date }[]>`SELECT current_timestamp AS now`;
    setSystemTime(clock!.now);
    await confirmed(await client.root("cloud").stat(path), new Date(clock!.now.getTime() - 86_400_000));
    await put("cloud", path, "external-change");
    const service = files();
    const opened = await service.upload(call, {
      baseId,
      path: "file.txt",
      size: 4,
      onConflict: "overwrite",
      idempotencyKey: Bun.randomUUIDv7(),
    });
    const lease = await service.uploadLease(call, { baseId, id: opened.id });
    await new DirectSession(lease.url).put(0, new Blob(["next"]));
    await service.commitUpload(call, { baseId, id: opened.id });
    const rows = await sql`SELECT action,state FROM filesv2.activity WHERE action IN ('item.differs','file.overwrite') ORDER BY id`;
    expect(rows).toEqual([
      { action: "item.differs", state: "done" },
      { action: "file.overwrite", state: "done" },
    ]);
    expect(await (await client.root("cloud").contentRaw(path)).text()).toBe("next");
  });
  test("busy maintenance reschedules previously failed evidence without spending its retry budget", async () => {
    const id = await confirmed(await client.root("cloud").stat(path));
    await sql`UPDATE filesv2.activity SET observation_error='observation_unavailable',observation_checks=1,
      observation_next_at=${confirmedAt} WHERE id=${id}::uuid`;
    await withRootLock("cloud", async () => {
      expect(await service().maintain({})).toEqual({ checked: 1, failed: 0 });
    });
    const [row] = await sql`SELECT observation_checks,observation_error,observation_next_at FROM filesv2.activity WHERE id=${id}::uuid`;
    expect(row).toEqual({
      observation_checks: 1,
      observation_error: "observation_unavailable",
      observation_next_at: new Date(observedAt.getTime() + 60_000),
    });
  });
  test("Office save waits for the local publish lock instead of failing its preliminary observation", async () => {
    const officePath = `${home}/busy.odt`;
    const node = await put("cloud", officePath, "before");
    await confirmed(node);
    const previous = config;
    config = { ...config, collabora: { ...config.collabora, url: "https://office.example.test" } };
    const token = signEditorToken({ userId, baseId, path: "busy.odt", expiresAt: observedAt.getTime() + 60_000 });
    const ref = entryRefId(baseId, "busy.odt")!;
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withRootLock("cloud", async () => {
      acquired();
      await wait;
    });
    await held;
    let save: Promise<unknown> | undefined;
    try {
      const read = new Promise<void>((resolve) => {
        save = files().editorSave(token, ref, {
          timestamp: null,
          read: async () => {
            resolve();
            return new Blob(["after"]);
          },
        });
      });
      await Promise.race([read, save!]);
      release();
      await holder;
      expect(await save).toHaveProperty("modified");
      expect(await sql`SELECT id FROM filesv2.activity WHERE action='file.edit' AND state='done'`).toHaveLength(1);
    } finally {
      release();
      await holder;
      config = previous;
    }
  });
  test("repeated healthy details do not update a comparison schedule before it is due", async () => {
    const id = await confirmed(await client.root("cloud").stat(path));
    await service().check(target());
    const [before] = await sql`SELECT xmin::text,observation_next_at FROM filesv2.activity WHERE id=${id}::uuid`;
    await files().entry(call, { baseId, path: "file.txt" });
    await files().entry(call, { baseId, path: "file.txt" });
    const [after] = await sql`SELECT xmin::text,observation_next_at FROM filesv2.activity WHERE id=${id}::uuid`;
    expect(after).toEqual(before);
  });
  test("contact records same-size managed revision mismatch once, at observation time only", async () => {
    const known = await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "bbbb");
    expect(await service().check(target())).toBe(true);
    expect(await service().check(target())).toBe(false);
    const rows = await observations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "item.differs",
      actor_kind: "observed",
      actor_user_id: null,
      via: "observed",
      started_at: observedAt,
      finished_at: observedAt,
      detail: { known_activity_id: known },
    });
    const [evidence] = await sql<{ heartbeat_at: Date }[]>`SELECT heartbeat_at FROM filesv2.activity WHERE id=${known}::uuid`;
    expect(evidence!.heartbeat_at).toEqual(confirmedAt);
  });
  test("concurrent contacts use a database atomic dedup guard", async () => {
    await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "changed");
    // Parent holds the existing root lock on this path; bypass it to exercise DB concurrency directly.
    await Promise.all(Array.from({ length: 8 }, () => service().check(target(), { underRootLock: true })));
    expect(await observations()).toHaveLength(1);
  });
  test("new known state creates a new comparison; absence of Cloud evidence invents no baseline", async () => {
    await put("cloud", path, "outside");
    expect(await service().check(target())).toBe(false);
    expect(await observations()).toHaveLength(0);
    await confirmed(await client.root("cloud").stat(path));
    expect(await service().check(target())).toBe(false);
    await put("cloud", path, "another outside state");
    await service().check(target());
    await confirmed(await client.root("cloud").stat(path), new Date("2030-05-15T10:00:00Z"));
    await put("cloud", path, "a third state");
    await service().check(target());
    expect(await observations()).toHaveLength(2);
    await sql`DELETE FROM filesv2.activity WHERE actor_kind<>'observed'`;
    await put("cloud", path, "history lost");
    expect(await service().check(target())).toBe(false);
    expect(await observations()).toHaveLength(2);
  });
  test("missing stable path resolves an out-of-band move into another binding", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    const destination = `${otherHome}/moved-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    await service().check(target());
    expect((await observations())[0]).toMatchObject({
      action: "item.elsewhere",
      base_after_id: otherBinding,
      path_after: destination,
      detail: { observed_after: { exists: true, id: node.id } },
    });
    expect((await client.root("cloud").stat(destination)).id).toBe(node.id);
    await expect(client.root("cloud").stat(path)).rejects.toMatchObject({ status: 404 });
  });
  test("deleted and replacement IDs never transfer the old baseline to a new object", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    await client.root("cloud").remove(path);
    await service().check(target());
    expect((await observations())[0]).toMatchObject({ action: "item.missing", path_after: null });
    const replacement = await put();
    expect(replacement.id).not.toBe(node.id);
    await service().check(target());
    expect(await observations()).toHaveLength(1);
    expect((await observations())[0]!.action).toBe("item.missing");
  });
  test("POSIX changes never become history observations", async () => {
    const initial = await put("freeipa", path);
    expect(initial.id).toBeUndefined();
    expect(initial.revision).toBeUndefined();
    await confirmed(initial);
    await put("freeipa", path, "bbbb");
    expect(await service().check(target("freeipa"))).toBe(false);
    await put("freeipa", path, "longer");
    expect(await service().check(target("freeipa"))).toBe(false);
    expect(await observations()).toHaveLength(0);
  });
  test.each(["pending", "unclear"] as const)("own %s ancestors in either root suppress findings", async (state) => {
    await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "changed");
    const id = await openActivity({ root: "freeipa", afterRoot: "cloud", before: "elsewhere", after: home, state });
    expect(await service().check(target())).toBe(false);
    await sql`UPDATE filesv2.activity SET root='cloud',root_after='freeipa',path_before=${home},path_after='elsewhere' WHERE id=${id}::uuid`;
    expect(await service().check(target())).toBe(false);
    await sql`UPDATE filesv2.activity SET path_before=${`${home}2`} WHERE id=${id}::uuid`;
    expect(await service().check(target())).toBe(true);
  });
  test("open upload and trash journals suppress exact element and ancestor without an activity row", async () => {
    await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "changed");
    const uploadId = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,server_url) VALUES(${uploadId},${cloudBinding}::uuid,${userId}::uuid,'cloud','',0,${config.url})`;
    expect(await observationBlocked(target())).toBe(true);
    expect(await service().check(target())).toBe(false);
    await sql`DELETE FROM filesv2.uploads`;
    const trashId = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.trash(id,base_id,user_id,root,original,trashed,directory,state,server_url)
      VALUES(${trashId}::uuid,${cloudBinding}::uuid,${userId}::uuid,'cloud','file.txt','trash/own',false,'pending',${config.url})`;
    expect(await service().check(target())).toBe(false);
    await sql`UPDATE filesv2.trash SET state='restoring',original='elsewhere',restore_path='file.txt'`;
    expect(await service().check(target())).toBe(false);
    await sql`DELETE FROM filesv2.trash`;
    expect(await service().check(target())).toBe(true);
  });
  test("pending lifecycle ancestor suppresses; finished ancestor move is an evidence barrier", async () => {
    await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "changed");
    const operation = Bun.randomUUIDv7();
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,target,state,actor_id,actor_name)
      VALUES(${operation}::uuid,'cloud','users','cloud',${config.url},'alice','archive',${home},'archive/own','pending',${userId}::uuid,'test')`;
    expect(await service().check(target())).toBe(false);
    await sql`DELETE FROM filesv2.operations`;
    const id = await openActivity({ before: home, after: `${home}-moved` });
    await sql`UPDATE filesv2.activity SET state='done',finished_at=${observedAt} WHERE id=${id}::uuid`;
    expect(await knownActivity(target())).toBeNull();
    expect(await service().check(target())).toBe(false);
  });
  test("pending destination of resolved external move also suppresses the finding", async () => {
    await confirmed(await client.root("cloud").stat(path));
    const destination = `${otherHome}/pending-${Bun.randomUUIDv7()}`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    await openActivity({ after: otherHome });
    expect(await service().check(target())).toBe(false);
    expect(await observations()).toHaveLength(0);
  });
  test("root/config drift and closed bindings are not missing and cannot reopen scopes", async () => {
    await confirmed(await client.root("cloud").stat(path));
    await client.root("cloud").remove(path);
    const previous = config;
    try {
      for (const changed of [
        { ...previous, cloud: { ...previous.cloud, prefix: `${prefix}-changed` } },
        { ...previous, cloud: { ...previous.cloud, root: "not-configured" } },
        { ...previous, url: "https://invalid.test" },
        { ...previous, unreadable: true },
      ]) {
        config = changed;
        expect(await service().check({ ...target(), serverUrl: previous.url })).toBe(false);
      }
    } finally {
      config = previous;
    }
    for (const lifecycle of ["retired", "archived", "deleted"] as const) {
      await sql`UPDATE filesv2.bases SET lifecycle=${lifecycle} WHERE id=${cloudBinding}::uuid`;
      expect(await service().check(target())).toBe(false);
      expect((await bindings.byId(cloudBinding))!.lifecycle).toBe(lifecycle);
    }
    expect(await observations()).toHaveLength(0);
  });
  test("opening the authorized stable ref after an external move retains the original endpoint", async () => {
    const node = await client.root("cloud").stat(path);
    const evidence = await confirmed(node);
    const destination = `${home}/stable-open-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    const ref = `n:${baseId}:${node.id}`;
    expect((await files().entryById(call, ref)).entry.path).toBe(destination.slice(home.length + 1));
    await files().observeActivityContact(call, ref);
    expect(await observations()).toHaveLength(1);
    expect((await observations())[0]).toMatchObject({
      action: "item.elsewhere",
      path_before: path,
      path_after: destination,
      base_id: cloudBinding,
      detail: { known_activity_id: evidence },
    });
    // A replacement without its own Cloud evidence cannot borrow the moved identity's baseline.
    const replacement = await put();
    expect(await knownIdentityActivity({ ...target(), stableId: replacement.id })).toBeNull();
    expect(await service().check({ ...target(), stableId: replacement.id })).toBe(false);
    expect(await observations()).toHaveLength(1);
  });
  test.each(["entry", "item", "path"] as const)(
    "opening %s history observes one authorized item and deduplicates repeat contact",
    async (surface) => {
      const node = await client.root("cloud").stat(path);
      const evidence = await confirmed(node);
      await put("cloud", path, "external history contact");
      const reader = files();
      // A global history read must not compare all visible entries.
      await reader.activity(call);
      expect(await observations()).toHaveLength(0);
      const open = () =>
        surface === "entry"
          ? reader.activityForEntry(call, `n:${baseId}:${node.id}`)
          : reader.activity(call, surface === "item" ? { baseId, itemId: node.id } : { baseId, path: "file.txt" });
      const page = await open();
      expect(page.items.some((entry) => entry.action === "item.differs")).toBe(true);
      expect((await observations())[0]).toMatchObject({ action: "item.differs", detail: { known_activity_id: evidence } });
      await open();
      expect(await observations()).toHaveLength(1);
    },
  );
  test.each(["entry", "path"] as const)("opening missing %s history uses only its readable parent", async (surface) => {
    await confirmed(await client.root("cloud").stat(path));
    await client.root("cloud").remove(path);
    const reader = files();
    const ref = entryRefId(baseId, "file.txt");
    if (!ref) throw new Error("Expected inline fixture reference");
    const page = surface === "entry" ? await reader.activityForEntry(call, ref) : await reader.activity(call, { baseId, path: "file.txt" });
    expect(page.items.some((entry) => entry.action === "item.missing")).toBe(true);
    expect(await observations()).toHaveLength(1);
    expect((await observations())[0]).toMatchObject({ action: "item.missing", path_before: path, path_after: null });
  });
  test("stable history contacts follow a fresh same-binding location and reject a move beyond it", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    const destination = `${home}/history-move-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    const reader = files();
    const page = await reader.activityForEntry(call, `n:${baseId}:${node.id}`);
    expect(page.items.some((entry) => entry.action === "item.elsewhere")).toBe(true);
    expect((await observations())[0]).toMatchObject({ action: "item.elsewhere", path_before: path, path_after: destination });
    const outside = `${otherHome}/history-outside-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(destination, "cloud", outside, { move: true });
    expect(await reader.activityForEntry(call, `n:${baseId}:${node.id}`)).toMatchObject({ items: [], next: null });
    expect(await reader.activity(call, { baseId, itemId: node.id, q: "history-outside" })).toMatchObject({ items: [], next: null });
    expect(await observations()).toHaveLength(1);
  });
  test("an old child path retains its visible ancestor move when contact has no readable parent", async () => {
    const root = client.root("cloud");
    const oldFolder = `old-parent-${Bun.randomUUIDv7()}`;
    const newFolder = `new-parent-${Bun.randomUUIDv7()}`;
    await root.mkdir(`${home}/${oldFolder}`);
    await put("cloud", `${home}/${oldFolder}/child.txt`);
    const reader = files();
    await reader.rename(call, { baseId, path: oldFolder, name: newFolder });
    const page = await reader.activity(call, { baseId, path: `${oldFolder}/child.txt`, scope: "item" });
    const moved = page.items.find((entry) => entry.action === "item.rename");
    expect(moved).toBeDefined();
    const chain = await reader.movementChain(call, { activityId: moved!.id, oldPath: `${oldFolder}/child.txt` });
    expect(chain.endpoint).toMatchObject({ baseId, path: `${newFolder}/child.txt` });
    expect(await observations()).toHaveLength(0);
  });

  test("history contact neither adopts unknown storage nor creates a baseline or durable reference", async () => {
    await put("cloud", path, "unknown external item");
    const reader = files();
    await reader.activity(call, { baseId, path: "file.txt" });
    expect(await observations()).toHaveLength(0);
    const refs = await sql`SELECT * FROM filesv2.entry_references ORDER BY id`;
    const claims = await sql`SELECT * FROM filesv2.bases ORDER BY id`;
    const previous = config;
    try {
      // Existing folder with no active claim must remain unadopted, even with auto-create enabled.
      config = { ...config, cloud: { ...config.cloud, autoCreate: true } };
      await sql`UPDATE filesv2.bases SET lifecycle='retired' WHERE id=${cloudBinding}::uuid`;
      const retired = await sql`SELECT * FROM filesv2.bases ORDER BY id`;
      const ref = entryRefId(baseId, "file.txt");
      if (!ref) throw new Error("Expected inline fixture reference");
      expect(await reader.activityForEntry(call, ref)).toMatchObject({ items: [], next: null });
      expect(await reader.activity(call, { baseId, path: "file.txt" })).toMatchObject({ items: [], next: null });
      expect(await sql`SELECT * FROM filesv2.bases ORDER BY id`).toEqual(retired);
      expect(await sql`SELECT * FROM filesv2.entry_references ORDER BY id`).toEqual(refs);
      expect(await sql`SELECT id FROM filesv2.activity`).toHaveLength(0);
    } finally {
      config = previous;
      await sql`UPDATE filesv2.bases SET lifecycle='active' WHERE id=${cloudBinding}::uuid`;
    }
    expect(await sql`SELECT * FROM filesv2.bases ORDER BY id`).toEqual(claims);
  });
  test("POSIX history contacts return unavailable without recording observations", async () => {
    const ipaBaseId = `freeipa:users:${userId}`;
    await confirmed(await put("freeipa", path));
    await put("freeipa", path, "external restricted item");
    const reader = files(undefined, { uidNumber: 12345, primaryGidNumber: 12346 });
    const ref = entryRefId(ipaBaseId, "file.txt");
    if (!ref) throw new Error("Expected inline fixture reference");
    await expect(reader.activityForEntry(call, ref)).rejects.toMatchObject({ code: "history_unavailable", status: 409 });
    await expect(reader.activity(call, { baseId: ipaBaseId, path: "file.txt", q: "file.txt" })).rejects.toMatchObject({
      code: "history_unavailable",
      status: 409,
    });
    expect(await observations()).toHaveLength(0);
  });
  test("history contacts honor cancellation before observation or candidate reads", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    await put("cloud", path, "cancelled history contact");
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    const reader = files();
    const abortedCall = { ...call, requestAbort: controller.signal };
    await expect(reader.activityForEntry(abortedCall, `n:${baseId}:${node.id}`)).rejects.toThrow("fixture cancelled");
    await expect(reader.activity(abortedCall, { baseId, path: "file.txt" })).rejects.toThrow("fixture cancelled");
    expect(await observations()).toHaveLength(0);
  });
  test.each(["entry", "path"] as const)("cancelling %s history during the actual authority read prevents observation", async (surface) => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    await put("cloud", path, "external change during cancelled contact");
    const controller = new AbortController();
    let reads = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/stat") && url.searchParams.get("path") === path && ++reads === 2)
          controller.abort(new Error("cancelled during authority"));
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const reader = files((configuration, signal) => connectFilegate(configuration, transport, signal));
    const abortedCall = { ...call, requestAbort: controller.signal };
    const result =
      surface === "entry"
        ? reader.activityForEntry(abortedCall, `n:${baseId}:${node.id}`)
        : reader.activity(abortedCall, { baseId, path: "file.txt" });
    await expect(result).rejects.toThrow("cancelled during authority");
    expect(reads).toBe(2);
    expect(await observations()).toHaveLength(0);
  });
  test("a real Office direct-write 412 settles its refusal before observing the external writer", async () => {
    const officePath = `${home}/race-${Bun.randomUUIDv7()}.odt`;
    const relative = officePath.slice(home.length + 1);
    const initial = await put("cloud", officePath, "office baseline");
    const evidence = await confirmed(initial);
    let publication: string | undefined;
    let interleaved = false;
    let publicationStatus: number | undefined;
    let external: Node | undefined;
    let precondition: unknown;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "POST" && url.pathname.endsWith("/uploads/direct")) {
          const options: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          const response = await fetch(input, init);
          if (options && typeof options === "object" && "path" in options && options.path === officePath) {
            precondition = "precondition" in options ? options.precondition : undefined;
            const lease: unknown = await response.clone().json();
            if (lease && typeof lease === "object" && "url" in lease && typeof lease.url === "string")
              publication = client.transferUrl(lease.url);
          }
          return response;
        }
        if (method === "PUT" && url.href === publication && !interleaved) {
          interleaved = true;
          const [pending] = await sql`SELECT state FROM filesv2.activity WHERE action='file.edit'`;
          expect(pending).toMatchObject({ state: "pending" });
          // Actual external publication after the conditional lease and all pre-write observations,
          // before Files sends its bytes. The unwrapped client bypasses only Cloud, not Filegate.
          external = await put("cloud", officePath, "actual external writer wins");
          const response = await fetch(input, init);
          publicationStatus = response.status;
          return response;
        }
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const previous = config;
    try {
      config = { ...config, collabora: { ...config.collabora, url: "https://office.example.test" } };
      const token = signEditorToken({ userId, baseId, path: relative, expiresAt: observedAt.getTime() + 60_000 });
      const ref = entryRefId(baseId, relative);
      if (!ref) throw new Error("Expected inline fixture reference");
      const result = await files((configuration, signal) => connectFilegate(configuration, transport, signal)).editorSave(token, ref, {
        timestamp: null,
        read: async () => new Blob(["stale Office content"]),
      });
      expect(result).toEqual({ conflict: true });
      expect(interleaved).toBe(true);
      expect(precondition).toEqual({ ifMatch: initial.revision });
      expect(publicationStatus).toBe(412);
      expect(await (await client.root("cloud").contentRaw(officePath)).text()).toBe("actual external writer wins");
      const [edit] = await sql`SELECT state,error_code,finished_at,via FROM filesv2.activity WHERE action='file.edit'`;
      expect(edit).toMatchObject({ state: "failed", error_code: "write_conflict", finished_at: expect.any(Date), via: "office" });
      expect(await observations()).toHaveLength(1);
      expect((await observations())[0]).toMatchObject({
        action: "item.differs",
        path_before: officePath,
        detail: { known_activity_id: evidence, observed_after: { revision: external?.revision } },
      });
    } finally {
      config = previous;
    }
  });
  test("identity lookup checks source and destination barriers and current configuration", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    const destination = `${otherHome}/identity-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    const contact = { ...target("cloud", destination), baseId: otherBinding, stableId: node.id };
    // Membership in the original binding never authorizes opening a moved item in another binding.
    await expect(files().observeActivityContact(call, `n:${baseId}:${node.id}`)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await observations()).toHaveLength(0);
    const pending = await openActivity({ before: home });
    expect(await service().check(contact)).toBe(false);
    await sql`UPDATE filesv2.activity SET path_before=NULL,path_after=${otherHome} WHERE id=${pending}::uuid`;
    expect(await service().check(contact)).toBe(false);
    await sql`DELETE FROM filesv2.activity WHERE id=${pending}::uuid`;
    await sql`UPDATE filesv2.bases SET lifecycle='retired' WHERE id=${cloudBinding}::uuid`;
    expect(await service().check(contact)).toBe(false);
    await sql`UPDATE filesv2.bases SET lifecycle='active' WHERE id=${cloudBinding}::uuid`;
    const barrier = await openActivity({ after: otherHome });
    await sql`UPDATE filesv2.activity SET state='done',finished_at=${observedAt} WHERE id=${barrier}::uuid`;
    expect(await service().check(contact)).toBe(false);
    await sql`DELETE FROM filesv2.activity WHERE id=${barrier}::uuid`;
    expect(await service().check(contact)).toBe(true);
    expect((await observations())[0]).toMatchObject({
      base_id: cloudBinding,
      base_after_id: otherBinding,
      path_before: path,
      path_after: destination,
    });
    // Observer returns only a boolean. No hidden endpoint or raw observation leaves this private writer.
  });
  test("copy source leaves its own and child evidence intact", async () => {
    const source = `${home}/copy-source-${Bun.randomUUIDv7()}`;
    const directory = await client.root("cloud").mkdir(source);
    const child = await put("cloud", `${source}/child.txt`);
    const direct = await client.root("cloud").stat(path);
    const directoryEvidence = await confirmed(directory);
    const childEvidence = await confirmed(child);
    const directEvidence = await confirmed(direct);
    for (const node of [directory, direct]) {
      const destination = `${node.path}-copy-${Bun.randomUUIDv7()}`;
      const result = await client.root("cloud").transfer(node.path, "cloud", destination);
      expect(result.state).toBe("completed");
      const id = await openActivity({ before: node.path, after: destination, action: "item.copy" });
      expect(await observationBlocked(target("cloud", node.path))).toBe(false);
      expect(await observationBlocked(target("cloud", destination))).toBe(true);
      await sql`UPDATE filesv2.activity SET state='done',finished_at=${observedAt},directory=${node.directory},item_id=${node.id ?? null},
        item_after_id=${result.node?.id ?? null},size=${result.node?.size ?? null},revision_after=${result.node?.revision ?? null} WHERE id=${id}::uuid`;
      expect((await knownActivity(target("cloud", destination)))?.id).toBe(id);
      if (node.directory) expect(await knownActivity(target("cloud", `${destination}/child.txt`))).toBeNull();
    }
    expect((await knownActivity(target("cloud", source)))?.id).toBe(directoryEvidence);
    expect((await knownActivity(target("cloud", child.path)))?.id).toBe(childEvidence);
    expect((await knownActivity(target()))?.id).toBe(directEvidence);
    await put("cloud", path, "source changed");
    await put("cloud", child.path, "child changed");
    expect(await service().check(target())).toBe(true);
    expect(await service().check(target("cloud", child.path))).toBe(true);
    expect(await observations()).toHaveLength(2);
  });
  test("a real historical copy preserves the unchanged source baseline", async () => {
    const node = await client.root("cloud").stat(path);
    const evidence = await confirmed(node);
    const version = await client.root("cloud").snapshot(path);
    const destination = `${home}/historical-copy-${Bun.randomUUIDv7()}.txt`;
    const copy = await client.root("cloud").copyVersion(path, version.id, "cloud", destination);
    const id = await openActivity({ before: path, after: destination, action: "version.restore_copy" });
    await sql`UPDATE filesv2.activity SET state='done',finished_at=${observedAt},directory=false,item_id=${node.id ?? null},
      item_after_id=${copy.id ?? null},size=${copy.size},revision_after=${copy.revision ?? null} WHERE id=${id}::uuid`;
    expect((await knownActivity(target()))?.id).toBe(evidence);
    expect((await knownActivity(target("cloud", destination)))?.id).toBe(id);
    await put("cloud", path, "source after historical copy");
    expect(await service().check(target())).toBe(true);
    expect((await observations())[0]).toMatchObject({ action: "item.differs", detail: { known_activity_id: evidence } });
  });
  test("identity lookup never crosses a newer Cloud-confirmed replacement at the original path", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    const destination = `${home}/old-life-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    await confirmed(await put(), observedAt);
    const contact = { ...target("cloud", destination), stableId: node.id };
    expect(await knownIdentityActivity(contact)).toBeNull();
    expect(await service().check(contact)).toBe(false);
    expect(await observations()).toHaveLength(0);
  });
  test("ordinary maintenance compares healthy evidence repeatedly and schedules new writes over existing history", async () => {
    const initial = await confirmed(await client.root("cloud").stat(path));
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    await put("cloud", path, "outside after healthy check");
    const later = new Date(observedAt.getTime() + 60_000);
    const scheduled = createActivityObservations({ readConfiguration: async () => config, connect: connectFilegate, now: () => later });
    expect(await scheduled.maintain({ now: later })).toEqual({ checked: 1, failed: 0 });
    expect(await observations()).toHaveLength(1);
    const fresh = await confirmed(await client.root("cloud").stat(path), later);
    await put("cloud", path, "after next Cloud write");
    expect(await scheduled.maintain({ now: later })).toEqual({ checked: 1, failed: 0 });
    expect(await observations()).toHaveLength(2);
    expect((await observations())[1]).toMatchObject({ detail: { known_activity_id: fresh } });
    expect(await scheduled.maintain({ now: later })).toEqual({ checked: 0, failed: 0 });
    const [row] = await sql<{ heartbeat_at: Date; observation_checks: number; observation_error: string | null }[]>`
      SELECT * FROM filesv2.activity WHERE id=${initial}::uuid`;
    expect(row).toMatchObject({ heartbeat_at: confirmedAt, observation_checks: 0, observation_error: null });
  });
  test("a new Cloud rename over existing history schedules the new confirmed endpoint", async () => {
    const previous = await confirmed(await client.root("cloud").stat(path));
    await service().check(target());
    const name = `cloud-rename-${Bun.randomUUIDv7()}.txt`;
    await files().rename(call, { baseId, path: "file.txt", name });
    const destination = `${home}/${name}`;
    // Freeze the newly produced SQL fixture timestamps as well as the service clock.
    await sql`UPDATE filesv2.activity SET started_at=${observedAt},finished_at=${observedAt},heartbeat_at=${observedAt}
      WHERE action='item.rename'`;
    const known = await knownActivity(target("cloud", destination));
    expect(known?.id).not.toBe(previous);
    expect(known?.path).toBe(destination);
    await put("cloud", destination, "outside after a Cloud write");
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    expect(await observations()).toHaveLength(1);
    expect((await observations())[0]).toMatchObject({ path_after: destination, detail: { known_activity_id: known!.id } });
  });
  test("historic evidence rotates past fifty rows; obsolete evidence is retired without spending retries", async () => {
    const initial = await client.root("cloud").stat(path);
    // Old duplicates are not current baselines; the last row is the only current evidence.
    const seed = await confirmed(initial);
    await sql`UPDATE filesv2.activity SET observation_next_at=NULL WHERE id=${seed}::uuid`;
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,item_after_id,directory,name,path_after,size,
      revision_after,actor_kind,via,started_at,finished_at,heartbeat_at,observation_next_at)
      SELECT gen_random_uuid(),state,action,server_url,root,base_id,item_after_id,directory,name,path_after,size,
        revision_after,actor_kind,via,started_at,finished_at,heartbeat_at,NULL
      FROM filesv2.activity CROSS JOIN generate_series(1,50) WHERE id=${seed}::uuid`;
    await put("cloud", path, "changed after historic writes");
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 50, failed: 0 });
    expect(await observations()).toHaveLength(0);
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    expect(await observations()).toHaveLength(1);
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 0, failed: 0 });
    const [row] = await sql<{ retired: number; errors: number }[]>`SELECT
      count(*) FILTER(WHERE observation_next_at='infinity')::int AS retired,
      count(*) FILTER(WHERE observation_checks<>0 OR observation_error IS NOT NULL)::int AS errors
      FROM filesv2.activity WHERE actor_kind<>'observed'`;
    expect(row).toEqual({ retired: 50, errors: 0 });
  });
  test("maintenance suppression waits for an open effect and a later successful comparison resets retries", async () => {
    const id = await confirmed(await client.root("cloud").stat(path));
    await put("cloud", path, "changed with effect open");
    const pending = await openActivity({ before: home });
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    expect(await observations()).toHaveLength(0);
    await sql`DELETE FROM filesv2.activity WHERE id=${pending}::uuid`;
    await sql`UPDATE filesv2.activity SET observation_error='observation_unavailable',observation_checks=2,
      observation_next_at=${confirmedAt} WHERE id=${id}::uuid`;
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    const [row] = await sql<{ observation_checks: number; observation_error: string | null; observation_next_at: Date }[]>`
      SELECT * FROM filesv2.activity WHERE id=${id}::uuid`;
    expect(row).toMatchObject({ observation_checks: 0, observation_error: null });
    expect(row!.observation_next_at).toEqual(new Date(observedAt.getTime() + 60_000));
    expect(await observations()).toHaveLength(1);
  });
  test("maintenance records moves and retires an older identity endpoint once newer Cloud evidence exists", async () => {
    const node = await client.root("cloud").stat(path);
    const old = await confirmed(node);
    const destination = `${home}/maintenance-moved-${Bun.randomUUIDv7()}.txt`;
    await client.root("cloud").transfer(path, "cloud", destination, { move: true });
    expect(await service().maintain({ now: observedAt })).toEqual({ checked: 1, failed: 0 });
    expect((await observations())[0]).toMatchObject({ action: "item.elsewhere", path_before: path, path_after: destination });
    await confirmed(await client.root("cloud").stat(destination), observedAt);
    const later = new Date(observedAt.getTime() + 60_000);
    expect(await service().maintain({ now: later })).toEqual({ checked: 2, failed: 0 });
    const [row] = await sql<{ disabled: boolean }[]>`SELECT observation_next_at='infinity'::timestamptz AS disabled
      FROM filesv2.activity WHERE id=${old}::uuid`;
    expect(row?.disabled).toBe(true);
    expect(await observations()).toHaveLength(1);
  });
  test("rebuild checks bounded current root evidence even before its normal due time", async () => {
    const id = await confirmed(await client.root("cloud").stat(path));
    await service().check(target());
    await sql`UPDATE filesv2.activity SET observation_next_at='2099-01-01' WHERE id=${id}::uuid`;
    await put("cloud", path, "outside before rebuild");
    await files(undefined, null, true).rebuildRoot(call, "cloud");
    expect(await observations()).toHaveLength(1);
    expect((await observations())[0]).toMatchObject({ action: "item.differs", detail: { known_activity_id: id } });
  });
  test("detail and private history hook surface recoverable history-write errors, while actual 404 stays missing", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    await put("cloud", path, "outside change");
    await sql`CREATE FUNCTION filesv2.reject_observation() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.actor_kind='observed' THEN RAISE EXCEPTION 'history storage unavailable'; END IF; RETURN NEW; END $$`.simple();
    await sql`CREATE TRIGGER reject_observation BEFORE INSERT ON filesv2.activity FOR EACH ROW EXECUTE FUNCTION filesv2.reject_observation()`.simple();
    try {
      const ref = `n:${baseId}:${node.id}`;
      await expect(files().entryById(call, ref)).rejects.toMatchObject({ code: "activity_cannot_record", status: 503 });
      await expect(files().observeActivityContact(call, ref)).rejects.toMatchObject({ code: "activity_cannot_record", status: 503 });
      await client.root("cloud").remove(path);
      await expect(files().entry(call, { baseId, path: "file.txt" })).rejects.toMatchObject({ status: 404 });
      expect(await observations()).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER reject_observation ON filesv2.activity`.simple();
      await sql`DROP FUNCTION filesv2.reject_observation()`.simple();
    }
  });
  test("read contact storage failures are visible and cancellation reaches the private authorized hook", async () => {
    const node = await client.root("cloud").stat(path);
    await confirmed(node);
    let reads = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/stat") && url.searchParams.get("path") === path && ++reads > 1)
          return Response.json({ error: "unavailable", message: "Storage temporarily unavailable" }, { status: 503 });
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const ref = `n:${baseId}:${node.id}`;
    await expect(files((c) => connectFilegate(c, transport)).entryById(call, ref)).rejects.toMatchObject({
      code: "activity_cannot_record",
      status: 503,
    });
    expect(await observations()).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    await expect(files().observeActivityContact(call, ref, controller.signal)).rejects.toBeDefined();
  });
  test("maintenance configuration exceptions also stop after three retries", async () => {
    await confirmed(await client.root("cloud").stat(path));
    let clock = observedAt;
    const unavailable = createActivityObservations({
      readConfiguration: async () => {
        throw new Error("configuration unavailable");
      },
      connect: connectFilegate,
      now: () => clock,
    });
    expect(await unavailable.maintain({ now: clock })).toEqual({ checked: 0, failed: 1 });
    for (const delta of [60_000, 5 * 60_000, 30 * 60_000]) {
      clock = new Date(clock.getTime() + delta);
      expect(await unavailable.maintain({ now: clock })).toEqual({ checked: 0, failed: 1 });
    }
    expect(await unavailable.maintain({ now: new Date(clock.getTime() + 86_400_000) })).toEqual({ checked: 0, failed: 0 });
  });
  test("real permission denial is not missing and retries stop after three attempts", async () => {
    await confirmed(await put("cloud", path));
    let clock = observedAt;
    const denied = createActivityObservations({
      readConfiguration: async () => config,
      connect: (c) => connectFilegate(c).as({ uid: 54321, gid: 54321 }),
      now: () => clock,
    });
    await expect(denied.check(target("cloud"))).rejects.toBeInstanceOf(FilegateError);
    expect(await observations()).toHaveLength(0);
    for (const delta of [60_000, 5 * 60_000, 30 * 60_000]) {
      clock = new Date(clock.getTime() + delta);
      expect((await denied.maintain({ now: clock })).failed).toBe(1);
    }
    expect(await denied.maintain({ now: new Date(clock.getTime() + 86_400_000) })).toEqual({ checked: 0, failed: 0 });
    const [row] = await sql<
      { observation_error: string; observation_checks: number; observation_next_at: null; heartbeat_at: Date }[]
    >`SELECT * FROM filesv2.activity WHERE root='cloud'`;
    expect(row).toMatchObject({
      observation_error: "observation_unavailable",
      observation_checks: 3,
      observation_next_at: null,
      heartbeat_at: confirmedAt,
    });
    expect(await observations()).toHaveLength(0);
  });
  test("maintenance claims at most fifty contacted candidates and honors cancellation", async () => {
    const current = await client.root("cloud").stat(path);
    const seed = await confirmed(current);
    await sql`UPDATE filesv2.activity SET observation_next_at=${confirmedAt},observation_error='observation_unavailable' WHERE id=${seed}::uuid`;
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,item_after_id,directory,name,path_after,size,
      revision_after,actor_kind,via,started_at,finished_at,heartbeat_at,observation_next_at,observation_error)
      SELECT gen_random_uuid(),state,action,server_url,root,base_id,item_after_id,directory,name,path_after,size,
        revision_after,actor_kind,via,started_at,finished_at,heartbeat_at,observation_next_at,observation_error
      FROM filesv2.activity CROSS JOIN generate_series(1,50) WHERE id=${seed}::uuid`;
    const first = await claimObservationRetries(observedAt);
    const rest = await claimObservationRetries(observedAt);
    expect(first).toHaveLength(50);
    expect(rest).toHaveLength(1);
    expect(new Set([...first, ...rest].map((row) => row.id)).size).toBe(51);
    expect(await claimObservationRetries(observedAt)).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    await expect(service().maintain({ signal: controller.signal })).rejects.toBeDefined();
    await expect(service().check(target(), { signal: controller.signal })).rejects.toBeDefined();
  });
});
