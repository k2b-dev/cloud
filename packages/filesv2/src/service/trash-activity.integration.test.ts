import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, FilegateError } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { activityFilegate } from "../../test/activity-filegate";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { Configuration } from "../contracts";
import { bindings } from "../data/bases";
import { operations } from "../data/operations";
import { trash } from "../data/trash";
import { migrate } from "../migrate";
import { currentActivityId, journalAction, purgeActivity, recoverActivity, type UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

const suite = suiteFor("database", "nats");
const now = new Date("2030-05-15T12:00:00Z");
const earlier = new Date("2030-05-14T12:00:00Z");
const stale = new Date("2030-05-15T11:58:00Z");
const expired = new Date("2028-01-01T12:00:00Z");
const legacyFinished = new Date("2028-01-02T12:00:00Z");
const content = "The observatory opens at dusk.\n";
type ActivityRow = {
  id: string;
  action: string;
  state: string;
  trash_id: string | null;
  operation_id: string | null;
  path_before: string;
  path_after: string | null;
  actor_user_id: string | null;
  via: string;
  started_at: Date;
  finished_at: Date | null;
  detail: Record<string, unknown>;
  xmin: string;
};

suite("trash and permanent-deletion activity with real Filegate", () => {
  const prefix = `filesv2-trash-activity-${Bun.randomUUIDv7()}`;
  const home = `${prefix}/users/alice`;
  let ownsPrefix = false;
  let processSync: ProcessSync | undefined;
  let storage: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let client: Filegate;
  let config: Configuration & { token: string; tokenConfigured: boolean; unreadable: boolean };
  let actor: Extract<RequestActor, { kind: "user" }>;
  let administrator: Extract<RequestActor, { kind: "user" }>;
  let bindingId: string;
  let service: ReturnType<typeof createFilesService>;
  const root = () => client.root("cloud");
  const baseId = () => `cloud:users:${actor.user.id}`;
  const rows = () => sql<ActivityRow[]>`SELECT *,size::float8,xmin::text FROM filesv2.activity ORDER BY action,path_before`;
  async function history(id: string) {
    const [row] = await sql<ActivityRow[]>`SELECT *,size::float8,xmin::text FROM filesv2.activity WHERE id=${id}::uuid`;
    if (!row) throw new Error(`missing fixture history ${id}`);
    return row;
  }
  async function onlyRow() {
    const entries = await rows();
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }
  const callFor = (action: "trash" | "restore" | "purge"): UserFilesCall => ({
    ...testCall(action === "purge" ? administrator : actor),
    via: action === "restore" ? "app:observatory" : "cli",
    requestId: `${action}-request`,
    invocationId: `${action}-invocation`,
    callingApp: action === "restore" ? "observatory" : null,
    origin: "https://observatory.example.test",
  });
  function makeService(transport: typeof fetch = fetch) {
    return createFilesService({
      identities: {
        ...accountIdentities,
        // Identity RPC and group enumeration have separate suites. Admin
        // inventory/reconciliation still authorize against the real auth data.
        self: async (requestActor) => {
          const user = requestActor.kind === "user" ? requestActor.user : requestActor.delegatedUser;
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
      connect: (configuration) => connectFilegate(configuration, transport),
    });
  }
  function wire(options: { lose?: "transfer" | "delete"; beforeMutation?: () => Promise<void> } = {}) {
    const writes: { method: string; path: string }[] = [];
    let lost = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const mutation = !["GET", "HEAD"].includes(method);
        if (mutation) {
          await options.beforeMutation?.();
          writes.push({ method, path: url.pathname });
        }
        const response = await fetch(input, init);
        const lose = options.lose === "transfer" ? url.pathname.endsWith("/transfers") : options.lose === "delete" && method === "DELETE";
        if (lose && mutation && response.ok) {
          // Filegate really completed the request; only its response is lost.
          await response.arrayBuffer();
          lost++;
          throw new Error("lost trash activity response");
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    );
    return {
      transport,
      service: makeService(transport),
      mutations: () => writes.length,
      transfers: () => writes.filter((write) => write.path.endsWith("/transfers")).length,
      deletes: () => writes.filter((write) => write.method === "DELETE").length,
      lost: () => lost,
    };
  }
  async function fixture(path: string) {
    const target = `${home}/${path}`;
    await root().put(target, new Blob([content]));
    return { path, target, before: await root().stat(target) };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const remove = (target: typeof service, file: Fixture, call = callFor("trash")) =>
    target.remove(call, { baseId: baseId(), paths: [file.path] });
  const purge = (target: typeof service, file: Fixture, call = callFor("purge")) =>
    target.adminDelete(call, { area: "cloud", kind: "users", name: "alice", path: file.path, confirmPath: file.target });
  async function pendingTrash(file: Fixture, manualTarget?: string) {
    const id = crypto.randomUUID();
    return trash.create(
      {
        id,
        base_id: bindingId,
        user_id: actor.user.id,
        root: "cloud",
        server_url: config.url,
        original: file.path,
        trashed: manualTarget ?? `trash/${id}`,
        directory: file.before.directory,
        snapshot: file.before,
        state: "pending",
      },
      { call: callFor("trash"), basePath: home },
    );
  }
  async function pendingPurge(file: Fixture) {
    return operations.insert(
      {
        id: crypto.randomUUID(),
        area: "cloud",
        kind: "users",
        root: "cloud",
        server_url: config.url,
        name: "alice",
        action: "delete",
        source: file.target,
        target: null,
        base_id: bindingId,
        archive_id: null,
        actor_id: administrator.user.id,
        actor_name: administrator.user.uid,
        snapshot: file.before,
      },
      callFor("purge"),
    );
  }
  async function legacyTrashed(file: Fixture) {
    const id = crypto.randomUUID();
    await root().mkdir(`${home}/trash`);
    await root().transfer(file.target, "cloud", `${home}/trash/${id}`, { move: true, onConflict: "error" });
    await sql`INSERT INTO filesv2.trash(id,base_id,user_id,root,server_url,original,trashed,directory,snapshot,state,deleted_at,updated_at)
      VALUES(${id}::uuid,${bindingId}::uuid,${administrator.user.id}::uuid,'cloud',${config.url},${file.path},${`trash/${id}`},false,
      ${file.before}::jsonb,'trashed',${expired},${legacyFinished})`;
    return id;
  }
  async function legacyDeleted(file: Fixture) {
    const id = crypto.randomUUID();
    await root().remove(file.target, true);
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,base_id,actor_id,actor_name,snapshot,state,created_at,updated_at)
      VALUES(${id}::uuid,'cloud','users','cloud',${config.url},'alice','delete',${file.target},${bindingId}::uuid,
      ${administrator.user.id}::uuid,${administrator.user.uid},${file.before}::jsonb,'complete',${expired},${legacyFinished})`;
    return id;
  }
  async function recover(transport: typeof fetch = fetch) {
    await sql`UPDATE filesv2.activity SET started_at=${earlier},heartbeat_at=${stale},next_check_at=${now}
      WHERE state IN ('pending','unclear')`;
    return recoverActivity({ now, config, connect: (configuration) => connectFilegate(configuration, transport) });
  }
  async function rejection(kind: "intent" | "history-finish" | "journal-finish" | "audit", run: () => Promise<void>) {
    const target = {
      intent: { table: "filesv2.activity", event: "INSERT", when: "" },
      "history-finish": { table: "filesv2.activity", event: "UPDATE", when: "WHEN (NEW.state='done')" },
      "journal-finish": { table: "filesv2.trash", event: "UPDATE", when: "WHEN (NEW.state IN ('trashed','restored'))" },
      audit: { table: "audit.events", event: "INSERT", when: "WHEN (NEW.action='filesv2.delete')" },
    }[kind];
    await sql`CREATE FUNCTION filesv2.reject_trash_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected trash activity failure'; END $$`.simple();
    try {
      // Only the fixed table/event/predicate values above become SQL syntax.
      await sql
        .unsafe(`CREATE TRIGGER reject_trash_activity_fixture BEFORE ${target.event} ON ${target.table}
        FOR EACH ROW ${target.when} EXECUTE FUNCTION filesv2.reject_trash_activity_fixture()`)
        .simple();
      try {
        await run();
      } finally {
        await sql.unsafe(`DROP TRIGGER reject_trash_activity_fixture ON ${target.table}`).simple();
      }
    } finally {
      await sql`DROP FUNCTION filesv2.reject_trash_activity_fixture()`.simple();
    }
  }
  async function absent(path: string) {
    await expect(root().stat(path)).rejects.toMatchObject({ status: 404 });
  }
  async function journalState(id: string, state: string, activityState: string, action: string) {
    const [joined] = await sql`SELECT t.state,a.state AS activity_state,t.xmin::text AS journal_xmin,a.xmin::text AS activity_xmin
      FROM filesv2.trash t JOIN filesv2.activity a ON a.trash_id=t.id
      WHERE t.id=${id}::uuid AND a.action=${action}`;
    expect(joined).toMatchObject({ state, activity_state: activityState });
    return joined!;
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
        prefix,
        homes: "users",
        groups: "groups",
        archive: "archive",
        autoCreate: false,
        autoArchive: false,
      },
      freeipa: { enabled: false, root: "freeipa", prefix, homes: "users", groups: "groups", archive: "archive" },
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
    };
    client = new Filegate({ baseUrl: config.url, transferBaseUrl: config.url, token });
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer,primary_group_id uuid,home_directory text,login_shell text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
    await migrate();
    await migrateAudit();
    const linux = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };
    await sql`INSERT INTO settings.entries(key,value) VALUES('linux.identity_config',${await secrets.encrypt(JSON.stringify(linux))})`;
    if (testActor.kind !== "user") throw new Error("expected user fixture");
    actor = { ...testActor, user: { ...testActor.user, id: Bun.randomUUIDv7(), roles: ["user", "admin"] } };
    administrator = { ...actor, user: { ...actor.user, id: Bun.randomUUIDv7(), uid: "bob", displayName: "Bob Example" } };
    for (const user of [actor.user, administrator.user])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${user.id}::uuid,${user.uid},'local','user',true)`;
    await root().mkdir(prefix, { ownership: { dirMode: "0755" } });
    ownsPrefix = true;
    await root().mkdir(`${prefix}/users`, { ownership: { dirMode: "0755" } });
    await root().mkdir(home, { ownership: { dirMode: "0700" } });
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
    service = makeService();
  }, 30_000);
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.activity,filesv2.trash,filesv2.operations,audit.events`.simple();
    await sql`UPDATE filesv2.bases SET lifecycle='active' WHERE id=${bindingId}::uuid`;
    // This home and everything underneath it belong to this suite's unique prefix.
    await root().remove(home, true);
    await root().mkdir(home, { ownership: { dirMode: "0700" } });
  });
  afterAll(async () => {
    try {
      if (ownsPrefix) {
        try {
          await root().remove(prefix, true);
        } catch (error) {
          if (!(error instanceof FilegateError && error.status === 404)) throw error;
        }
      }
    } finally {
      try {
        await processSync?.stop();
      } finally {
        await storage?.stop();
      }
    }
  });

  test("selected top-level entries commit atomic trash intents before ensureTrash, then finish with one batch ID", async () => {
    await root().mkdir(`${home}/charts`);
    await fixture("charts/map.txt");
    const file = await fixture("notes.txt");
    const before = new Map([
      [`${home}/charts`, await root().stat(`${home}/charts`)],
      [file.target, file.before],
    ]);
    const call = callFor("trash");
    let inspected = 0;
    const tracked = wire({
      beforeMutation: async () => {
        const id = currentActivityId();
        expect(id).not.toBeNull();
        const [committed] =
          await sql`SELECT a.state,a.action,a.actor_user_id,a.via,a.request_id,a.invocation_id,a.origin,a.path_before,a.path_after,
        a.trash_id,a.item_id,a.directory,a.name,a.size::float8,a.revision_before,t.snapshot,t.state AS journal_state
        FROM filesv2.activity a JOIN filesv2.trash t ON t.id=a.trash_id WHERE a.id=${id}::uuid`;
        expect(committed).toMatchObject({
          state: "pending",
          action: "item.trash",
          journal_state: "pending",
          actor_user_id: actor.user.id,
          via: call.via,
          request_id: call.requestId,
          invocation_id: call.invocationId,
          origin: call.origin,
        });
        // journalAction refreshes the history heartbeat in a later transaction.
        // The insert-rejection test below proves the original insert is atomic.
        const snapshot = before.get(committed!.path_before);
        expect(snapshot).toBeDefined();
        expect(committed).toMatchObject({
          item_id: snapshot!.id ?? null,
          directory: snapshot!.directory,
          name: snapshot!.path.split("/").at(-1),
          size: snapshot!.size,
          revision_before: snapshot!.revision ?? null,
          snapshot,
        });
        expect(committed!.path_after).toBe(`${home}/trash/${committed!.trash_id}`);
        if (inspected++ === 0) await absent(`${home}/trash`);
      },
    });
    const result = await tracked.service.remove(call, { baseId: baseId(), paths: ["charts/map.txt", "charts", "charts", file.path] });
    expect(result.results.map((entry) => [entry.path, entry.ok])).toEqual([
      ["charts", true],
      [file.path, true],
    ]);
    expect(tracked.transfers()).toBe(2);
    expect(inspected).toBeGreaterThanOrEqual(3);
    const entries = await rows();
    expect(entries).toHaveLength(2);
    const batches = await sql`SELECT DISTINCT batch_id FROM filesv2.activity`;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.batch_id).not.toBeNull();
    for (const entry of entries) {
      expect(entry).toMatchObject({ action: "item.trash", state: "done", base_id: bindingId, server_url: config.url, root: "cloud" });
      const joined = await journalState(entry.trash_id!, "trashed", "done", "item.trash");
      expect(joined.journal_xmin).toBe(joined.activity_xmin);
      expect(entry.finished_at).toBeInstanceOf(Date);
      await absent(entry.path_before);
      expect((await root().stat(entry.path_after!)).directory).toBe(entry.path_before.endsWith("/charts"));
    }
    expect(await sql`SELECT id FROM audit.events`).toHaveLength(0);
  });

  test("history restore refuses a stable-identity replacement in the trash before recording a restore intent", async () => {
    const file = await fixture("trash-replaced.txt");
    const removed = await remove(service, file);
    const id = removed.entries[0]!.id;
    const journal = await trash.get(id, bindingId);
    const deletion = await onlyRow();
    await root().remove(`${home}/trash/${id}`);
    const replacement = await root().put(`${home}/trash/${id}`, new Blob([content]));
    expect(replacement.id).not.toBe(file.before.id);
    await expect(service.restoreTrash(callFor("restore"), { baseId: baseId(), id })).rejects.toMatchObject({ code: "source_changed" });
    expect(await trash.get(id, bindingId)).toEqual(journal);
    expect(await rows()).toEqual([deletion]);
    expect((await root().stat(`${home}/trash/${id}`)).id).toBe(replacement.id);
    await expect(root().stat(file.target)).rejects.toMatchObject({ status: 404 });
  });
  test("restore records a separate original-caller action and completes its journal and history together", async () => {
    const file = await fixture("restore.txt");
    const removed = await remove(service, file);
    const id = removed.entries[0]!.id;
    const deletion = await onlyRow();
    const call = callFor("restore");
    const tracked = wire({
      beforeMutation: async () => {
        expect(await journalState(id, "restoring", "pending", "item.restore")).toBeDefined();
        expect(await history(deletion.id)).toEqual(deletion);
      },
    });
    await tracked.service.restoreTrash(call, { baseId: baseId(), id, path: "restored.txt" });
    const entries = await rows();
    expect(entries).toHaveLength(2);
    const restored = entries.find((entry) => entry.action === "item.restore")!;
    expect(restored).toMatchObject({
      state: "done",
      trash_id: id,
      path_before: `${home}/trash/${id}`,
      path_after: `${home}/restored.txt`,
      actor_user_id: actor.user.id,
      via: call.via,
      request_id: call.requestId,
      invocation_id: call.invocationId,
      calling_app: call.callingApp,
      origin: call.origin,
    });
    expect(restored.finished_at).toBeInstanceOf(Date);
    await absent(`${home}/trash/${id}`);
    const joined = await journalState(id, "restored", "done", "item.restore");
    expect(joined.journal_xmin).toBe(joined.activity_xmin);
    expect(await history(deletion.id)).toEqual(deletion);
    await tracked.service.restoreTrash({ ...testCall(actor), via: "api" }, { baseId: baseId(), id });
    expect(tracked.transfers()).toBe(1);
    expect(await history(restored.id)).toEqual(restored);
    const response = await root().contentRaw(`${home}/restored.txt`);
    expect(await response.text()).toBe(content);
  });

  test("history insert rejection rolls back trash, restore and purge intents before any Filegate mutation", async () => {
    const file = await fixture("rejected.txt");
    const tracked = wire();
    await rejection("intent", async () => {
      expect((await remove(tracked.service, file)).results[0]?.ok).toBe(false);
      await expect(purge(tracked.service, file)).rejects.toThrow("injected trash activity failure");
      expect(tracked.mutations()).toBe(0);
      expect(await rows()).toHaveLength(0);
      expect(await sql`SELECT id FROM filesv2.trash`).toHaveLength(0);
      expect(await sql`SELECT id FROM filesv2.operations`).toHaveLength(0);
      await absent(`${home}/trash`);
      expect(await root().stat(file.target)).toEqual(file.before);
    });
    const removed = await remove(service, file);
    const id = removed.entries[0]!.id;
    const deletion = await onlyRow();
    await rejection("intent", async () => {
      await expect(tracked.service.restoreTrash(callFor("restore"), { baseId: baseId(), id })).rejects.toThrow(
        "injected trash activity failure",
      );
      expect(tracked.mutations()).toBe(0);
      expect(await trash.get(id, bindingId)).toMatchObject({ state: "trashed", restore_path: null, restore_activity_recorded: false });
      expect(await onlyRow()).toEqual(deletion);
      await absent(file.target);
      expect((await root().stat(`${home}/trash/${id}`)).size).toBe(file.before.size);
    });
    expect(await sql`SELECT id FROM audit.events`).toHaveLength(0);
  });

  test("a lost trash response finishes from its unique matching target, including after a restart, without another move", async () => {
    const file = await fixture("lost-trash.txt");
    const losing = wire({ lose: "transfer" });
    expect((await remove(losing.service, file)).results[0]?.ok).toBe(true);
    const completed = await onlyRow();
    expect(completed.state).toBe("done");
    await journalState(completed.trash_id!, "trashed", "done", "item.trash");
    expect(losing.lost()).toBe(1);
    expect(losing.transfers()).toBe(1);
    await absent(file.target);

    const crashed = await fixture("crashed-trash.txt");
    const pending = await pendingTrash(crashed);
    // Simulate a process dying after the real move but before observing a response.
    await root().transfer(crashed.target, "cloud", `${home}/${pending.trashed}`, { move: true, onConflict: "error" });
    expect(await recover(losing.transport)).toEqual({ checked: 1 });
    const joined = await journalState(pending.id, "trashed", "done", "item.trash");
    expect(joined.journal_xmin).toBe(joined.activity_xmin);
    expect((await rows()).find((entry) => entry.trash_id === pending.id)).toMatchObject({
      actor_user_id: actor.user.id,
      via: callFor("trash").via,
      request_id: callFor("trash").requestId,
    });
    expect(await recover(losing.transport)).toEqual({ checked: 0 });
    await losing.service.trash(testCall(actor), { baseId: baseId() });
    expect(losing.transfers()).toBe(1);
  });

  test("missing locations, changed snapshots, a surviving source and ordinary targets cannot prove a trash move", async () => {
    await root().mkdir(`${home}/trash`);
    const pending = [];
    for (const evidence of ["neither", "changed", "both", "ordinary-target"] as const) {
      const file = await fixture(`${evidence}.txt`);
      const journal = await pendingTrash(file, evidence === "ordinary-target" ? "trash/manual.txt" : undefined);
      const target = `${home}/${journal.trashed}`;
      if (evidence === "neither") await root().remove(file.target);
      else {
        await root().transfer(file.target, "cloud", target, { move: evidence !== "both", onConflict: "error" });
        if (evidence === "changed") {
          await root().remove(target);
          await root().put(target, new Blob([`${content}A different item now occupies the trash target.\n`]));
        }
      }
      pending.push(journal);
    }
    const tracked = wire();
    expect(await recover(tracked.transport)).toEqual({ checked: pending.length });
    await tracked.service.trash(testCall(actor), { baseId: baseId() });
    for (const journal of pending) {
      await journalState(journal.id, "pending", "unclear", "item.trash");
      expect(await trash.get(journal.id, bindingId)).toMatchObject({ state: "pending" });
    }
    expect(tracked.mutations()).toBe(0);
  });

  test("a lost restore response stays unresolved through listing, recovery and retry, despite its matching destination", async () => {
    const file = await fixture("lost-restore.txt");
    const removed = await remove(service, file);
    const id = removed.entries[0]!.id;
    const losing = wire({ lose: "transfer" });
    await expect(losing.service.restoreTrash(callFor("restore"), { baseId: baseId(), id, path: "ordinary.txt" })).rejects.toMatchObject({
      code: "operation_unresolved",
    });
    await journalState(id, "restoring", "pending", "item.restore");
    expect((await root().stat(`${home}/ordinary.txt`)).size).toBe(file.before.size);
    await absent(`${home}/trash/${id}`);
    expect((await losing.service.trash(testCall(actor), { baseId: baseId() })).entries[0]).toMatchObject({ id, state: "restoring" });
    await recover(losing.transport);
    await expect(losing.service.restoreTrash(testCall(actor), { baseId: baseId(), id })).rejects.toMatchObject({
      code: "operation_unresolved",
    });
    // Even a replacement at the ordinary destination supplies no move receipt.
    await root().remove(`${home}/ordinary.txt`);
    await root().put(`${home}/ordinary.txt`, new Blob(["Replacement remains untouched.\n"]));
    await recover(losing.transport);
    await expect(losing.service.restoreTrash(testCall(actor), { baseId: baseId(), id })).rejects.toMatchObject({
      code: "operation_unresolved",
    });
    await journalState(id, "restoring", "unclear", "item.restore");
    expect(losing.transfers()).toBe(1);
    expect(losing.lost()).toBe(1);
    expect(await rows()).toHaveLength(2);
  });

  test.each(["trash", "restore"] as const)("%s completion failure never splits terminal history from its journal", async (phase) => {
    // Fail each side of the completion transaction in turn, after Filegate's effect.
    for (const failure of ["history-finish", "journal-finish"] as const) {
      const file = await fixture(`${phase}-${failure}.txt`);
      let id = "";
      if (phase === "restore") id = (await remove(service, file)).entries[0]!.id;
      const tracked = wire();
      await rejection(failure, async () => {
        if (phase === "trash") {
          expect((await remove(tracked.service, file)).results[0]?.ok).toBe(false);
          id = (await trash.pending(bindingId, file.path))!.id;
        } else {
          await expect(tracked.service.restoreTrash(callFor("restore"), { baseId: baseId(), id })).rejects.toThrow(
            "injected trash activity failure",
          );
        }
        await journalState(id, phase === "trash" ? "pending" : "restoring", "pending", `item.${phase}`);
        expect(tracked.transfers()).toBe(1);
        if (phase === "trash") await absent(file.target);
        else await absent(`${home}/trash/${id}`);
      });
      await recover(tracked.transport);
      await journalState(id, phase === "trash" ? "trashed" : "restoring", phase === "trash" ? "done" : "unclear", `item.${phase}`);
      expect(tracked.transfers()).toBe(1);
    }
  });

  test("adminDelete commits purge history and operation before delete, then audit and both completions atomically", async () => {
    const file = await fixture("purge.txt");
    const call = callFor("purge");
    const tracked = wire({
      beforeMutation: async () => {
        const entry = await onlyRow();
        expect(entry).toMatchObject({
          state: "pending",
          action: "item.purge",
          actor_user_id: administrator.user.id,
          via: call.via,
          request_id: call.requestId,
          invocation_id: call.invocationId,
          path_before: file.target,
          path_after: null,
        });
        const [operation] = await sql`SELECT *,xmin::text FROM filesv2.operations WHERE id=${entry.operation_id}::uuid`;
        expect(operation).toMatchObject({
          state: "pending",
          action: "delete",
          source: file.target,
          actor_id: administrator.user.id,
        });
        expect(await sql`SELECT id FROM audit.events WHERE action='filesv2.delete'`).toHaveLength(0);
      },
    });
    const result = await purge(tracked.service, file);
    expect(result.state).toBe("complete");
    expect(tracked.deletes()).toBe(1);
    const entry = await onlyRow();
    expect(entry).toMatchObject({
      state: "done",
      action: "item.purge",
      operation_id: result.id,
      base_id: bindingId,
      server_url: config.url,
      root: "cloud",
      item_id: file.before.id ?? null,
      directory: false,
      name: file.path,
      size: file.before.size,
      revision_before: file.before.revision ?? null,
    });
    const [operation] = await sql`SELECT *,xmin::text FROM filesv2.operations WHERE id=${result.id}::uuid`;
    expect(operation).toMatchObject({ state: "complete", xmin: entry.xmin });
    const audits = await sql`SELECT *,xmin::text FROM audit.events WHERE action='filesv2.delete'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: "allowed",
      actor_user_id: administrator.user.id,
      request_id: call.requestId,
      target_id: result.id,
      target_label: file.target,
      metadata: { area: "cloud", root: "cloud", target: null, historyId: entry.id },
      xmin: entry.xmin,
    });
    await absent(file.target);
  });

  test("purge audit failure rolls history and operation completion back after the real deletion", async () => {
    const file = await fixture("audit-failure.txt");
    const tracked = wire();
    await rejection("audit", async () => {
      await expect(purge(tracked.service, file)).rejects.toThrow("injected trash activity failure");
      const entry = await onlyRow();
      expect(entry).toMatchObject({ state: "pending", finished_at: null });
      expect(await operations.get(entry.operation_id!)).toMatchObject({ state: "pending" });
      expect(await sql`SELECT id FROM audit.events WHERE action='filesv2.delete'`).toHaveLength(0);
      await absent(file.target);
    });
    await recover(tracked.transport);
    const entry = await onlyRow();
    expect(entry).toMatchObject({ state: "unclear", finished_at: null });
    await expect(tracked.service.retry(testCall(administrator), entry.operation_id!)).rejects.toMatchObject({
      code: "operation_unresolved",
    });
    expect(tracked.deletes()).toBe(1);
    expect(await operations.get(entry.operation_id!)).toMatchObject({ state: "pending" });
  });

  test("a lost purge response remains unclear; retry never repeats delete or deletes a replacement", async () => {
    const file = await fixture("lost-purge.txt");
    const losing = wire({ lose: "delete" });
    await expect(purge(losing.service, file)).rejects.toThrow("lost trash activity response");
    const entry = await onlyRow();
    expect(entry).toMatchObject({ state: "pending", finished_at: null });
    await absent(file.target);
    await recover(losing.transport);
    expect(await history(entry.id)).toMatchObject({ state: "unclear", detail: { observed_before: { exists: false } } });
    await expect(losing.service.retry(testCall(actor), entry.operation_id!)).rejects.toMatchObject({ code: "operation_unresolved" });
    await root().put(file.target, new Blob(["A replacement must survive the old intent.\n"]));
    const replacement = await root().stat(file.target);
    await expect(losing.service.retry(testCall(actor), entry.operation_id!)).rejects.toMatchObject({ code: "source_changed" });
    await recover(losing.transport);
    expect(await history(entry.id)).toMatchObject({ state: "unclear", finished_at: null });
    expect(await operations.get(entry.operation_id!)).toMatchObject({ state: "pending" });
    expect(await root().stat(file.target)).toEqual(replacement);
    expect(losing.deletes()).toBe(1);
    expect(losing.lost()).toBe(1);
    expect(await sql`SELECT id FROM audit.events WHERE action='filesv2.delete'`).toHaveLength(0);
  });

  test("first listing adopts a completed legacy trash row with its original actor, snapshot and dates exactly once", async () => {
    const file = await fixture("legacy-completed-trash.txt");
    const id = await legacyTrashed(file);
    expect(await rows()).toHaveLength(0);
    expect(await trash.get(id, bindingId)).toMatchObject({ state: "trashed", activity_recorded: false });
    const tracked = wire();
    expect((await tracked.service.trash(callFor("trash"), { baseId: baseId() })).entries).toContainEqual(
      expect.objectContaining({ id, state: "trashed", original: file.path }),
    );
    const adopted = await onlyRow();
    expect(adopted).toMatchObject({
      action: "item.trash",
      state: "done",
      trash_id: id,
      base_id: bindingId,
      path_before: file.target,
      path_after: `${home}/trash/${id}`,
      actor_kind: "user",
      actor_user_id: administrator.user.id,
      via: "unknown",
      request_id: null,
      invocation_id: null,
      calling_app: null,
      origin: null,
      item_id: file.before.id ?? null,
      revision_before: file.before.revision ?? null,
      size: file.before.size,
      started_at: expired,
      finished_at: legacyFinished,
      detail: { adopted: true },
    });
    await tracked.service.trash(testCall(actor), { baseId: baseId() });
    expect(await rows()).toEqual([adopted]);
    expect(await trash.get(id, bindingId)).toMatchObject({ state: "trashed", activity_recorded: true });
    expect(tracked.mutations()).toBe(0);
    await absent(file.target);
    expect((await root().stat(`${home}/trash/${id}`)).size).toBe(file.before.size);
  });

  test("direct restore adopts the completed legacy deletion before recording the new restorer's action", async () => {
    const file = await fixture("legacy-direct-restore.txt");
    const id = await legacyTrashed(file);
    expect(await rows()).toHaveLength(0);
    const call = callFor("restore");
    let deletion: ActivityRow | undefined;
    const tracked = wire({
      beforeMutation: async () => {
        const entries = await rows();
        expect(entries).toHaveLength(2);
        deletion = entries.find((entry) => entry.action === "item.trash");
        expect(deletion).toMatchObject({
          state: "done",
          trash_id: id,
          path_before: file.target,
          path_after: `${home}/trash/${id}`,
          actor_user_id: administrator.user.id,
          via: "unknown",
          request_id: null,
          invocation_id: null,
          item_id: file.before.id ?? null,
          revision_before: file.before.revision ?? null,
          started_at: expired,
          finished_at: legacyFinished,
          detail: { adopted: true },
        });
        expect(entries.find((entry) => entry.action === "item.restore")).toMatchObject({
          state: "pending",
          trash_id: id,
          path_before: `${home}/trash/${id}`,
          path_after: `${home}/recovered.txt`,
          actor_user_id: actor.user.id,
          via: call.via,
          request_id: call.requestId,
          invocation_id: call.invocationId,
          calling_app: call.callingApp,
          origin: call.origin,
        });
      },
    });
    await tracked.service.restoreTrash(call, { baseId: baseId(), id, path: "recovered.txt" });
    expect(tracked.transfers()).toBe(1);
    if (!deletion) throw new Error("restore never reached the Filegate mutation");
    expect(await history(deletion.id)).toEqual(deletion);
    await journalState(id, "restored", "done", "item.restore");
    const completed = await rows();
    expect(completed).toHaveLength(2);
    expect(completed.find((entry) => entry.action === "item.restore")?.finished_at).toBeInstanceOf(Date);
    await tracked.service.restoreTrash(testCall(actor), { baseId: baseId(), id });
    expect(await rows()).toEqual(completed);
    expect(tracked.transfers()).toBe(1);
    await absent(file.target);
    await absent(`${home}/trash/${id}`);
    expect((await root().stat(`${home}/recovered.txt`)).size).toBe(file.before.size);
  });

  test("retry of a completed legacy delete adopts its stored actor once without deleting a replacement", async () => {
    const file = await fixture("legacy-completed-delete.txt");
    const id = await legacyDeleted(file);
    expect(await rows()).toHaveLength(0);
    expect(await operations.get(id)).toMatchObject({ state: "complete", activity_recorded: false });
    await root().put(file.target, new Blob(["A new file occupies the completed deletion's old path.\n"]));
    const replacement = await root().stat(file.target);
    const tracked = wire();
    expect(await tracked.service.retry(callFor("trash"), id)).toMatchObject({ id, state: "complete" });
    const adopted = await onlyRow();
    expect(adopted).toMatchObject({
      action: "item.purge",
      state: "done",
      operation_id: id,
      base_id: bindingId,
      path_before: file.target,
      path_after: null,
      actor_kind: "user",
      actor_user_id: administrator.user.id,
      via: "unknown",
      request_id: null,
      invocation_id: null,
      item_id: file.before.id ?? null,
      revision_before: file.before.revision ?? null,
      size: file.before.size,
      started_at: expired,
      finished_at: legacyFinished,
      detail: { adopted: true },
    });
    expect(await tracked.service.retry(testCall(administrator), id)).toMatchObject({ id, state: "complete" });
    expect(await rows()).toEqual([adopted]);
    expect(await operations.get(id)).toMatchObject({ state: "complete", activity_recorded: true, updated_at: legacyFinished });
    expect(tracked.mutations()).toBe(0);
    expect(await root().stat(file.target)).toEqual(replacement);
    expect(await sql`SELECT id FROM audit.events`).toHaveLength(0);
  });

  test("listing and retry never resurrect purged history for completed legacy journals", async () => {
    const file = await fixture("legacy-retained-trash.txt");
    const id = await legacyTrashed(file);
    const deleted = await fixture("legacy-retained-delete.txt");
    const operationId = await legacyDeleted(deleted);
    expect(await rows()).toHaveLength(0);
    const tracked = wire();
    await tracked.service.trash(testCall(actor), { baseId: baseId() });
    await tracked.service.retry(testCall(actor), operationId);
    expect(await rows()).toHaveLength(2);
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 2 });
    expect(await rows()).toHaveLength(0);
    for (const call of [callFor("trash"), testCall(actor)]) {
      expect((await tracked.service.trash(call, { baseId: baseId() })).entries).toContainEqual(
        expect.objectContaining({ id, state: "trashed" }),
      );
      expect(await tracked.service.retry(call, operationId)).toMatchObject({ id: operationId, state: "complete" });
      expect(await rows()).toHaveLength(0);
    }
    expect(await trash.get(id, bindingId)).toMatchObject({ state: "trashed", activity_recorded: true });
    expect(await operations.get(operationId)).toMatchObject({ state: "complete", activity_recorded: true });
    expect(tracked.mutations()).toBe(0);
    await absent(file.target);
    await absent(deleted.target);
    expect((await root().stat(`${home}/trash/${id}`)).size).toBe(file.before.size);
  });

  test("maintenance does not refresh an idle purge heartbeat or prevent recovery", async () => {
    const file = await fixture("maintenance-purge.txt");
    const losing = wire({ lose: "delete" });
    await expect(purge(losing.service, file)).rejects.toThrow("lost trash activity response");
    const entry = await onlyRow();
    const idle = new Date(now.getTime() - 30_000);
    await sql`UPDATE filesv2.activity SET started_at=${earlier},heartbeat_at=${idle},next_check_at=${now} WHERE id=${entry.id}::uuid`;
    await losing.service.maintain({ now });
    const [first] = await sql`SELECT state,heartbeat_at FROM filesv2.activity WHERE id=${entry.id}::uuid`;
    expect(first).toMatchObject({ state: "pending", heartbeat_at: idle });
    await losing.service.maintain({ now: new Date(now.getTime() + 61_000) });
    const [second] = await sql`SELECT state,heartbeat_at FROM filesv2.activity WHERE id=${entry.id}::uuid`;
    expect(second).toMatchObject({ state: "unclear", heartbeat_at: idle });
    expect(await operations.get(entry.operation_id!)).toMatchObject({ state: "pending" });
    expect(losing.deletes()).toBe(1);
    await absent(file.target);
  });

  test("legacy journals adopt stored actors once; retention protects executable intents and never resurrects purged history", async () => {
    const file = await fixture("legacy-trash.txt");
    const id = crypto.randomUUID();
    await sql`INSERT INTO filesv2.trash(id,base_id,user_id,root,server_url,original,trashed,directory,snapshot,state,deleted_at,updated_at)
      VALUES(${id}::uuid,${bindingId}::uuid,${administrator.user.id}::uuid,'cloud',${config.url},${file.path},${`trash/${id}`},false,${file.before}::jsonb,'pending',${expired},${earlier})`;
    const purgeFile = await fixture("legacy-purge.txt");
    const operationId = crypto.randomUUID();
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,base_id,actor_id,actor_name,snapshot,created_at,updated_at)
      VALUES(${operationId}::uuid,'cloud','users','cloud',${config.url},'alice','delete',${purgeFile.target},${bindingId}::uuid,
      ${administrator.user.id}::uuid,${administrator.user.uid},${purgeFile.before}::jsonb,${expired},${earlier})`;
    const restoreFile = await fixture("legacy-restore.txt");
    const restoreId = crypto.randomUUID();
    await root().mkdir(`${home}/trash`);
    await root().transfer(restoreFile.target, "cloud", `${home}/trash/${restoreId}`, { move: true, onConflict: "error" });
    const restoreSnapshot = await root().stat(`${home}/trash/${restoreId}`);
    await sql`INSERT INTO filesv2.trash(id,base_id,user_id,root,server_url,original,trashed,directory,snapshot,state,restore_path,deleted_at,updated_at)
      VALUES(${restoreId}::uuid,${bindingId}::uuid,${administrator.user.id}::uuid,'cloud',${config.url},${restoreFile.path},
      ${`trash/${restoreId}`},false,${restoreSnapshot}::jsonb,'restoring',${restoreFile.path},${expired},${expired})`;
    const adoptedTrash = await trash.history(id);
    const adoptedPurge = await operations.history(operationId);
    const adoptedRestore = await trash.history(restoreId);
    for (const adopted of [adoptedTrash, adoptedPurge, adoptedRestore]) {
      expect(adopted).not.toBeNull();
      expect(await history(adopted!.id)).toMatchObject({
        actor_kind: "user",
        actor_user_id: administrator.user.id,
        via: "unknown",
        started_at: expired,
        request_id: null,
        invocation_id: null,
        detail: { adopted: true },
      });
    }
    await sql`UPDATE filesv2.activity SET state='unclear'`;
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 0 });
    expect((await trash.history(id))!.id).toBe(adoptedTrash!.id);
    expect((await operations.history(operationId))!.id).toBe(adoptedPurge!.id);
    expect((await trash.history(restoreId))!.id).toBe(adoptedRestore!.id);
    expect((await remove(service, file, testCall(actor))).results[0]?.ok).toBe(true);
    await service.retry(testCall(actor), operationId);
    await service.restoreTrash(testCall(actor), { baseId: baseId(), id: restoreId });
    expect(await history(adoptedTrash!.id)).toMatchObject({ state: "done", actor_user_id: administrator.user.id, via: "unknown" });
    expect(await history(adoptedPurge!.id)).toMatchObject({ state: "done", actor_user_id: administrator.user.id, via: "unknown" });
    expect(await history(adoptedRestore!.id)).toMatchObject({ state: "done", actor_user_id: administrator.user.id, via: "unknown" });
    expect(await purgeActivity({ now, retentionDays: 365 })).toEqual({ purged: 3 });
    expect(await trash.history(id)).toBeNull();
    expect(await operations.history(operationId)).toBeNull();
    expect(await trash.history(restoreId)).toBeNull();
    await service.trash(testCall(actor), { baseId: baseId() });
    await service.retry(testCall(actor), operationId);
    expect(await rows()).toHaveLength(0);
    expect(await trash.get(id, bindingId)).toMatchObject({ state: "trashed", activity_recorded: true });
    expect(await trash.get(restoreId, bindingId)).toMatchObject({ state: "restored", restore_activity_recorded: true });
    expect(await operations.get(operationId)).toMatchObject({ state: "complete", activity_recorded: true });
  });

  test.each(["trash", "restore", "purge"] as const)(
    "persisted %s scope rejects wrong paths, methods and extra effects before transport",
    async (phase) => {
      const file = await fixture(`scope-${phase}.txt`);
      const tracked = wire();
      const facade = connectFilegate(config, tracked.transport);
      const guarded = facade.root("cloud");
      let source = file.target;
      let target = "";
      let activityId: string;
      if (phase === "purge") activityId = (await operations.history((await pendingPurge(file)).id))!.id;
      else {
        const journal = await pendingTrash(file);
        target = `${home}/${journal.trashed}`;
        if (phase === "restore") {
          await root().mkdir(`${home}/trash`);
          await root().transfer(source, "cloud", target, { move: true, onConflict: "error" });
          await trash.finish(journal.id, "trashed", await root().stat(target));
          await trash.restoring(journal.id, file.path, await root().stat(target), config.url, { call: callFor("restore"), basePath: home });
          source = target;
          target = file.target;
        }
        activityId = (await trash.history(journal.id))!.id;
      }
      await journalAction(activityId, async () => {
        const effect = (targetRoot: typeof guarded) =>
          phase === "purge"
            ? targetRoot.remove(source, true)
            : targetRoot.transfer(source, "cloud", target, { move: true, onConflict: "error" });
        const wrong: (() => Promise<unknown>)[] = [
          () => guarded.remove(`${source}-other`, true),
          () => guarded.remove(source, false),
          () => guarded.mkdir(`${home}/unrelated`),
          () => guarded.put(`${home}/unrelated.txt`, new Blob([content])),
          () => effect(facade.root("freeipa")),
          () => effect(connectFilegate({ ...config, url: "http://other-filegate.example.test" }, tracked.transport).root("cloud")),
        ];
        if (phase !== "purge")
          wrong.push(
            () => guarded.transfer(`${source}-other`, "cloud", target, { move: true, onConflict: "error" }),
            () => guarded.transfer(source, "cloud", `${target}-other`, { move: true, onConflict: "error" }),
            () => guarded.transfer(source, "freeipa", target, { move: true, onConflict: "error" }),
            () => guarded.transfer(source, "cloud", target, { move: false, onConflict: "error" }),
            () => guarded.transfer(source, "cloud", target, { move: true, onConflict: "rename" }),
            () => guarded.remove(source, true),
          );
        else wrong.push(() => guarded.transfer(source, "cloud", `${home}/elsewhere`, { move: true, onConflict: "error" }));
        for (const run of wrong) await expect(run()).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        expect(tracked.mutations()).toBe(0);
        if (phase === "purge") {
          await guarded.remove(source, true);
          await expect(guarded.remove(source, true)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        } else {
          if (phase === "trash") {
            await guarded.mkdir(`${home}/trash`);
            await expect(guarded.mkdir(`${home}/trash`)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
          } else await expect(guarded.mkdir(`${home}/trash`)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
          await guarded.transfer(source, "cloud", target, { move: true, onConflict: "error" });
          await expect(guarded.transfer(source, "cloud", target, { move: true, onConflict: "error" })).rejects.toMatchObject({
            code: "activity_scope_mismatch",
          });
          await expect(guarded.mkdir(`${home}/trash`)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        }
      });
      expect(tracked.mutations()).toBe(phase === "trash" ? 2 : 1);
      await absent(source);
      if (phase !== "purge") expect((await root().stat(target)).size).toBe(file.before.size);
    },
  );

  test("persisted purge operations reject root and source-configuration drift without deleting", async () => {
    const file = await fixture("config-drift.txt");
    const operation = await pendingPurge(file);
    const tracked = wire();
    const original = config.cloud;
    try {
      for (const changed of [
        { ...original, root: "freeipa" },
        { ...original, prefix: `${prefix}-other` },
      ]) {
        config = { ...config, cloud: changed };
        await expect(tracked.service.retry(testCall(administrator), operation.id)).rejects.toMatchObject({ code: "configuration_changed" });
        expect(tracked.mutations()).toBe(0);
      }
    } finally {
      config = { ...config, cloud: original };
    }
    expect(await root().stat(file.target)).toEqual(file.before);
    expect(await operations.get(operation.id)).toMatchObject({ state: "pending" });
    expect(await onlyRow()).toMatchObject({ state: "pending", finished_at: null });
  });
});
