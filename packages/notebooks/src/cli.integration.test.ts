import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { natsServers, testFor } from "../../../scripts/fixtures/test-infra";

/**
 * The real `cld notebooks` CLI against the real Notebooks API: path
 * addressing, the Markdown mirror, and the migration loop from the skill.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.NOTEBOOKS_CLI_CHILD !== "1") {
  testFor("database", "nats")(
    "cld notebooks addresses notes by path and mirrors notebooks",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_CLI_CHILD: "1" },
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
  let home = "";
  let serverUrl = "";
  let cleanup: () => Promise<void> = async () => undefined;

  const cld = async (args: string[], options: { cwd?: string; stdin?: string } = {}) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "--server", serverUrl, "--token", "cli-test", ...args],
      cwd: options.cwd ?? home,
      env: { ...process.env, HOME: home },
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const cldJson = async <T>(args: string[], options?: { cwd?: string; stdin?: string }): Promise<T> => {
    const result = await cld(["--json", ...args], options);
    if (result.exitCode !== 0) throw new Error(`cld ${args.join(" ")} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
  };
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  const manifestOf = async (dir: string) =>
    JSON.parse(await readFile(join(dir, ".cld-notebook.json"), "utf8")) as {
      notebook: { id: string };
      notes: Array<{ id: string; path: string; contentHash: string }>;
    };

  beforeAll(async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("./migrate");
    const { default: app } = await import("./api");

    const connection = await connect({ servers: natsServers() });
    const namespace = `notebooks-cli-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
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
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    await sync.ready();
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;

    const http = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/notebooks")) return new Response("not found", { status: 404 });
        url.pathname = url.pathname.slice("/api/notebooks".length) || "/";
        return app.fetch(new Request(url, request));
      },
    });
    serverUrl = `http://127.0.0.1:${http.port}`;
    home = await mkdtemp(join(tmpdir(), "cld-notebooks-"));

    cleanup = async () => {
      http.stop(true);
      await sql`DELETE FROM notebooks.notebooks WHERE created_by = ${user.id}::uuid`;
      await sql`DELETE FROM auth.access WHERE user_id = ${user.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await rm(home, { recursive: true, force: true });
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  }, 60_000);

  describe("cld notebooks", () => {
    test("migrates a Git docs folder into a notebook with the shell loop from the skill", async () => {
      const repo = join(home, "Git/kolb-antik-docs");
      const files: Record<string, string> = {
        "README.md": "# Kolb Antik IT\n\nStart here.\n",
        "docs/runbooks/create-rocky-vm.md": "# Create a Rocky Linux VM\n\nSteps.\n",
        "docs/runbooks/backup.md": "# Backup und Wiederherstellung\n\nNightly.\n",
        "docs/handbook/übersicht.md": "# Übersicht & Größe\n\nDe.\n",
        "docs/handbook/no-heading.md": "Plain text without heading.\n",
      };
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(repo, path, ".."), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      const bin = join(home, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "cld"),
        `#!/bin/sh\nexec "${process.execPath}" run "${cliEntry}" --server "${serverUrl}" --token cli-test "$@"\n`,
      );
      await chmod(join(bin, "cld"), 0o755);

      const script = `set -e
cld notebooks create "Kolb Antik Doku"
cld notebooks pull "Kolb Antik Doku" ~/docs-mirror
cd ~/Git/kolb-antik-docs
for f in $(find . -name '*.md'); do cld notebooks write ~/docs-mirror/\${f#./} --from "$f" --parents; done
`;
      const loop = Bun.spawn(["bash", "-c", script], {
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([loop.exited, new Response(loop.stdout).text(), new Response(loop.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("Created docs/runbooks/create-a-rocky-linux-vm.md");

      const mirror = join(home, "docs-mirror");
      const manifest = await manifestOf(mirror);
      expect(manifest.notes.map((note) => note.path)).toEqual([
        "docs/handbook/index.md",
        "docs/handbook/no-heading.md",
        "docs/handbook/uebersicht-groesse.md",
        "docs/index.md",
        "docs/runbooks/backup-und-wiederherstellung.md",
        "docs/runbooks/create-a-rocky-linux-vm.md",
        "docs/runbooks/index.md",
        "kolb-antik-it.md",
      ]);
      const backup = await readFile(join(mirror, "docs/runbooks/backup-und-wiederherstellung.md"), "utf8");
      expect(backup).toMatch(
        /^---\nid: [A-Za-z0-9]{6}\ntitle: "Backup und Wiederherstellung"\nupdatedAt: .+\n---\n# Backup und Wiederherstellung\n\nNightly\.\n$/,
      );
      expect(await readFile(join(mirror, "docs/handbook/no-heading.md"), "utf8")).toContain(
        "# no-heading\n\nPlain text without heading.\n",
      );

      // A second pull has nothing to do.
      const again = await cldJson<{ written: string[]; removed: string[] }>(["notebooks", "pull", mirror]);
      expect({ written: again.written, removed: again.removed }).toEqual({ written: [], removed: [] });

      // Re-running the loop never duplicates: the H1 title already exists at that path.
      const rerun = await cld([
        "notebooks",
        "write",
        join(mirror, "docs/runbooks/backup.md"),
        "--from",
        join(repo, "docs/runbooks/backup.md"),
      ]);
      expect(rerun.exitCode).toBe(1);
      expect(rerun.stderr).toContain('A note titled "Backup und Wiederherstellung" already exists here');
    }, 120_000);

    test("addresses notes by ID, notebook path, and mirror file", async () => {
      const mirror = join(home, "docs-mirror");
      const byPath = await cldJson<{ note: { id: string; title: string }; content: string; contentHash: string }>([
        "notebooks",
        "cat",
        "Kolb Antik Doku:docs/handbook/Übersicht & Größe",
      ]);
      expect(byPath.note.title).toBe("Übersicht & Größe");
      const bySlug = await cldJson<typeof byPath>(["notebooks", "cat", "Kolb Antik Doku:docs/handbook/uebersicht-groesse"]);
      const byId = await cldJson<typeof byPath>(["notebooks", "cat", byPath.note.id]);
      const byFile = await cldJson<typeof byPath>(["notebooks", "cat", "docs/handbook/uebersicht-groesse.md"], { cwd: mirror });
      expect([bySlug.note.id, byId.note.id, byFile.note.id]).toEqual([byPath.note.id, byPath.note.id, byPath.note.id]);
      expect(byId.contentHash).toBe(byPath.contentHash);

      const tree = await cld(["notebooks", "tree", "Kolb Antik Doku:docs"]);
      expect(tree.stdout).toContain("- handbook (");
      expect(tree.stdout).toContain("  - Übersicht & Größe (");
      const ls = await cldJson<{ data: Array<{ title: string; hasChildren: boolean }> }>(["notebooks", "ls", join(mirror, "docs")]);
      expect(ls.data.map((entry) => [entry.title, entry.hasChildren])).toEqual([
        ["handbook", true],
        ["runbooks", true],
      ]);

      const missing = await cld(["notebooks", "cat", "Kolb Antik Doku:docs/nope"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain('No note matches "nope" in "docs"');
    }, 60_000);

    test("mirrors duplicate titles with ID suffixes and refuses ambiguous paths", async () => {
      const mirror = join(home, "docs-mirror");
      const manifest = await manifestOf(mirror);
      const handbook = manifest.notes.find((note) => note.path === "docs/handbook/index.md")!;
      // Duplicate titles are allowed in Cloud (for example from the web editor).
      const created: string[] = [];
      for (const body of ["# Checkliste\n\nA\n", "# checkliste\n\nB\n"]) {
        const response = await fetch(`${serverUrl}/api/notebooks/${manifest.notebook.id}/notes`, {
          method: "POST",
          headers: { authorization: "Bearer cli-test", "content-type": "application/json" },
          body: JSON.stringify({ parentId: handbook.id, contentMd: body }),
        });
        created.push(((await response.json()) as { id: string }).id);
      }
      const pulled = await cld(["notebooks", "pull", mirror]);
      expect(pulled.exitCode).toBe(0);
      const paths = (await manifestOf(mirror)).notes.map((note) => note.path);
      for (const id of created) expect(paths).toContain(`docs/handbook/checkliste--${id}.md`);

      const ambiguous = await cld(["notebooks", "cat", "Kolb Antik Doku:docs/handbook/checkliste"]);
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr).toContain('"checkliste" matches several notes');
      for (const id of created) expect(ambiguous.stderr).toContain(`docs/handbook/checkliste (${id})`);
      const suffix = await cld(["notebooks", "cat", `Kolb Antik Doku:docs/handbook/checkliste--${created[0]}`]);
      expect(suffix.exitCode).toBe(1);
      const writeAmbiguous = await cld(["notebooks", "write", "Kolb Antik Doku:docs/handbook/checkliste", "--content", "# Checkliste\n"]);
      expect(writeAmbiguous.exitCode).toBe(1);
      expect(writeAmbiguous.stderr).toContain("matches several notes");

      // The mirror file names the exact note.
      const file = join(mirror, `docs/handbook/checkliste--${created[1]}.md`);
      await writeFile(file, `${await readFile(file, "utf8")}\nmehr\n`);
      const written = await cldJson<{ action: string; note: { id: string } }>(["notebooks", "write", file]);
      expect(written).toMatchObject({ action: "updated", note: { id: created[1] } });
      expect((await cldJson<{ content: string }>(["notebooks", "cat", created[1]!])).content).toBe("# checkliste\n\nB\n\nmehr\n");
    }, 60_000);

    test("pull follows renames, moves, and deletions and protects local edits", async () => {
      const mirror = join(home, "docs-mirror");
      const noteId = (path: string) => manifestOf(mirror).then((manifest) => manifest.notes.find((note) => note.path === path)!.id);
      const vm = await noteId("docs/runbooks/create-a-rocky-linux-vm.md");
      const backup = await noteId("docs/runbooks/backup-und-wiederherstellung.md");
      const plain = await noteId("docs/handbook/no-heading.md");

      await cldJson(["notebooks", "write", vm, "--content", "# Rocky VM anlegen\n\nSteps.\n"]);
      await cldJson(["notebooks", "mv", backup, "Kolb Antik Doku:docs/handbook"]);
      await cldJson(["notebooks", "rm", plain, "--yes"]);
      const report = await cldJson<{ written: string[]; removed: string[] }>(["notebooks", "pull", mirror]);
      expect(report.written.sort()).toEqual(["docs/handbook/backup-und-wiederherstellung.md", "docs/runbooks/rocky-vm-anlegen.md"]);
      expect(report.removed.sort()).toEqual([
        "docs/handbook/no-heading.md",
        "docs/runbooks/backup-und-wiederherstellung.md",
        "docs/runbooks/create-a-rocky-linux-vm.md",
      ]);
      expect(await exists(join(mirror, "docs/runbooks/create-a-rocky-linux-vm.md"))).toBe(false);

      // Local edit plus a server change: pull keeps the file, lists it, and exits 1.
      const local = join(mirror, "docs/runbooks/rocky-vm-anlegen.md");
      const edited = `${await readFile(local, "utf8")}local line\n`;
      await writeFile(local, edited);
      await cldJson(["notebooks", "edit", vm, "--append", "--content", "server line\n"]);
      const blocked = await cld(["notebooks", "pull", mirror]);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("Kept docs/runbooks/rocky-vm-anlegen.md: changed locally and on the server");
      expect(await readFile(local, "utf8")).toBe(edited);

      // Writing the stale local file back is a conflict, not a silent overwrite.
      const conflict = await cld(["notebooks", "write", local]);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr).toContain("changed elsewhere");

      const forced = await cld(["notebooks", "pull", mirror, "--force"]);
      expect(forced.exitCode).toBe(0);
      expect(await readFile(local, "utf8")).toContain("server line\n");
      expect(await readFile(local, "utf8")).not.toContain("local line");
    }, 90_000);

    test("write, edit, mv, and rm through mirror paths update the files and manifest", async () => {
      const mirror = join(home, "docs-mirror");
      const file = join(mirror, "docs/runbooks/rocky-vm-anlegen.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("Steps.", "Steps, updated."));
      const written = await cldJson<{ action: string; mirrorPath: string; contentHash: string }>(["notebooks", "write", file]);
      expect(written).toMatchObject({ action: "updated", mirrorPath: "docs/runbooks/rocky-vm-anlegen.md" });
      const entry = (await manifestOf(mirror)).notes.find((note) => note.path === written.mirrorPath)!;
      expect(entry.contentHash).toBe(written.contentHash);

      // Editing the H1 renames the file.
      await cldJson(["notebooks", "edit", file, "--replace-lines", "1:1", "--content", "# Rocky Linux VM"]);
      expect(await exists(file)).toBe(false);
      const renamed = join(mirror, "docs/runbooks/rocky-linux-vm.md");
      expect(await readFile(renamed, "utf8")).toContain("# Rocky Linux VM\n");

      // mv to a new file name renames and moves; the folder of a leaf note appears on demand.
      const moved = await cldJson<{ mirrorPath: string }>(["notebooks", "mv", renamed, join(mirror, "docs/handbook/VM Setup.md")]);
      expect(moved.mirrorPath).toBe("docs/handbook/vm-setup.md");
      expect(await exists(renamed)).toBe(false);

      // A new file below a leaf note turns the leaf into a folder with index.md.
      const created = await cldJson<{ action: string; mirrorPath: string }>([
        "notebooks",
        "write",
        join(mirror, "docs/handbook/vm-setup/netzwerk.md"),
        "--content",
        "# Netzwerk\n",
      ]);
      expect(created).toMatchObject({ action: "created", mirrorPath: "docs/handbook/vm-setup/netzwerk.md" });
      expect(await exists(join(mirror, "docs/handbook/vm-setup/index.md"))).toBe(true);
      expect(await exists(join(mirror, "docs/handbook/vm-setup.md"))).toBe(false);

      const removed = await cld(["notebooks", "rm", join(mirror, "docs/handbook/vm-setup"), "--yes"]);
      expect(removed.exitCode).toBe(0);
      expect(await exists(join(mirror, "docs/handbook/vm-setup"))).toBe(false);
      expect((await manifestOf(mirror)).notes.some((note) => note.path.startsWith("docs/handbook/vm-setup"))).toBe(false);

      const missingParent = await cld(["notebooks", "write", join(mirror, "neu/ordner/datei.md"), "--content", "# Datei\n"]);
      expect(missingParent.exitCode).toBe(1);
      expect(missingParent.stderr).toContain("--parents");
    }, 90_000);

    test("attachments become relative files in the mirror and round-trip on write", async () => {
      const mirror = join(home, "docs-mirror");
      const image = join(home, "diagram.png");
      await writeFile(image, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      const attached = await cldJson<{ attachment: { id: string }; markdown: string }>(["notebooks", "attach", "Kolb Antik Doku:", image]);
      expect(attached.markdown).toBe(`![diagram.png](attach://${attached.attachment.id})`);

      const file = join(mirror, "docs/handbook/uebersicht-groesse.md");
      await cldJson(["notebooks", "edit", file, "--append", "--content", `\n${attached.markdown}\n`]);
      const local = await readFile(file, "utf8");
      expect(local).toContain(`](../../_attachments/${attached.attachment.id}-diagram.png)`);
      expect(await exists(join(mirror, `_attachments/${attached.attachment.id}-diagram.png`))).toBe(true);

      await writeFile(file, local.replace("De.", "Deutsch."));
      await cldJson(["notebooks", "write", file]);
      const server = await cldJson<{ content: string }>(["notebooks", "cat", "Kolb Antik Doku:docs/handbook/uebersicht-groesse"]);
      expect(server.content).toContain(`(attach://${attached.attachment.id})`);
      expect(server.content).toContain("Deutsch.");
    }, 60_000);

    test("pull into an empty folder for an empty notebook creates just the manifest", async () => {
      await cldJson(["notebooks", "create", "Leer"]);
      const dir = join(home, "leer");
      const result = await cldJson<{ notes: number }>(["notebooks", "pull", "Leer", dir]);
      expect(result.notes).toBe(0);
      expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, dot: true }))).toEqual([".cld-notebook.json"]);
      const occupied = await cld(["notebooks", "pull", "Leer", join(home, "Git")]);
      expect(occupied.exitCode).toBe(1);
      expect(occupied.stderr).toContain("is not empty");
    }, 60_000);
  });
}
