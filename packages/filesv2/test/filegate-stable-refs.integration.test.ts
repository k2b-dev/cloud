import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import { UserSchema } from "@k2b/cloud/contracts";
import { type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { type AccountIdentityGroup, accountIdentities, secrets } from "@k2b/cloud/services";
import { Filegate, type RootClient } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import type { Configuration } from "../src/contracts";
import { bindings } from "../src/data/bases";
import { persistedEntryRefId } from "../src/data/references";
import { migrate } from "../src/migrate";
import { entryRefId, parseStableEntryRefId } from "../src/resource-ref";
import { createFilesService } from "../src/service";
import { assertPrivateDatabase } from "./private-database";

// A private Filegate container with one root that offers stable IDs and one indexed root that does not.
// Never attach the shared development daemon or its volumes. The suite starts its own daemon, so it needs
// no `CLOUD_TEST_FILEGATE_URL` and runs wherever Docker is available, including the CI gate.
const dockerAvailable = (await Bun.$`docker info`.quiet().nothrow()).exitCode === 0;
const suite = dockerAvailable ? suiteFor("database", "nats") : describe.skip;
const version = "7.0.0";
const name = `filesv2-stable-refs-${randomUUID()}`;
const volume = `${name}-data`;

async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`Docker fixture failed: ${stderr}`);
  return stdout.trim();
}

