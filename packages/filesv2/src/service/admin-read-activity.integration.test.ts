import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, FilegateError, type Node } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { activityFilegate } from "../../test/activity-filegate";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { AdminLocator, Configuration } from "../contracts";
import { bindings } from "../data/bases";
import { migrate } from "../migrate";
import type { UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

const suite = suiteFor("database", "nats");
const stamp = new Date("2030-05-14T12:00:00Z");
const content = "Administrative access needs durable evidence.\n";
const operations = ["list", "download", "versions"] as const;
type Operation = (typeof operations)[number];
type ActivityRow = {
  id: string;
  action: string;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  detail: Record<string, unknown>;
  xmin: string;
};
type AuditRow = {
  action: string;
  outcome: string;
  metadata: Record<string, unknown>;
  xmin: string;
};

suite("administrative read history with real Filegate", () => {
  const prefix = `filesv2-admin-read-${Bun.randomUUIDv7()}`;
  const home = `${prefix}/users/alice`;
  let ownsPrefix = false;
  let processSync: ProcessSync | undefined;
  let storage: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let client: Filegate;
  let config: Configuration & { token: string; tokenConfigured: boolean; unreadable: boolean };
  let owner: Extract<RequestActor, { kind: "user" }>;
  let administrator: Extract<RequestActor, { kind: "user" }>;
  let bindingId: string;
  let service: ReturnType<typeof createFilesService>;
  const root = () => client.root("cloud");
  const rows = () => sql<ActivityRow[]>`SELECT *,size::float8,xmin::text FROM filesv2.activity ORDER BY id`;
  const audits = () => sql<AuditRow[]>`SELECT *,xmin::text FROM audit.events ORDER BY id`;
  const callFor = (operation: Operation): UserFilesCall => ({
    ...testCall(administrator),
    // The grant subject must not replace the actual administrator in history.
    accessSubject: { type: "user", userId: owner.user.id },
    via: operation === "list" ? "web" : operation === "download" ? "cli" : "app:observatory",
    requestId: `admin-${operation}-request`,
    invocationId: `admin-${operation}-invocation`,
    callingApp: "observatory",
    origin: "https://observatory.example.test",
  });

  function makeService(versioningDisabled = false) {
    return createFilesService({
      identities: {
        ...accountIdentities,
        // Keep inventory authorization real; only the unrelated identity RPC
        // and group lookup are replaced, as in the version-activity suite.
        self: async (actor) => {
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
      connect: (configuration) => {
        const facade = connectFilegate(configuration);
        if (versioningDisabled) {
          const realRoot = facade.root.bind(facade);
          facade.root = (name) => {
            const connected = realRoot(name);
            const info = connected.info.bind(connected);
            // Exercise the disabled-support branch, while stat and every
            // other file read still go to the actual Filegate fixture.
            connected.info = async () => {
              const actual = await info();
              return { ...actual, versioning: { ...actual.versioning, enabled: false } };
            };
            connected.versions = async () => {
              throw new Error("disabled versioning must not query versions");
            };
            return connected;
          };
        }
        return facade;
      },
    });
  }

  async function fixture(name: string) {
    const directory = `${home}/${name}`;
    const target = `${directory}/evidence.txt`;
    await root().mkdir(directory, { ownership: { dirMode: "0700" } });
    await root().put(target, new Blob([content]));
    const version = await root().snapshot(target, {
      metadata: { comment: "Reviewed", author: "Alice", reviewed_at: stamp.toISOString() },
    });
    return { directory, target, path: `${name}/evidence.txt`, before: await root().stat(target), version };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function locator(operation: Operation, file: Fixture): AdminLocator {
    return { area: "cloud", kind: "users", name: "alice", path: operation === "list" ? file.path.split("/")[0]! : file.path };
  }
  function invoke(operation: Operation, input: AdminLocator, call = callFor(operation), targetService = service) {
    switch (operation) {
      case "list":
        return targetService.adminList(call, input);
      case "download":
        return targetService.adminDownload(call, input);
      case "versions":
        return targetService.adminVersions(call, input);
    }
  }
  async function assertEvidence(operation: Operation, node: Node, call: UserFilesCall) {
    const entries = await rows();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      action: "admin.read",
      state: "done",
      server_url: config.url,
      root: "cloud",
      root_after: null,
      base_id: bindingId,
      base_after_id: null,
      item_id: node.id ?? null,
      item_after_id: null,
      directory: node.directory,
      name: node.path.split("/").at(-1),
      path_before: node.path,
      path_after: null,
      size: node.size,
      revision_before: node.revision ?? null,
      revision_after: null,
      version_id: null,
      actor_kind: "user",
      actor_user_id: administrator.user.id,
      via: call.via,
      request_id: call.requestId,
      invocation_id: call.invocationId,
      calling_app: call.callingApp,
      origin: call.origin,
      batch_id: null,
      share_id: null,
      error_code: null,
      detail: { operation },
    });
    expect(entry.detail).toEqual({ operation });
    expect(entry.started_at).toBeInstanceOf(Date);
    expect(entry.finished_at).toEqual(entry.started_at);
    const events = await audits();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "filesv2.admin.read",
      outcome: "allowed",
      actor_user_id: administrator.user.id,
      actor_uid: administrator.user.uid,
      request_id: call.requestId,
      target_type: "filesv2.item",
      target_id: node.id ?? node.path,
      target_label: node.path,
      // INSERT, terminal history UPDATE and Core audit all commit together.
      xmin: entry.xmin,
    });
    expect(events[0]!.metadata).toEqual({ operation, historyId: entry.id });
  }
  async function assertDownload(lease: { url: string; method: string; expires: string }) {
    expect(lease.method).toBe("GET");
    expect(Number.isNaN(Date.parse(lease.expires))).toBe(false);
    const response = await fetch(lease.url);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(content);
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
    expect((await root().info()).versioning.enabled).toBe(true);
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
    await sql`CREATE TABLE auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id),managed_by text,uid_number integer,primary_gid_number integer,primary_group_id uuid)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text)`.simple();
    await migrate();
    await migrateAudit();
    const linux = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };
    await sql`INSERT INTO settings.entries(key,value) VALUES('linux.identity_config',${await secrets.encrypt(JSON.stringify(linux))})`;
    if (testActor.kind !== "user") throw new Error("expected user fixture");
    owner = { ...testActor, user: { ...testActor.user, roles: ["user"] } };
    administrator = {
      ...owner,
      user: { ...owner.user, id: "10000000-0000-4000-8000-000000000002", uid: "bob", displayName: "Bob", roles: ["user", "admin"] },
    };
    for (const actor of [owner, administrator])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
        VALUES(${actor.user.id}::uuid,${actor.user.uid},'local','user',${actor === administrator})`;
    await root().mkdir(prefix, { ownership: { dirMode: "0755" } });
    ownsPrefix = true;
    await root().mkdir(`${prefix}/users`, { ownership: { dirMode: "0755" } });
    await root().mkdir(home, { ownership: { dirMode: "0700" } });
    bindingId = (
      await bindings.claim({
        area: "cloud",
        kind: "users",
        identity_id: owner.user.id,
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

  test.each([...operations])("%s returns real data only with completed history and a matching security audit", async (operation) => {
    const file = await fixture(`success-${operation}`);
    const input = locator(operation, file);
    const call = callFor(operation);
    const node = operation === "list" ? await root().stat(file.directory) : file.before;
    switch (operation) {
      case "list": {
        const result = await service.adminList(call, input);
        expect(result).toMatchObject({ basePath: home, path: input.path, archiveId: null, versioningEnabled: true });
        expect(result.items).toEqual([
          { name: "evidence.txt", path: file.path, directory: false, size: file.before.size, modified: file.before.modified },
        ]);
        break;
      }
      case "download":
        await assertDownload(await service.adminDownload(call, input));
        break;
      case "versions": {
        const actual = await root().versions(file.target);
        expect(await service.adminVersions(call, input)).toEqual(
          actual.map((version) => ({
            id: version.id,
            created: version.created,
            size: version.size,
            pinned: version.pinned,
            comment: typeof version.metadata?.comment === "string" ? version.metadata.comment : null,
            author: typeof version.metadata?.author === "string" ? version.metadata.author : null,
          })),
        );
        expect(actual.some((version) => version.id === file.version.id)).toBe(true);
      }
    }
    await assertEvidence(operation, node, call);
    expect(await root().stat(file.target)).toEqual(file.before);
  });

  test("disabled version support still records an administrative versions read returning an empty list", async () => {
    const file = await fixture("versions-disabled");
    const call = callFor("versions");
    expect(await makeService(true).adminVersions(call, locator("versions", file))).toEqual([]);
    await assertEvidence("versions", file.before, call);
  });

  for (const failure of ["insert", "finish", "audit"] as const) {
    test.each([...operations])(`${failure} failure rolls back history and audit and rejects the %s result`, async (operation) => {
      const file = await fixture(`failure-${failure}-${operation}`);
      const beforeVersions = await root().versions(file.target);
      await sql`CREATE FUNCTION filesv2.reject_admin_read_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'admin read evidence unavailable'; END $$`.simple();
      if (failure === "audit")
        await sql`CREATE TRIGGER reject_admin_read_evidence BEFORE INSERT ON audit.events
          FOR EACH ROW WHEN (NEW.action='filesv2.admin.read') EXECUTE FUNCTION filesv2.reject_admin_read_evidence()`.simple();
      else if (failure === "insert")
        await sql`CREATE TRIGGER reject_admin_read_evidence BEFORE INSERT ON filesv2.activity
          FOR EACH ROW WHEN (NEW.action='admin.read') EXECUTE FUNCTION filesv2.reject_admin_read_evidence()`.simple();
      else
        await sql`CREATE TRIGGER reject_admin_read_evidence BEFORE UPDATE ON filesv2.activity
          FOR EACH ROW WHEN (NEW.action='admin.read' AND NEW.state='done') EXECUTE FUNCTION filesv2.reject_admin_read_evidence()`.simple();
      try {
        let returned = false;
        await expect(
          invoke(operation, locator(operation, file)).then(() => {
            returned = true;
          }),
        ).rejects.toThrow("admin read evidence unavailable");
        expect(returned).toBe(false);
        expect(await rows()).toHaveLength(0);
        expect(await audits()).toHaveLength(0);
        expect(await root().stat(file.target)).toEqual(file.before);
        expect(await root().versions(file.target)).toEqual(beforeVersions);
      } finally {
        if (failure === "audit") await sql`DROP TRIGGER reject_admin_read_evidence ON audit.events`.simple();
        else await sql`DROP TRIGGER reject_admin_read_evidence ON filesv2.activity`.simple();
        await sql`DROP FUNCTION filesv2.reject_admin_read_evidence()`.simple();
      }
    });
  }

  test.each([...operations])("a nonadministrator cannot %s administratively or emit allowed evidence", async (operation) => {
    const file = await fixture(`denied-${operation}`);
    // An administrator as access subject cannot elevate the nonadmin actor.
    const call: UserFilesCall = { ...testCall(owner), accessSubject: { type: "user", userId: administrator.user.id } };
    await expect(invoke(operation, locator(operation, file), call)).rejects.toMatchObject({ code: "admin_required", status: 403 });
    expect(await rows()).toHaveLength(0);
    expect((await audits()).filter((event) => event.outcome === "allowed")).toHaveLength(0);
  });

  test("ordinary list, download and versions reads do not emit administrative history or audit", async () => {
    const file = await fixture("ordinary-read");
    const call = testCall(owner);
    const baseId = `cloud:users:${owner.user.id}`;
    const page = await service.list(call, { baseId, path: "ordinary-read" });
    expect(page.items.map((item) => item.path)).toEqual([file.path]);
    await assertDownload(await service.download(call, { baseId, path: file.path }));
    expect((await service.versions(call, { baseId, path: file.path })).some((version) => version.id === file.version.id)).toBe(true);
    expect((await rows()).filter((entry) => entry.action === "admin.read")).toHaveLength(0);
    expect((await audits()).filter((event) => event.action === "filesv2.admin.read")).toHaveLength(0);
  });

  test("an archived target retains the original base binding in administrative read history", async () => {
    const archiveId = "20000000-0000-4000-8000-000000000001";
    const target = `${prefix}/archive/${archiveId}/contents`;
    // Seed a completed archive at its real on-disk location. This test covers
    // reads of an existing archive, not execution of the archive operation.
    await root().mkdir(`${prefix}/archive`, { ownership: { dirMode: "0700" } });
    await root().mkdir(`${prefix}/archive/${archiveId}`, { ownership: { dirMode: "0700" } });
    await root().mkdir(target, { ownership: { dirMode: "0700" } });
    await root().put(`${target}/evidence.txt`, new Blob([content]));
    const node = await root().stat(target);
    await sql`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,target,base_id,state,created_at,updated_at)
      VALUES(${archiveId}::uuid,'cloud','users','cloud',${config.url},'alice','archive',${home},${target},${bindingId}::uuid,'complete',${stamp},${stamp})`;
    expect(await bindings.path("cloud", target)).toBeNull();
    const call = callFor("list");
    const result = await service.adminList(call, { area: "cloud", archiveId, path: "" });
    expect(result).toMatchObject({ archiveId, basePath: target, name: "alice", kind: "users" });
    expect(result.items.map((item) => item.path)).toEqual(["evidence.txt"]);
    await assertEvidence("list", node, call);
  });
});
