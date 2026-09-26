import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { natsServers, testFor } from "../../../scripts/fixtures/test-infra";
import { installFirstPartyModules } from "../../cloud-cli/test/fixtures/first-party";
import { newShortId } from "./lib/short-id";

/** The spaces module as a package plugin in a private config home; cld loads it like any installed module. */
const cliHome = await mkdtemp(join(tmpdir(), "cld-spaces-cli-"));
await installFirstPartyModules(cliHome, ["spaces"]);
afterAll(() => rm(cliHome, { recursive: true, force: true }));

/**
 * The real `cld spaces` CLI against the real Spaces API: item addressing by
 * ID and `<space>:<title>`, ambiguity, permissions, and the shared verbs.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.SPACES_CLI_CHILD !== "1") {
  testFor("database", "nats")(
    "cld spaces addresses items by ID and <space>:<title>",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, SPACES_CLI_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    },
    240_000,
  );
} else {
  const cliEntry = new URL("../../cloud-cli/src/index.ts", import.meta.url).pathname;
  let serverUrl = "";
  let userId = "";
  let cleanup: () => Promise<void> = async () => undefined;

  const cld = async (args: string[]) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "--server", serverUrl, "--token", "cli-test", ...args],
      env: { ...process.env, XDG_CONFIG_HOME: cliHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const cldJson = async <T>(args: string[]): Promise<T> => {
    const result = await cld(["--json", "spaces", ...args]);
    if (result.exitCode !== 0) throw new Error(`cld spaces ${args.join(" ")} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
  };

  type Item = { id: string; spaceId: string; title: string; columnId: string; deadline: string | null; completedAt: string | null };

  beforeAll(async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens, toPgUuidArray } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("./migrate");
    const { default: app } = await import("./api");

    // Item changes publish live events, so the API needs a bound Sync.
    const connection = await connect({ servers: natsServers(), name: "spaces-cli-test" });
    const sync = createSync({ connection, namespace: `test-${crypto.randomUUID()}`, application: "spaces", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const user: User = {
      id: crypto.randomUUID(),
      uid: `cli-${crypto.randomUUID().slice(0, 8)}`,
      roles: [],
      provider: "local",
      profile: "user",
      givenname: "Cli",
      sn: "Agent",
      displayName: "Cli Agent",
      mail: "cli-agent@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    userId = user.id;
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    await sync.ready();
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user', 'Cli Agent')`;

    const http = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        // Core owns /api/me; the CLI only needs the caller's ID from it.
        if (url.pathname === "/api/me") return Response.json(user);
        if (!url.pathname.startsWith("/api/spaces")) return new Response("not found", { status: 404 });
        url.pathname = url.pathname.slice("/api/spaces".length) || "/";
        return app.fetch(new Request(url, request));
      },
    });
    serverUrl = `http://127.0.0.1:${http.port}`;

    cleanup = async () => {
      http.stop(true);
      const accessIds = await sql<{ access_id: string }[]>`
        SELECT sa.access_id FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id WHERE a.user_id = ${user.id}::uuid`;
      await sql`DELETE FROM spaces.spaces WHERE id IN (
        SELECT sa.space_id FROM spaces.space_access sa WHERE sa.access_id = ANY(${toPgUuidArray(accessIds.map((row) => row.access_id))}::uuid[]))`;
      await sql`DELETE FROM spaces.spaces WHERE name = 'Foreign space'`;
      await sql`DELETE FROM auth.access WHERE user_id = ${user.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await sync.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      await connection.drain();
    };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  }, 60_000);

  describe("cld spaces", () => {
    test("works on items by ID and <space>:<title> through the shared verbs", async () => {
      const name = `Roadmap ${crypto.randomUUID().slice(0, 6)}`;
      const space = await cldJson<{ id: string; name: string }>(["create", name]);
      expect(await cldJson<{ id: string }>(["show", `${name}:`])).toMatchObject({ id: space.id, name });

      const ship = await cldJson<Item & { assignees: { id: string }[] }>(["add", `${name}:Ship release`, "--assignee", "me"]);
      expect(ship.assignees.map((assignee) => assignee.id)).toEqual([userId]);
      const approve = await cldJson<Item>(["add", `${name}:Approve scope`, "--deadline", "2026-10-20"]);

      // Every address form reaches the same item.
      for (const address of [ship.id, `${name}:Ship release`, `${space.id}:Ship release`])
        expect(await cldJson<Item>(["show", address])).toMatchObject({ id: ship.id, title: "Ship release" });

      // Duplicate titles are never guessed; IDs always work.
      const first = await cldJson<Item>(["add", `${name}:Duplicate`]);
      const second = await cldJson<Item>(["add", `${name}:Duplicate`]);
      const ambiguous = await cld(["spaces", "due", `${name}:Duplicate`, "2026-11-01"]);
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr).toContain(
        `"Duplicate" matches several items: ${name}:Duplicate (${first.id}), ${name}:Duplicate (${second.id}). Use one of these paths or IDs.`,
      );
      const german = await cld(["--locale", "de", "spaces", "show", `${name}:Duplicate`]);
      expect(german.stderr).toContain("„Duplicate“ passt zu mehreren Einträgen");
      expect(await cldJson<Item>(["due", second.id, "2026-11-01"])).toMatchObject({ deadline: "2026-11-01T23:59:59.999Z" });
      expect((await cld(["spaces", "show", `${name}:Missing`])).stderr).toContain('exact title "Missing"');

      // Space names are resolved the same way.
      const twin = await cldJson<{ id: string }>(["create", name]);
      const twinAmbiguous = await cld(["spaces", "ls", name]);
      expect(twinAmbiguous.exitCode).toBe(1);
      expect(twinAmbiguous.stderr).toContain(`matches several spaces: `);
      expect(twinAmbiguous.stderr).toContain(`(${twin.id})`);
      expect(await cldJson<Item>(["show", `${space.id}:Ship release`])).toMatchObject({ id: ship.id });

      // Lists and filters.
      const mine = await cldJson<{ items: Item[] }>(["ls", space.id, "--mine"]);
      expect(mine.items.map((item) => item.id)).toEqual([ship.id]);
      const dueSoon = await cldJson<{ items: Item[] }>(["ls", space.id, "--due-before", "2026-10-21"]);
      expect(dueSoon.items.map((item) => item.id)).toEqual([approve.id]);

      // Quick actions and dependencies.
      await cldJson(["assign", ship.id, "none"]);
      expect((await cldJson<{ items: Item[] }>(["ls", space.id, "--mine"])).items).toEqual([]);
      const deps = await cldJson<{ blockers: { blocker: { id: string } }[] }>([
        "deps",
        `${space.id}:Ship release`,
        "--add",
        `${space.id}:Approve scope`,
      ]);
      expect(deps.blockers.map((entry) => entry.blocker.id)).toEqual([approve.id]);
      expect((await cld(["spaces", "done", ship.id])).exitCode).toBe(1);
      const blocked = await cldJson<{ blocks: { items: { dependent: { id: string } }[] } }>(["deps", approve.id]);
      expect(blocked.blocks.items.map((entry) => entry.dependent.id)).toEqual([ship.id]);
      await cldJson(["deps", ship.id, "--rm", approve.id]);
      expect(await cldJson<Item>(["done", ship.id, "--result", "Verified."])).toMatchObject({ completedAt: expect.any(String) });
      expect(await cldJson<Item>(["reopen", ship.id])).toMatchObject({ completedAt: null });

      const detail = await cldJson<{ columns: { id: string; name: string }[] }>(["show", `${space.id}:`]);
      const target = detail.columns[1]!;
      expect(await cldJson<Item>(["mv", ship.id, target.name])).toMatchObject({ columnId: target.id });
      await cldJson(["set", ship.id, "--title", "Ship it"]);
      expect(await cldJson<Item>(["show", `${space.id}:Ship it`])).toMatchObject({ id: ship.id });

      // External links: add, list, and remove through the real API and schema.
      const issue = "https://github.com/k2b-dev/cloud/issues/263";
      expect(await cldJson<{ url: string; label: string | null }>(["links", "add", ship.id, issue])).toMatchObject({
        url: issue,
        label: null,
      });
      await cldJson(["links", "add", ship.id, "https://example.org/spec", "--label", "Spec"]);
      expect((await cld(["spaces", "links", "add", ship.id, "ftp://example.org"])).exitCode).toBe(1);
      const listed = await cldJson<{ references: unknown[]; links: { url: string; label: string | null; preview: unknown }[] }>([
        "links",
        "ls",
        ship.id,
      ]);
      expect(listed.references).toEqual([]);
      expect(listed.links.map((entry) => [entry.url, entry.label])).toEqual([
        [issue, null],
        ["https://example.org/spec", "Spec"],
      ]);
      expect((await cldJson<{ links: unknown[] }>(["show", ship.id, "--context"])).links).toHaveLength(2);
      expect(await cldJson<{ deleted: boolean }>(["links", "rm", ship.id, issue, "--yes"])).toEqual({ deleted: true });
      expect((await cldJson<{ links: unknown[] }>(["links", "ls", ship.id])).links).toHaveLength(1);

      await cldJson(["comments", "add", ship.id, "--content", "Ready for review"]);
      const comments = await cldJson<{ items: { content: string }[] }>(["comments", "list", ship.id]);
      expect(comments.items.map((comment) => comment.content)).toEqual(["Ready for review"]);

      expect(await cldJson<unknown>(["rm", ship.id, "--yes"])).toEqual({ deleted: { id: ship.id, spaceId: space.id, title: "Ship it" } });
      expect((await cld(["spaces", "show", ship.id])).exitCode).toBe(1);
    }, 180_000);

    test("an item ID in a space without access resolves like a missing item", async () => {
      const [foreign] = await sql<{ id: string }[]>`
        INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Foreign space') RETURNING id`;
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${foreign!.id}::uuid, 'Open', 1024, false) RETURNING id`;
      const shortId = newShortId();
      await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${shortId}, ${foreign!.id}::uuid, ${column!.id}::uuid, 'Secret')`;
      const result = await cld(["spaces", "show", shortId]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("404");
      expect(result.stderr).not.toContain("Secret");
    }, 60_000);
  });
}