suite(
  dockerAvailable
    ? `Filegate ${version} stable Files references`
    : `Filegate ${version} stable Files references (skipped: docker is not available)`,
  () => {
    let directory: string | undefined;
    let ownsVolume = false;
    let ownsContainer = false;
    let processSync: ProcessSync | undefined;
    let baseUrl = "";
    let client: Filegate;
    let stable: RootClient;
    let indexed: RootClient;
    /** Runs once after the next `resolve` answer, before the service sees it. */
    let afterResolve: (() => Promise<void>) | undefined;
    /** Answers the next `resolve` request instead of Filegate. */
    let resolveFailure: (() => Response) | undefined;
    const resolves: string[] = [];
    let memberships: AccountIdentityGroup[] = [];
    let alice: RequestActor;
    let bob: RequestActor;
    let carol: RequestActor;
    const groupId = randomUUID();
    const configuration = (root: string): Configuration & { token: string; tokenConfigured: boolean } => ({
      url: baseUrl,
      token: "fixture",
      tokenConfigured: true,
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
      cloud: {
        enabled: true,
        root,
        prefix: "",
        homes: "users",
        groups: "groups",
        archive: "archive",
        autoCreate: true,
        autoArchive: false,
      },
      freeipa: { enabled: false, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
    });
    let services: { stable: ReturnType<typeof createFilesService>; indexed: ReturnType<typeof createFilesService> };
    const id = (actor: RequestActor) => (actor.kind === "user" ? actor.user.id : "");
    const home = (actor: RequestActor) => `cloud:users:${id(actor)}`;
    const createUser = async (username: string): Promise<RequestActor> => {
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${username},'local','user',false) RETURNING id`;
      return {
        kind: "user",
        user: UserSchema.parse({
          id: row!.id,
          uid: username,
          provider: "local",
          profile: "user",
          roles: ["user"],
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
          ipa: null,
        }),
      };
    };
    const ref = async (service: typeof services.stable, actor: RequestActor, baseId: string, path: string) =>
      (await service.entry(actor, { baseId, path })).resourceId!;
    const notFound = { code: "not_found", status: 404 };

    beforeAll(async () => {
      await assertPrivateDatabase();
      directory = await mkdtemp(join(tmpdir(), "filesv2-stable-refs-"));
      const token = randomUUID();
      await Bun.write(join(directory, "token"), token);
      await Bun.write(
        join(directory, "conf.yaml"),
        `server:
  listen: "0.0.0.0:4000"
  public_url: "http://127.0.0.1:4000"
auth:
  token_file: /config/token
state_dir: /data/state
roots:
  - name: stable
    path: /data/stable
    managed: true
    index: true
  - name: indexed
    path: /data/indexed
    index: true
`,
      );
      await docker("volume", "create", volume);
      ownsVolume = true;
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${volume}:/data`,
        "debian:13-slim",
        "sh",
        "-eu",
        "-c",
        "mkdir -p /data/stable /data/indexed /data/state; chmod 700 /data/stable /data/indexed",
      );
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "FSETID",
        "--security-opt",
        "no-new-privileges:true",
        "-p",
        "127.0.0.1::4000",
        "-v",
        `${volume}:/data`,
        "-v",
        `${directory}:/config:ro`,
        `ghcr.io/k2b-dev/filegate:${version}`,
        "serve",
        "--config",
        "/config/conf.yaml",
      );
      ownsContainer = true;
      baseUrl = `http://${await docker("port", name, "4000/tcp")}`;
      const transport = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const resolving = url.pathname.endsWith("/resolve");
          const failure = resolving ? resolveFailure : undefined;
          if (failure) {
            resolveFailure = undefined;
            return failure();
          }
          const response = await fetch(input, init);
          if (resolving) {
            resolves.push(url.searchParams.get("id") ?? "");
            const hook = afterResolve;
            afterResolve = undefined;
            await hook?.();
          }
          return response;
        },
        { preconnect: fetch.preconnect },
      );
      client = new Filegate({ baseUrl, transferBaseUrl: baseUrl, token, fetch: transport });
      const readyUntil = Date.now() + 30_000;
      for (;;) {
        try {
          expect((await client.system()).version).toBe(version);
          break;
        } catch {
          if (Date.now() >= readyUntil) throw new Error(`Filegate fixture did not start: ${await docker("logs", name)}`);
          await Bun.sleep(250);
        }
      }
      stable = client.root("stable");
      indexed = client.root("indexed");
      expect((await stable.info()).stableIds).toBe(true);
      expect((await indexed.info()).stableIds).toBe(false);

      processSync = await startProcessSync({ application: "filesv2" });
      await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
      await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
      await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
      await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer,primary_group_id uuid,home_directory text,login_shell text)`.simple();
      await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
      await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
      await migrate();
      await sql`TRUNCATE filesv2.operations,filesv2.bases,auth.user_posix,auth.users,settings.entries CASCADE`.simple();
      const linux = JSON.stringify({
        enabled: true,
        rangeStart: 200000,
        rangeEnd: 200100,
        homeTemplate: "/home/{username}",
        loginShell: "/bin/bash",
      });
      await sql`INSERT INTO settings.entries(key,value) VALUES('linux.identity_config',${await secrets.encrypt(linux)})`;
      alice = await createUser("stable-refs-alice");
      bob = await createUser("stable-refs-bob");
      carol = await createUser("stable-refs-carol");
      // Group membership is the access a stable ref must not outlive; the identity service itself is tested by the platform.
      const identities: typeof accountIdentities = {
        ...accountIdentities,
        groups: async () => ({ items: memberships, nextCursor: null }),
      };
      const create = (root: string) =>
        createFilesService({
          identities,
          displayNames: resolveDisplayNames,
          bindings,
          readConfiguration: async () => configuration(root),
          writeConfiguration: async () => {},
          connect: () => client,
          publicOrigin: async () => "http://localhost:3000",
          userById: async () => null,
          transfer: fetch,
        });
      services = { stable: create("stable"), indexed: create("indexed") };
    }, 60_000);
    afterAll(async () => {
      await processSync?.stop();
      if (ownsContainer) await docker("rm", "-f", name);
      if (ownsVolume) await docker("volume", "rm", volume);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    test("rename and move keep the ref, including for descendants of a moved folder", async () => {
      const service = services.stable;
      const baseId = home(alice);
      await service.mkdir(alice, { baseId, path: "Projects" });
      await service.mkdir(alice, { baseId, path: "Projects/Q4" });
      await service.mkdir(alice, { baseId, path: "Archive" });
      await service.createFromBytes(alice, { baseId, path: "Projects/Q4/plan.txt" }, new TextEncoder().encode("plan"));
      const file = await ref(service, alice, baseId, "Projects/Q4/plan.txt");
      const folder = await ref(service, alice, baseId, "Projects/Q4");
      expect(parseStableEntryRefId(file)?.baseId).toBe(baseId);
      expect(folder).not.toBe(file);

      const renamed = await service.rename(alice, { baseId, path: "Projects/Q4/plan.txt", name: "budget.txt" });
      expect(renamed.entry.resourceId).toBe(file);
      expect((await service.entryById(alice, file)).entry.path).toBe("Projects/Q4/budget.txt");

      const moved = await service.move(alice, { baseId, paths: ["Projects/Q4"], folder: "Archive" });
      expect(moved.entries[0]).toMatchObject({ path: "Archive/Q4", resourceId: folder });
      expect((await service.entryById(alice, folder)).entry.path).toBe("Archive/Q4");
      const descendant = await service.entryById(alice, file);
      expect(descendant).toMatchObject({ resourceId: file, entry: { path: "Archive/Q4/budget.txt", resourceId: file } });
      // Lists, searches and downloads hand out and accept the same ref.
      expect((await service.list(alice, { baseId, path: "Archive/Q4" })).items.map((item) => item.resourceId)).toEqual([file]);
      expect((await service.search(alice, { baseId, q: "budget" })).items.map((item) => item.resourceId)).toEqual([file]);
      // The fixture's public URL is not reachable from the host; send the lease to the mapped port instead.
      const lease = new URL((await service.downloadById(alice, file)).url);
      expect(await (await fetch(new URL(`${lease.pathname}${lease.search}`, baseUrl))).text()).toBe("plan");
    }, 30_000);

    test("trash hides the ref and restore brings the same ref back", async () => {
      const service = services.stable;
      const baseId = home(alice);
      await service.createFromBytes(alice, { baseId, path: "draft.txt" }, new TextEncoder().encode("draft"));
      const file = await ref(service, alice, baseId, "draft.txt");
      const removed = await service.remove(alice, { baseId, paths: ["draft.txt"] });
      const trashed = removed.results[0]!;
      if (!trashed.ok) throw new Error(`trash failed: ${trashed.error}`);
      await expect(service.entryById(alice, file)).rejects.toMatchObject(notFound);
      const restored = await service.restoreTrash(alice, { baseId, id: trashed.entry.id });
      expect(restored.entry).toMatchObject({ path: "draft.txt", resourceId: file });
      expect((await service.entryById(alice, file)).entry.path).toBe("draft.txt");
    }, 30_000);

    test("a copy gets its own ref; a deleted and recreated file does not inherit the old one", async () => {
      const service = services.stable;
      const baseId = home(alice);
      await service.createFromBytes(alice, { baseId, path: "report.txt" }, new TextEncoder().encode("v1"));
      const original = await ref(service, alice, baseId, "report.txt");
      const copied = await service.copy(alice, { baseId, paths: ["report.txt"], targetBaseId: baseId, folder: "Archive" });
      const copy = copied.entries[0]!.resourceId!;
      expect(parseStableEntryRefId(copy)).not.toBeNull();
      expect(copy).not.toBe(original);
      expect((await service.entryById(alice, original)).entry.path).toBe("report.txt");
      expect((await service.entryById(alice, copy)).entry.path).toBe("Archive/report.txt");
      await stable.put("users/stable-refs-alice/report.txt", new Blob(["v1, edited"]), { onConflict: "overwrite" });
      expect((await service.entryById(alice, original)).entry.size).toBe(10);

      const pathRef = entryRefId(baseId, "report.txt")!;
      await stable.remove(`users/stable-refs-alice/report.txt`);
      await stable.put(`users/stable-refs-alice/report.txt`, new Blob(["v2"]));
      await expect(service.entryById(alice, original)).rejects.toMatchObject(notFound);
      // A path ref keeps its path semantics and names whatever file is there now.
      const replacement = await service.entryById(alice, pathRef);
      expect(replacement.entry.path).toBe("report.txt");
      expect(replacement.resourceId).not.toBe(original);
    }, 30_000);

    test("a ref moved away and replaced between resolve and stat is not found, not the newcomer", async () => {
      const service = services.stable;
      const baseId = home(alice);
      await service.createFromBytes(alice, { baseId, path: "race.txt" }, new TextEncoder().encode("first"));
      const file = await ref(service, alice, baseId, "race.txt");
      afterResolve = async () => {
        await stable.transfer("users/stable-refs-alice/race.txt", "stable", "users/stable-refs-alice/Archive/race.txt", { move: true });
        await stable.put("users/stable-refs-alice/race.txt", new Blob(["second"]));
      };
      await expect(service.entryById(alice, file)).rejects.toMatchObject(notFound);
      expect(afterResolve).toBeUndefined();
      expect((await service.entryById(alice, file)).entry.path).toBe("Archive/race.txt");
    }, 30_000);

    test("revoked access answers not found before Filegate is asked", async () => {
      const service = services.stable;
      memberships = [{ id: groupId, provider: "local", name: "stable-refs-team", gidNumber: 40001, personal: false }];
      const baseId = `cloud:groups:${groupId}`;
      expect((await service.bases(bob)).items.find((base) => base.id === baseId)).toMatchObject({ status: "existing", stableIds: true });
      await service.createFromBytes(bob, { baseId, path: "shared.txt" }, new TextEncoder().encode("team"));
      const file = await ref(service, bob, baseId, "shared.txt");
      expect((await service.entryById(bob, file)).entry.name).toBe("shared.txt");
      memberships = [];
      resolves.length = 0;
      await expect(service.entryById(bob, file)).rejects.toMatchObject(notFound);
      await expect(service.downloadById(bob, file)).rejects.toMatchObject(notFound);
      // Someone else's base is not a lookup oracle either.
      await expect(service.entryById(alice, file)).rejects.toMatchObject(notFound);
      expect(resolves).toEqual([]);
      // Unknown file IDs in a base the actor may use are not found, never unavailable.
      const unknown = `n:${home(alice)}:${randomUUID()}`;
      await expect(service.entryById(alice, unknown)).rejects.toMatchObject(notFound);
      expect(resolves).toHaveLength(1);
    }, 30_000);

    test("a base the actor cannot use answers before Filegate is asked, so old IDs reveal nothing", async () => {
      const service = services.stable;
      const old = randomUUID();
      memberships = [{ id: old, provider: "local", name: "stable-refs-reused", gidNumber: 40002, personal: false }];
      await service.createFromBytes(bob, { baseId: `cloud:groups:${old}`, path: "old.txt" }, new TextEncoder().encode("old"));
      const fileId = parseStableEntryRefId(await ref(service, bob, `cloud:groups:${old}`, "old.txt"))!.fileId;
      // The group is deleted and a new one takes its name, so its candidate path still holds the old group's directory.
      const reused = randomUUID();
      memberships = [{ id: reused, provider: "local", name: "stable-refs-reused", gidNumber: 40003, personal: false }];
      expect((await service.bases(bob)).items.find((base) => base.id === `cloud:groups:${reused}`)).toMatchObject({
        status: "conflict",
        reason: "binding_conflict",
      });
      resolves.length = 0;
      const conflict = { code: "binding_conflict", status: 403 };
      for (const id of [fileId, randomUUID()]) {
        await expect(service.entryById(bob, `n:cloud:groups:${reused}:${id}`)).rejects.toMatchObject(conflict);
        await expect(service.downloadById(bob, `n:cloud:groups:${reused}:${id}`)).rejects.toMatchObject(conflict);
      }
      expect(resolves).toEqual([]);
      memberships = [];
    }, 30_000);

    test("a stable ref never reaches outside its base, not even its root folder", async () => {
      const service = services.stable;
      const team = randomUUID();
      memberships = [{ id: team, provider: "local", name: "stable-refs-other", gidNumber: 40004, personal: false }];
      await service.createFromBytes(alice, { baseId: `cloud:groups:${team}`, path: "team.txt" }, new TextEncoder().encode("team"));
      const teamFile = parseStableEntryRefId(await ref(service, alice, `cloud:groups:${team}`, "team.txt"))!.fileId;
      const homeRoot = (await stable.stat("users/stable-refs-alice")).id;
      const teamRoot = (await stable.stat("groups/stable-refs-other")).id;
      expect(homeRoot && teamRoot).toBeTruthy();
      resolves.length = 0;
      // Alice may use both bases; each ID still names its own base only.
      await expect(service.entryById(alice, `n:${home(alice)}:${teamFile}`)).rejects.toMatchObject(notFound);
      await expect(service.entryById(alice, `n:${home(alice)}:${homeRoot}`)).rejects.toMatchObject(notFound);
      await expect(service.entryById(alice, `n:cloud:groups:${team}:${teamRoot}`)).rejects.toMatchObject(notFound);
      expect(resolves).toHaveLength(3);
      memberships = [];
    }, 30_000);

    test("resolution failures are not found; storage outages stay unavailable", async () => {
      const service = services.stable;
      const baseId = home(alice);
      const file = await ref(service, alice, baseId, "Archive/Q4/budget.txt");
      const problem = (status: number, error: string) => () => Response.json({ error, message: error }, { status });
      // Managed turned off: Filegate refuses ID operations until it is on again.
      resolveFailure = problem(409, "feature_disabled");
      await expect(service.entryById(alice, file)).rejects.toMatchObject(notFound);
      resolveFailure = problem(400, "invalid_id");
      await expect(service.entryById(alice, file)).rejects.toMatchObject(notFound);
      resolveFailure = problem(503, "unavailable");
      await expect(service.entryById(alice, file)).rejects.toMatchObject({ status: 503 });
      resolveFailure = () => {
        throw new TypeError("fetch failed");
      };
      await expect(service.entryById(alice, file)).rejects.toMatchObject({ code: "unavailable", status: 503 });
      expect((await service.entryById(alice, file)).entry.path).toBe("Archive/Q4/budget.txt");
    }, 30_000);

    test("old inline and persisted path refs keep resolving on a stable-ID base", async () => {
      const service = services.stable;
      const baseId = home(alice);
      const long = `${"Ordner ä/".repeat(40)}deep.txt`;
      let folder = "";
      for (const part of long.split("/").slice(0, -1)) {
        folder = folder ? `${folder}/${part}` : part;
        await service.mkdir(alice, { baseId, path: folder });
      }
      await service.createFromBytes(alice, { baseId, path: long }, new TextEncoder().encode("deep"));
      const persisted = await persistedEntryRefId(baseId, long);
      expect(persisted).toMatch(/^p:[a-f0-9]{64}$/);
      const inline = entryRefId(baseId, "Archive/Q4/budget.txt")!;
      expect((await service.entryById(alice, persisted)).entry.path).toBe(long);
      const old = await service.entryById(alice, inline);
      expect(old.entry.path).toBe("Archive/Q4/budget.txt");
      // Reading through an old ref hands out the stable ref for future links.
      expect(parseStableEntryRefId(old.resourceId!)).not.toBeNull();
    }, 60_000);

    test("a base without stable IDs keeps path refs", async () => {
      const service = services.indexed;
      const baseId = home(carol);
      expect((await service.bases(carol)).items[0]).toMatchObject({ id: baseId, stableIds: false });
      await service.createFromBytes(carol, { baseId, path: "notes.txt" }, new TextEncoder().encode("notes"));
      const result = await service.entry(carol, { baseId, path: "notes.txt" });
      // Filegate 7 removes node IDs on roots without stable IDs, so no entry can mint a stable ref there.
      expect(result.entry.resourceId).toBeUndefined();
      expect(result.resourceId).toBe(entryRefId(baseId, "notes.txt")!);
      expect((await service.list(carol, { baseId })).items.every((item) => item.resourceId === undefined)).toBe(true);
      const renamed = await service.rename(carol, { baseId, path: "notes.txt", name: "renamed.txt" });
      expect(renamed.entry.resourceId).toBeUndefined();
      await expect(service.entryById(carol, result.resourceId!)).rejects.toMatchObject({ status: 404 });
    }, 30_000);
  },
);
