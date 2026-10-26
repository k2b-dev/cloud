import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, FilegateError } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migratePosix } from "../../../core/src/migrate/core/posix";
import { activityFilegate } from "../../test/activity-filegate";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { Configuration } from "../contracts";
import { bindings } from "../data/bases";
import { migrate } from "../migrate";
import { currentActivityId, fileAction, type Intent, recoverActivity, type UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

const suite = suiteFor("database", "nats");
const now = new Date("2030-05-15T12:00:00Z");
const earlier = new Date("2030-05-14T12:00:00Z");
const staleHeartbeat = new Date("2030-05-15T11:58:00Z");
const oldContent = "The observatory opens at dusk.\n";
const currentContent = "The observatory opens at noon; bring a notebook.\n";
const operations = ["comment", "restore", "copy", "delete", "adminDelete"] as const;
type Operation = (typeof operations)[number];
type ActivityRow = {
  id: string;
  action: string;
  state: string;
  finished_at: Date | null;
  item_id: string | null;
  item_after_id: string | null;
  version_id: string;
  detail: Record<string, unknown>;
  xmin: string;
};

suite("version activity with real Filegate", () => {
  const prefix = `filesv2-version-activity-${Bun.randomUUIDv7()}`;
  const home = `${prefix}/users/alice`;
  let ownsPrefix = false;
  let processSync: ProcessSync | undefined;
  let storage: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let client: Filegate;
  let config: Configuration & { token: string; tokenConfigured: boolean; unreadable: boolean };
  let actor: Extract<RequestActor, { kind: "user" }>;
  let administrator: Extract<RequestActor, { kind: "user" }>;
  let bindingId: string;
  let stableIds: boolean;
  let service: ReturnType<typeof createFilesService>;
  const root = () => client.root("cloud");
  const baseId = () => `cloud:users:${actor.user.id}`;
  const rows = () => sql<ActivityRow[]>`SELECT *,size::float8,xmin::text FROM filesv2.activity ORDER BY id`;
  async function onlyRow() {
    const entries = await rows();
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }
  const callFor = (operation: Operation): UserFilesCall => ({
    ...testCall(operation === "adminDelete" ? administrator : actor),
    via: operation === "copy" ? "app:observatory" : operation === "restore" ? "api" : "cli",
    requestId: `version-${operation}-request`,
    invocationId: `version-${operation}-invocation`,
    callingApp: operation === "copy" ? "observatory" : null,
    origin: "https://observatory.example.test",
  });

  function makeService(transport: typeof fetch = fetch) {
    return createFilesService({
      identities: {
        ...accountIdentities,
        // Identity RPC is outside this suite; the admin inventory check below
        // still uses the real identity service and the seeded auth tables.
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

  function wire(loseResponse = false) {
    let mutations = 0;
    let lost = 0;
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const mutation = !["GET", "HEAD"].includes(method);
        if (mutation) mutations++;
        const response = await fetch(input, init);
        if (loseResponse && mutation && response.ok) {
          // Await the actual successful effect, then lose its response on the
          // application side. No Filegate response or effect is fabricated.
          await response.arrayBuffer();
          lost++;
          throw new Error("lost version response");
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    );
    return { transport, service: makeService(transport), mutations: () => mutations, lost: () => lost };
  }

  async function fixture(name: string) {
    const path = `${name}.txt`;
    const target = `${home}/${path}`;
    await root().put(target, new Blob([oldContent]));
    const version = await root().snapshot(target, {
      pinned: false,
      metadata: { comment: "First edition", author: "Ada Example", reviewed_at: earlier.toISOString() },
    });
    await root().put(target, new Blob([currentContent]), { onConflict: "overwrite" });
    const before = await root().stat(target);
    expect((await root().versions(target)).some((saved) => saved.id === version.id)).toBe(true);
    return { path, target, version, before, copyName: `${name}-restored.txt`, copyTarget: `${home}/${name}-restored.txt` };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function invoke(targetService: typeof service, operation: Operation, file: Fixture, call = callFor(operation)) {
    const input = { baseId: baseId(), path: file.path, id: file.version.id };
    switch (operation) {
      case "comment":
        return targetService.commentVersion(call, { ...input, comment: "Ready for review" });
      case "restore":
        return targetService.restoreVersion(call, input);
      case "copy":
        return targetService.restoreVersionAs(call, { ...input, name: file.copyName });
      case "delete":
        return targetService.deleteVersion(call, input);
      case "adminDelete":
        return targetService.adminDeleteVersion(call, {
          area: "cloud",
          kind: "users",
          name: "alice",
          path: file.path,
          id: file.version.id,
          confirmPath: file.target,
        });
    }
  }
  function intent(file: Fixture, action: Intent["action"]): Intent {
    return {
      action,
      serverUrl: config.url,
      root: "cloud",
      baseId: bindingId,
      itemId: stableIds ? file.before.id : null,
      versionId: file.version.id,
      directory: false,
      name: file.path,
      pathBefore: file.target,
      pathAfter: file.target,
      revisionBefore: file.before.revision,
    };
  }
  async function recover(transport: typeof fetch = fetch) {
    // Recovery gets a fixed clock; service-created timestamps never determine
    // whether a fixture is eligible or seven days old.
    await sql`UPDATE filesv2.activity SET started_at=${earlier},heartbeat_at=${staleHeartbeat},next_check_at=${now}
      WHERE state IN ('pending','unclear')`;
    return recoverActivity({ now, config, connect: (configuration) => connectFilegate(configuration, transport) });
  }
  async function content(path: string) {
    const response = await root().contentRaw(path);
    expect(response.ok).toBe(true);
    return response.text();
  }
  async function assertEffect(operation: Operation, file: Fixture, historyId: string) {
    const versions = await root().versions(file.target);
    if (operation === "comment") {
      expect(versions.find((version) => version.id === file.version.id)).toMatchObject({
        pinned: file.version.pinned,
        metadata: {
          ...file.version.metadata,
          comment: "Ready for review",
          author: "alice",
          comment_activity: historyId,
        },
      });
      expect(await root().stat(file.target)).toEqual(file.before);
    } else if (operation === "restore") {
      expect(await content(file.target)).toBe(oldContent);
      if (stableIds) expect((await root().stat(file.target)).id).toBe(file.before.id);
    } else if (operation === "copy") {
      expect(await content(file.copyTarget)).toBe(oldContent);
      expect(await root().stat(file.target)).toEqual(file.before);
      if (stableIds) expect((await root().stat(file.copyTarget)).id).not.toBe(file.before.id);
    } else {
      expect(versions.some((version) => version.id === file.version.id)).toBe(false);
      expect(await root().stat(file.target)).toEqual(file.before);
    }
    if (operation !== "restore") expect(await content(file.target)).toBe(currentContent);
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
    const info = await root().info();
    expect(info.versioning.enabled).toBe(true);
    stableIds = info.stableIds === true;
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await migratePosix();
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
    await sql`TRUNCATE filesv2.activity,audit.events`.simple();
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

  test.each([...operations])("%s records one confirmed service action with the original caller and saved version", async (operation) => {
    const file = await fixture(`confirmed-${operation}`);
    const call = callFor(operation);
    const tracked = wire();
    await invoke(tracked.service, operation, file, call);
    expect(tracked.mutations()).toBe(1);
    const entry = await onlyRow();
    const action = {
      comment: "version.comment",
      restore: "version.restore",
      copy: "version.restore_copy",
      delete: "version.delete",
      adminDelete: "version.delete",
    }[operation];
    expect(entry).toMatchObject({
      action,
      state: "done",
      server_url: config.url,
      root: "cloud",
      root_after: operation === "copy" ? "cloud" : null,
      base_id: bindingId,
      base_after_id: operation === "copy" ? bindingId : null,
      item_id: stableIds ? file.before.id : null,
      version_id: file.version.id,
      directory: false,
      name: file.path,
      path_before: file.target,
      path_after: operation === "copy" ? file.copyTarget : file.target,
      size: operation === "restore" || operation === "copy" ? oldContent.length : currentContent.length,
      revision_before: file.before.revision ?? null,
      actor_kind: "user",
      actor_user_id: operation === "adminDelete" ? administrator.user.id : actor.user.id,
      via: call.via,
      request_id: call.requestId,
      invocation_id: call.invocationId,
      calling_app: call.callingApp,
      origin: call.origin,
      batch_id: null,
      error_code: null,
    });
    expect(entry.finished_at).toBeInstanceOf(Date);
    await assertEffect(operation, file, entry.id);
    if (operation === "restore" || operation === "copy") {
      const after = await root().stat(operation === "copy" ? file.copyTarget : file.target);
      expect(entry).toMatchObject({ item_after_id: stableIds ? after.id : null, revision_after: after.revision, size: after.size });
    }
    const audits = await sql`SELECT *,xmin::text FROM audit.events WHERE action='filesv2.version.delete'`;
    if (operation === "delete" || operation === "adminDelete") {
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        outcome: "allowed",
        actor_user_id: operation === "adminDelete" ? administrator.user.id : actor.user.id,
        request_id: call.requestId,
        target_type: "filesv2.version",
        target_id: file.version.id,
        target_label: file.target,
        metadata: { root: "cloud" },
        // The audit insert and terminal history update share one transaction.
        xmin: entry.xmin,
      });
    } else expect(audits).toHaveLength(0);
  });

  test.each([...operations])("%s fails closed before Filegate when the history insert fails", async (operation) => {
    const file = await fixture(`insert-failure-${operation}`);
    const tracked = wire();
    const versions = await root().versions(file.target);
    await sql`CREATE FUNCTION filesv2.reject_version_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'version intent unavailable'; END $$`.simple();
    await sql`CREATE TRIGGER reject_version_intent BEFORE INSERT ON filesv2.activity FOR EACH ROW EXECUTE FUNCTION filesv2.reject_version_intent()`.simple();
    try {
      await expect(invoke(tracked.service, operation, file)).rejects.toThrow("version intent unavailable");
      expect(tracked.mutations()).toBe(0);
      expect(await root().stat(file.target)).toEqual(file.before);
      expect(await root().versions(file.target)).toEqual(versions);
      expect(await content(file.target)).toBe(currentContent);
      await expect(root().stat(file.copyTarget)).rejects.toMatchObject({ status: 404 });
      expect(await rows()).toHaveLength(0);
      expect(await sql`SELECT id FROM audit.events`).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER reject_version_intent ON filesv2.activity`.simple();
      await sql`DROP FUNCTION filesv2.reject_version_intent()`.simple();
    }
  });

  test.each(["restore", "delete"] as const)("%s intent binds the source and version and permits exactly one effect", async (operation) => {
    const file = await fixture(`guard-${operation}`);
    const tracked = wire();
    const facade = connectFilegate(config, tracked.transport);
    const guarded = facade.root("cloud");
    const mutate = (target: typeof guarded, path = file.target, id = file.version.id) =>
      operation === "restore" ? target.restore(path, id) : target.deleteVersion(path, id);
    await fileAction(
      callFor(operation),
      intent(file, `version.${operation}`),
      async () => {
        const refused = [
          () => mutate(guarded, file.target, `${file.version.id}-other`),
          () => mutate(guarded, `${file.target}-other`),
          () => mutate(facade.root("freeipa")),
          () => mutate(connectFilegate({ ...config, url: "http://other-filegate.example.test" }, tracked.transport).root("cloud")),
          () => guarded.updateVersion(file.target, file.version.id, { pinned: false }),
          () =>
            operation === "restore" ? guarded.deleteVersion(file.target, file.version.id) : guarded.restore(file.target, file.version.id),
        ];
        for (const run of refused) await expect(run()).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        expect(tracked.mutations()).toBe(0);
        await mutate(guarded);
        await expect(mutate(guarded)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      },
      async () => {},
    );
    expect(tracked.mutations()).toBe(1);
    await assertEffect(operation, file, (await onlyRow()).id);
  });

  test("copy intent binds both locations, the saved version and all copy options before transport", async () => {
    const file = await fixture("guard-copy");
    const tracked = wire();
    const guarded = connectFilegate(config, tracked.transport).root("cloud");
    const options = { onConflict: "error" as const, ownership: { mode: "0600" }, targetExecution: { mode: "service" as const } };
    await fileAction(
      callFor("copy"),
      {
        ...intent(file, "version.restore_copy"),
        rootAfter: "cloud",
        baseAfterId: bindingId,
        pathAfter: file.copyTarget,
        copyOptions: options,
      },
      async () => {
        const refused = [
          () => guarded.copyVersion(`${file.target}-other`, file.version.id, "cloud", file.copyTarget, options),
          () => guarded.copyVersion(file.target, `${file.version.id}-other`, "cloud", file.copyTarget, options),
          () => guarded.copyVersion(file.target, file.version.id, "freeipa", file.copyTarget, options),
          () => guarded.copyVersion(file.target, file.version.id, "cloud", `${file.copyTarget}-other`, options),
          () => guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget, { ...options, onConflict: "overwrite" }),
          () => guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget, { ...options, ownership: { mode: "0666" } }),
          () =>
            guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget, {
              ...options,
              targetExecution: { mode: "unix", identity: { uid: 31001, gid: 32001 } },
            }),
          () => guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget),
          () => guarded.restore(file.target, file.version.id),
        ];
        for (const run of refused) await expect(run()).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        expect(tracked.mutations()).toBe(0);
        await guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget, options);
        await expect(guarded.copyVersion(file.target, file.version.id, "cloud", file.copyTarget, options)).rejects.toMatchObject({
          code: "activity_scope_mismatch",
        });
      },
      async () => {},
    );
    expect(tracked.mutations()).toBe(1);
    await assertEffect("copy", file, (await onlyRow()).id);
  });

  test("comment intent binds metadata, pinning and its own activity marker and permits one update", async () => {
    const file = await fixture("guard-comment");
    const tracked = wire();
    const guarded = connectFilegate(config, tracked.transport).root("cloud");
    const options = { pinned: false, metadata: { ...file.version.metadata, comment: "Ready for review", author: "alice" } };
    await fileAction(
      callFor("comment"),
      { ...intent(file, "version.comment"), versionOptions: options },
      async () => {
        const metadata = { ...options.metadata, comment_activity: currentActivityId() };
        const refused = [
          () => guarded.updateVersion(file.target, `${file.version.id}-other`, { ...options, metadata }),
          () => guarded.updateVersion(`${file.target}-other`, file.version.id, { ...options, metadata }),
          () => guarded.updateVersion(file.target, file.version.id, options),
          () =>
            guarded.updateVersion(file.target, file.version.id, {
              ...options,
              metadata: { ...metadata, comment_activity: Bun.randomUUIDv7() },
            }),
          () =>
            guarded.updateVersion(file.target, file.version.id, { ...options, metadata: { ...metadata, comment: "Changed after intent" } }),
          () => guarded.updateVersion(file.target, file.version.id, { ...options, pinned: true, metadata }),
        ];
        for (const run of refused) await expect(run()).rejects.toMatchObject({ code: "activity_scope_mismatch" });
        expect(tracked.mutations()).toBe(0);
        await guarded.updateVersion(file.target, file.version.id, { ...options, metadata });
        await expect(guarded.updateVersion(file.target, file.version.id, { ...options, metadata })).rejects.toMatchObject({
          code: "activity_scope_mismatch",
        });
      },
      async () => {},
    );
    expect(tracked.mutations()).toBe(1);
    await assertEffect("comment", file, (await onlyRow()).id);
  });

  test("a lost comment response recovers from its exact metadata marker without another mutation", async () => {
    const file = await fixture("lost-comment");
    const losing = wire(true);
    await expect(invoke(losing.service, "comment", file)).rejects.toThrow("lost version response");
    const pending = await onlyRow();
    expect(pending).toMatchObject({ state: "pending", finished_at: null });
    expect(losing.lost()).toBe(1);
    await assertEffect("comment", file, pending.id);
    expect(await recover(losing.transport)).toEqual({ checked: 1 });
    expect(await onlyRow()).toMatchObject({ id: pending.id, state: "done" });
    expect((await onlyRow()).finished_at).toBeInstanceOf(Date);
    expect(await recover(losing.transport)).toEqual({ checked: 0 });
    expect(losing.mutations()).toBe(1);
    await assertEffect("comment", file, pending.id);
  });

  test("matching comment text, a foreign marker or a marker on another saved version cannot confirm a lost update", async () => {
    for (const mismatch of ["missing", "foreign", "other-version"] as const) {
      const file = await fixture(`unproven-comment-${mismatch}`);
      const losing = wire(true);
      await expect(invoke(losing.service, "comment", file)).rejects.toThrow("lost version response");
      const [pending] = await sql<ActivityRow[]>`SELECT * FROM filesv2.activity WHERE version_id=${file.version.id}`;
      expect(pending).toBeDefined();
      const metadata = { ...file.version.metadata, comment: "Ready for review", author: "alice" };
      await root().updateVersion(file.target, file.version.id, {
        pinned: false,
        metadata: mismatch === "foreign" ? { ...metadata, comment_activity: Bun.randomUUIDv7() } : metadata,
      });
      if (mismatch === "other-version") {
        const decoy = await root().snapshot(file.target, { metadata: { ...metadata, comment_activity: pending!.id } });
        expect(decoy.id).not.toBe(file.version.id);
      }
      await recover(losing.transport);
      const [recovered] = await sql<ActivityRow[]>`SELECT * FROM filesv2.activity WHERE id=${pending!.id}::uuid`;
      expect(recovered).toMatchObject({ state: "unclear", finished_at: null });
      expect(losing.lost()).toBe(1);
      expect(losing.mutations()).toBe(1);
    }
    expect(await rows()).toHaveLength(3);
  });

  test("a matching marker on a replacement file does not confirm the original file's comment", async () => {
    const file = await fixture("replacement-comment");
    const losing = wire(true);
    await expect(invoke(losing.service, "comment", file)).rejects.toThrow("lost version response");
    const pending = await onlyRow();
    await root().transfer(file.target, "cloud", `${file.target}-moved`, { move: true, onConflict: "error" });
    await root().put(file.target, new Blob([currentContent]));
    const replacement = await root().snapshot(file.target, {
      metadata: { comment: "Ready for review", author: "alice", comment_activity: pending.id },
    });
    expect(replacement.id).not.toBe(file.version.id);
    if (stableIds) expect((await root().stat(file.target)).id).not.toBe(file.before.id);
    expect(await recover(losing.transport)).toEqual({ checked: 1 });
    expect(await onlyRow()).toMatchObject({ id: pending.id, state: "unclear", finished_at: null });
    expect(losing.mutations()).toBe(1);
    expect(losing.lost()).toBe(1);
  });

  test.each(["restore", "copy", "delete", "adminDelete"] as const)(
    "a lost %s response stays unclear despite the visible effect",
    async (operation) => {
      const file = await fixture(`lost-${operation}`);
      const losing = wire(true);
      await expect(invoke(losing.service, operation, file)).rejects.toThrow("lost version response");
      const pending = await onlyRow();
      expect(pending).toMatchObject({ state: "pending", finished_at: null });
      expect(losing.lost()).toBe(1);
      await assertEffect(operation, file, pending.id);
      expect(await recover(losing.transport)).toEqual({ checked: 1 });
      expect(await onlyRow()).toMatchObject({ id: pending.id, state: "unclear", finished_at: null });
      await recover(losing.transport);
      expect((await onlyRow()).state).toBe("unclear");
      expect(losing.mutations()).toBe(1);
      expect(await sql`SELECT id FROM audit.events WHERE action='filesv2.version.delete'`).toHaveLength(0);
    },
  );

  test.each(["delete", "adminDelete"] as const)("%s audit failure leaves history pending after the actual deletion", async (operation) => {
    const file = await fixture(`audit-failure-${operation}`);
    const tracked = wire();
    await sql`CREATE FUNCTION audit.reject_version_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'version audit unavailable'; END $$`.simple();
    await sql`CREATE TRIGGER reject_version_delete BEFORE INSERT ON audit.events FOR EACH ROW WHEN (NEW.action='filesv2.version.delete') EXECUTE FUNCTION audit.reject_version_delete()`.simple();
    try {
      await expect(invoke(tracked.service, operation, file)).rejects.toThrow("version audit unavailable");
      expect(tracked.mutations()).toBe(1);
      const pending = await onlyRow();
      expect(pending).toMatchObject({ state: "pending", finished_at: null });
      await assertEffect(operation, file, pending.id);
      expect(await sql`SELECT id FROM audit.events WHERE action='filesv2.version.delete'`).toHaveLength(0);
      expect(await recover(tracked.transport)).toEqual({ checked: 1 });
      expect(await onlyRow()).toMatchObject({ id: pending.id, state: "unclear", finished_at: null });
      expect(tracked.mutations()).toBe(1);
    } finally {
      await sql`DROP TRIGGER reject_version_delete ON audit.events`.simple();
      await sql`DROP FUNCTION audit.reject_version_delete()`.simple();
    }
  });
});
