import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags } from "@k2b/cloud/cli";
import { installFirstPartyModules } from "../../cloud-cli/test/fixtures/first-party";
import notebooksCli from "./cli";
import { renderMirrorFile, writeManifest } from "./cli-mirror";
import { noteContentHash } from "./lib/note-edit";

/** The notebooks module as a package plugin in a private config home; cld loads it like any installed module. */
const cliHome = await mkdtemp(join(tmpdir(), "cld-notebooks-cli-"));
await installFirstPartyModules(cliHome, ["notebooks"]);
afterAll(() => rm(cliHome, { recursive: true, force: true }));

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const runCli = async (server: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "../cloud-cli/src/index.ts", "--server", server, "--token", "test-token", ...args],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_CONFIG_HOME: cliHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

const notebookFixture = {
  id: "wiki01",
  name: "Wiki",
  description: null,
  icon: null,
  homepageNoteId: null,
  defaultPresentationMode: "write",
  defaultNoteTitleTemplate: "New Document",
  noteDeletePermission: "write",
  createdBy: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const noteFixture = {
  id: "note01",
  notebookId: "wiki01",
  parentId: null,
  title: "Handbook",
  position: 0,
  hasChildren: false,
  historyIncomplete: false,
  yjsSnapshotAt: null,
  yjsSnapshot: null,
  contentMd: "# Handbook\n\n:::toc\n:::\n",
  createdBy: null,
  createdAt: notebookFixture.createdAt,
  updatedAt: notebookFixture.updatedAt,
  lockedAt: null,
};

const editingServer = (note: typeof noteFixture = noteFixture) => {
  const writes: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") {
        const body = await request.json();
        writes.push(body);
        return Response.json({ ...notebookFixture, ...body });
      }
      if (path === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      return Response.json(note);
    },
  });
  servers.push(server);
  return { server: `http://127.0.0.1:${server.port}`, writes };
};

test("updates only valid default presentation modes", async () => {
  const { server, writes } = editingServer();
  for (const mode of ["book", "write", "readonly"]) {
    const result = await runCli(server, ["notebooks", "update", "wiki01", "--default-presentation-mode", mode]);
    expect(result.exitCode).toBe(0);
  }
  const invalid = await runCli(server, ["notebooks", "update", "wiki01", "--default-presentation-mode", "edit"]);
  expect(invalid.exitCode).toBe(1);
  expect(writes).toEqual([
    { defaultPresentationMode: "book" },
    { defaultPresentationMode: "write" },
    { defaultPresentationMode: "readonly" },
  ]);
});

test("updates only valid note delete permissions", async () => {
  const { server, writes } = editingServer();
  for (const permission of ["admin", "write"]) {
    const result = await runCli(server, ["notebooks", "update", "wiki01", "--note-delete-permission", permission]);
    expect(result.exitCode).toBe(0);
  }
  const invalid = await runCli(server, ["notebooks", "update", "wiki01", "--note-delete-permission", "read"]);
  expect(invalid.exitCode).toBe(1);
  expect(writes).toEqual([{ noteDeletePermission: "admin" }, { noteDeletePermission: "write" }]);
});

test("rm reports a notebook that reserves deleting notes for admins", async () => {
  const message = "Deleting notes is reserved for admins in this notebook.";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method === "DELETE") return Response.json({ message, code: "NOTE_DELETE_ADMIN_ONLY" }, { status: 403 });
      return Response.json(new URL(request.url).pathname === "/api/notebooks/wiki01" ? notebookFixture : noteFixture);
    },
  });
  servers.push(server);
  const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", "rm", "note01", "--yes"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(message);
});

test("lock reports a notebook that reserves locking notes for admins", async () => {
  const message = "Locking notes is reserved for admins in this notebook.";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/lock"))
        return Response.json({ message, code: "NOTE_LOCK_ADMIN_ONLY" }, { status: 403 });
      return Response.json(new URL(request.url).pathname === "/api/notebooks/wiki01" ? notebookFixture : noteFixture);
    },
  });
  servers.push(server);
  const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", "lock", "note01", "--yes"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(message);
});

test("rejects ambiguous edit operations before a write", async () => {
  const { server, writes } = editingServer();
  const result = await runCli(server, [
    "notebooks",
    "edit",
    "note01",
    "--append",
    "--prepend",
    "--content",
    ":::query\nsource: notes\n:::",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("exactly one edit operation");
  expect(writes).toEqual([]);
});

test("rejects malformed edit line selectors instead of truncating them", async () => {
  const { server, writes } = editingServer();
  for (const [flag, value] of [
    ["--replace-lines", "1:2:3"],
    ["--replace-lines", "1:2oops"],
    ["--insert-before-line", "2.5"],
  ]) {
    const result = await runCli(server, ["notebooks", "edit", "note01", flag!, value!, "--content", ":::toc\n:::"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid");
  }
  expect(writes).toEqual([]);
});

/** A mirror with `note` pulled as `handbook.md`, whose 5 front matter lines put note line 1 at file line 6. */
const pulledMirror = async (server: string, note: typeof noteFixture = noteFixture) => {
  const root = await mkdtemp(join(tmpdir(), "cld-notebooks-mirror-"));
  const file = join(root, "handbook.md");
  const text = renderMirrorFile(note, note.contentMd, "handbook.md", new Map(), new Map());
  await writeFile(file, text);
  await writeManifest(root, {
    version: 1,
    server,
    notebook: { id: notebookFixture.id, name: notebookFixture.name },
    notes: [
      {
        id: note.id,
        path: "handbook.md",
        contentHash: noteContentHash(note.contentMd),
        fileHash: noteContentHash(text),
        updatedAt: note.updatedAt,
      },
    ],
  });
  return { root, file, text };
};

test("line edits through a mirror file use the line numbers of the file", async () => {
  const { server, writes } = editingServer();
  const { root, file, text } = await pulledMirror(server);
  try {
    const edit = (...args: string[]) => runCli(server, ["--json", "notebooks", "edit", file, ...args, "--dry-run"]);
    const edited = async (...args: string[]) => {
      const result = await edit(...args);
      expect(result.stderr).toBe("");
      return (JSON.parse(result.stdout) as { content: string }).content;
    };
    // File lines 8:9 are the `:::toc` block, note lines 3:4.
    expect(await edited("--replace-lines", "8:9", "--content", "Body")).toBe("# Handbook\n\nBody");
    expect(await edited("--delete-lines", "6:7")).toBe(":::toc\n:::\n");
    expect(await edited("--insert-before-line", "8", "--content", "Intro")).toBe("# Handbook\n\nIntro\n:::toc\n:::\n");
    expect(await edited("--insert-after-line", "5", "--content", "Top")).toBe("Top\n# Handbook\n\n:::toc\n:::\n");

    const frontMatter = await edit("--replace-lines", "5:6", "--content", "# Other");
    expect(frontMatter.exitCode).toBe(1);
    expect(frontMatter.stderr).toContain("Lines 1-5 of handbook.md are its front matter");
    expect(frontMatter.stderr).toContain("starts at line 6");

    // The file has 10 lines; a range past them is reported in file lines, not in the note lines it maps to.
    expect(await edited("--insert-after-line", "10", "--content", "End")).toBe("# Handbook\n\n:::toc\n:::\nEnd");
    for (const args of [
      ["--replace-lines", "9:11", "--content", "Body"],
      ["--insert-before-line", "11", "--content", "Body"],
    ]) {
      const outside = await edit(...args);
      expect(outside.exitCode).toBe(1);
      expect(outside.stderr).toContain("Line 11 is outside handbook.md, which has 10 lines.");
    }

    const otherHash = await edit("--replace-lines", "8:9", "--content", "Body", "--if-content-hash", noteContentHash("other"));
    expect(otherHash.exitCode).toBe(1);
    expect(otherHash.stderr).toContain("cld notebooks cat note01 --numbered");

    await writeFile(file, `${text}local line\n`);
    const modified = await edit("--replace-lines", "8:9", "--content", "Body");
    expect(modified.exitCode).toBe(1);
    expect(modified.stderr).toContain("handbook.md has local changes");
    expect(modified.stderr).toContain("cld notebooks cat note01 --numbered");

    await rm(file);
    const missing = await edit("--replace-lines", "8:9", "--content", "Body");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("handbook.md is missing");
    expect(writes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cat through a mirror file numbers lines as edit takes them for that file", async () => {
  const note = { ...noteFixture, contentMd: "# Handbook\n\n@tasks\n- [ ] Restore testen\n- [ ] Backup prüfen\n\nEnde\n" };
  const { server } = editingServer(note);
  const { root, file, text } = await pulledMirror(server, note);
  try {
    const cat = async (...args: string[]) => {
      const result = await runCli(server, ["notebooks", "cat", ...args]);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const edited = async (...args: string[]) => {
      const result = await runCli(server, ["--json", "notebooks", "edit", file, ...args, "--dry-run"]);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout) as { content: string };
    };

    // The number --numbered shows for a line is its line in the file, and edit changes exactly that line.
    const shown = (await cat(file, "--numbered")).split("\n").find((line) => line.endsWith("| - [ ] Backup prüfen"))!;
    const line = Number.parseInt(shown, 10);
    expect(line).toBe(text.split("\n").indexOf("- [ ] Backup prüfen") + 1);
    expect((await edited("--replace-lines", `${line}:${line}`, "--content=- [x] Backup prüfen")).content).toBe(
      note.contentMd.replace("- [ ] Backup prüfen", "- [x] Backup prüfen"),
    );

    // Block lines from --blocks, --json, and --block --json are file lines too.
    const range = (await cat(file, "--blocks")).trim().split(" ")[2]!;
    expect(range).toBe("9:10");
    expect(JSON.parse(await cat(file, "--json"))).toMatchObject({
      firstLine: 6,
      lineCount: 8,
      blocks: [{ name: "tasks", line: 8, startLine: 9, endLine: 10 }],
    });
    expect(JSON.parse(await cat(file, "--block", "tasks", "--json")).block).toMatchObject({ startLine: 9, endLine: 10 });
    // The edit result counts the same way, ready for the next edit through the file.
    expect(await edited("--replace-lines", range, "--content=- [x] Alles erledigt")).toMatchObject({
      content: "# Handbook\n\n@tasks\n- [x] Alles erledigt\n\nEnde\n",
      firstLine: 6,
      blocks: [{ name: "tasks", startLine: 9, endLine: 9 }],
    });

    // A note ID keeps note lines.
    expect(await cat("note01", "--numbered")).toStartWith("   1 | # Handbook\n");
    expect(JSON.parse(await cat("note01", "--json"))).toMatchObject({ firstLine: 1, blocks: [{ startLine: 4, endLine: 5 }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("line edits through a mirror file fail when the note changed after the pull", async () => {
  const live = { ...noteFixture, contentMd: "# Handbook\n\nAdded on the server.\n\n:::toc\n:::\n" };
  const { server, writes } = editingServer(live);
  const { root, file, text } = await pulledMirror(server);
  try {
    // File lines 8:9 still name the pulled `:::toc` block, but the server copy moved it: the pulled hash refuses the edit.
    const stale = await runCli(server, ["notebooks", "edit", file, "--replace-lines", "8:9", "--content", "Body", "--dry-run"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("changed elsewhere");
    expect(writes).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(text);
    // cat numbers the live content as the pull that the error asks for will write it.
    expect((await runCli(server, ["notebooks", "cat", file, "--numbered"])).stdout).toContain("   8 | Added on the server.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("line edits through a note ID use the note lines", async () => {
  const { server } = editingServer();
  const result = await runCli(server, [
    "--json",
    "notebooks",
    "edit",
    "note01",
    "--replace-lines",
    "3:4",
    "--content",
    "Body",
    "--dry-run",
  ]);
  expect(result.stderr).toBe("");
  expect((JSON.parse(result.stdout) as { content: string }).content).toBe("# Handbook\n\nBody");
});

test("dry-run honors the same updatedAt precondition as saved edits", async () => {
  const { server, writes } = editingServer();
  const args = [
    "--json",
    "notebooks",
    "edit",
    "note01",
    "--append",
    "--content",
    ":::query\nsource: notes\n:::\n",
    "--dry-run",
    "--if-updated-at",
  ];
  const stale = await runCli(server, [...args, "2020-01-01T00:00:00.000Z"]);
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("changed elsewhere");
  const current = await runCli(server, [...args, noteFixture.updatedAt]);
  expect(current.exitCode).toBe(0);
  expect(JSON.parse(current.stdout).content).toContain(":::toc\n:::");
  expect(JSON.parse(current.stdout).content).toContain(":::query\nsource: notes");
  expect(writes).toEqual([]);
});

test("preview uses saved content by default and preserves empty or populated drafts", async () => {
  const bodies: unknown[] = [];
  const preview = {
    markdown: noteFixture.contentMd,
    blocks: [{ line: 3, html: "<nav>Contents</nav>" }],
    headings: [{ id: "heading-handbook", line: 1 }],
    diagnostics: [],
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      if (request.method === "GET" && path === "/api/notebooks/notes/note01") return Response.json(noteFixture);
      if (request.method === "POST" && path === "/api/notebooks/wiki01/notes/note01/block-preview") {
        bodies.push(await request.json());
        return Response.json(preview);
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  servers.push(server);
  for (const input of [[], ["--content", ""], ["--content", ":::query\nsource: notes\n:::\n"]]) {
    const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "notebooks", "preview", "note01", ...input]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(preview);
  }
  expect(bodies).toEqual([{}, { markdown: "" }, { markdown: ":::query\nsource: notes\n:::\n" }]);
});

test("preview rejects competing draft sources before contacting the server", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.url);
      return Response.json({});
    },
  });
  servers.push(server);
  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "notebooks",
    "preview",
    "note01",
    "--content",
    ":::toc\n:::",
    "--from",
    "draft.md",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("only one of --from or --content");
  expect(requests).toEqual([]);
});

test("preview retains machine-readable diagnostics while returning a failure exit code", async () => {
  const preview = {
    markdown: ":::query\nsource: invalid\n:::",
    blocks: [],
    headings: [],
    diagnostics: [{ line: 1, message: "Invalid source" }],
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method === "POST") return Response.json(preview);
      return Response.json(new URL(request.url).pathname === "/api/notebooks/wiki01" ? notebookFixture : noteFixture);
    },
  });
  servers.push(server);
  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "notebooks", "preview", "note01"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual(preview);
});

test("global search forwards full-text and structured filters", async () => {
  const requestUrls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requestUrls.push(request.url);
      return Response.json({
        data: [
          {
            note: {
              id: "abc123",
              notebookId: "nb1234",
              parentId: null,
              title: "Search architecture",
              position: 0,
              hasChildren: false,
              historyIncomplete: false,
              yjsSnapshotAt: null,
              contentMd: "Native PostgreSQL search",
              createdBy: null,
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-10T00:00:00.000Z",
              lockedAt: null,
            },
            notebook: {
              id: "nb1234",
              name: "Wiki",
              icon: null,
            },
            snippet: "Native \uE000PostgreSQL\uE001 search",
          },
        ],
        pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_next: false },
      });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "notebooks",
    "search",
    "postgres search",
    "--tags",
    "architecture,database",
    "--updated-after",
    "2026-07-01T00:00:00.000Z",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const requestUrl = new URL(requestUrls[0]!);
  expect(requestUrl.pathname).toBe("/api/notebooks/search");
  expect(requestUrl.searchParams.get("q")).toBe("postgres search");
  expect(requestUrl.searchParams.get("tags")).toBe("architecture,database");
  expect(requestUrl.searchParams.get("updated_after")).toBe("2026-07-01T00:00:00.000Z");
  expect(result.stdout).toContain('"id": "abc123"');
  expect(result.stdout).toContain('"id": "nb1234"');
  expect(result.stdout).not.toContain("shortId");
});

test("destructive commands require confirmation before any request", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.url);
      return Response.json({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  for (const args of [
    ["delete", "wiki01"],
    ["rm", "note01"],
    ["lock", "note01"],
    ["comments", "delete", "note01", "cmt001"],
    ["attachments", "delete", "wiki01", "att001"],
    ["api-keys", "revoke", "wiki01", "key001"],
  ]) {
    const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pass --yes");
  }
  expect(requests).toEqual([]);
});

test("resolves exact names through search without sending them as resource ids", async () => {
  const requestUrls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requestUrls.push(request.url);
      return Response.json({
        data: [notebookFixture],
        pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_next: false },
      });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "notebooks", "stat", "Wiki:"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestUrls).toHaveLength(1);
  const requestUrl = new URL(requestUrls[0]!);
  expect(requestUrl.pathname).toBe("/api/notebooks");
  expect(requestUrl.searchParams.get("q")).toBe("Wiki");
  expect(result.stdout).toContain('"id": "wiki01"');
  expect(result.stdout).not.toContain("shortId");
});

test("does not send legacy UUID notebook refs to the resource reader", async () => {
  const legacyUuid = "11111111-1111-4111-8111-111111111111";
  const requestUrls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requestUrls.push(request.url);
      return Response.json({
        data: [],
        pagination: { page: 1, per_page: 20, total: 0, total_pages: 0, has_next: false },
      });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", "stat", `${legacyUuid}:`]);

  expect(result.exitCode).toBe(1);
  expect(requestUrls).toHaveLength(1);
  const requestUrl = new URL(requestUrls[0]!);
  expect(requestUrl.pathname).toBe("/api/notebooks");
  expect(requestUrl.searchParams.get("q")).toBe(legacyUuid);
  expect(requestUrl.pathname).not.toContain(legacyUuid);
});

test("write creates a missing path note with its Markdown title", async () => {
  const createBodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01/resolve")
        return Response.json({ message: "No note" }, { status: 404 });
      if (request.method === "POST" && url.pathname === "/api/notebooks/wiki01/notes") {
        createBodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          id: "note01",
          notebookId: "wiki01",
          parentId: null,
          title: "Incident review",
          position: 0,
          hasChildren: false,
          historyIncomplete: false,
          yjsSnapshotAt: null,
          contentMd: "# Incident review\n",
          createdBy: null,
          createdAt: notebookFixture.createdAt,
          updatedAt: notebookFixture.updatedAt,
          lockedAt: null,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "notebooks",
    "write",
    "wiki01:reviews/incident",
    "--content",
    "# Incident review\n",
    "--parents",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(createBodies).toEqual([{ parentPath: "reviews", createParents: true, contentMd: "# Incident review\n" }]);
});

test("update forwards the default note title template", async () => {
  const updateBodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      if (request.method === "PATCH" && url.pathname === "/api/notebooks/wiki01") {
        const body = (await request.json()) as Record<string, unknown>;
        updateBodies.push(body);
        return Response.json({ ...notebookFixture, ...body });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "notebooks",
    "update",
    "wiki01",
    "--default-note-title-template",
    "{{ date }} Journal",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(updateBodies).toEqual([{ defaultNoteTitleTemplate: "{{ date }} Journal" }]);
});

test("adds a comment through resolved public notebook and note ids", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const note = {
    id: "note01",
    notebookId: "wiki01",
    parentId: null,
    title: "Handbook",
    position: 0,
    hasChildren: false,
    historyIncomplete: false,
    yjsSnapshotAt: null,
    contentMd: "# Handbook",
    createdBy: null,
    createdAt: notebookFixture.createdAt,
    updatedAt: notebookFixture.updatedAt,
    lockedAt: null,
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      if (request.method === "GET" && url.pathname === "/api/notebooks/notes/note01") return Response.json(note);
      if (request.method === "POST" && url.pathname === "/api/notebooks/wiki01/notes/note01/comments") {
        const body = await request.json();
        requests.push({ method: request.method, path: url.pathname, body });
        return Response.json({
          id: "cmt001",
          notebookId: "wiki01",
          noteId: "note01",
          authorUserId: "user01",
          authorDisplayName: "Notebook User",
          authorAvatarHash: null,
          content: "Please clarify the escalation path.",
          createdAt: notebookFixture.updatedAt,
          updatedAt: notebookFixture.updatedAt,
          canEdit: true,
          canDelete: true,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "notebooks",
    "comments",
    "add",
    "note01",
    "--content",
    "Please clarify the escalation path.",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/notebooks/wiki01/notes/note01/comments",
      body: { content: "Please clarify the escalation path." },
    },
  ]);
  expect(result.stdout).toContain('"id": "cmt001"');
});

test("write reads stdin from --from - and adds the current title when the content has no heading", async () => {
  const patches: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/notebooks/notes/note01") return Response.json(noteFixture);
      if (request.method === "PATCH" && path === "/api/notebooks/wiki01/notes/note01/content") {
        const body = (await request.json()) as { operations: Array<{ content: string }> };
        patches.push(body);
        const content = body.operations[0]!.content;
        return Response.json({ note: noteFixture, content, changed: true, beforeHash: "a", afterHash: "b", blocks: [] });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  servers.push(server);
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "../cloud-cli/src/index.ts",
      "--server",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "test-token",
      "notebooks",
      "write",
      "note01",
      "--from",
      "-",
      "--if-content-hash",
      "sha256:abc",
    ],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_CONFIG_HOME: cliHome },
    stdin: new Blob(["Just a line\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(patches).toEqual([{ operations: [{ kind: "set-content", content: "# Handbook\n\nJust a line\n" }], ifContentHash: "sha256:abc" }]);
});

test("a hash conflict explains that the note changed elsewhere", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/notebooks/notes/note01") return Response.json(noteFixture);
      return Response.json({ message: "Content hash mismatch" }, { status: 409 });
    },
  });
  servers.push(server);
  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "notebooks",
    "write",
    "note01",
    "--content",
    "# X\n",
    "--if-content-hash",
    "sha256:old",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("changed elsewhere");
  expect(result.stderr).toContain("pull");
});

test("help lists the new command set in English and German", async () => {
  const english = await runCli("http://127.0.0.1:9", ["notebooks", "help"]);
  for (const name of ["ls", "tree", "cat", "write", "edit", "mv", "rm", "pull", "attach", "versions", "comments"])
    expect(english.stdout).toContain(name);
  expect(english.stdout).not.toContain("create-note");
  const german = await runCli("http://127.0.0.1:9", ["--locale", "de", "notebooks", "help"]);
  expect(german.stdout).toContain("Notizbuch");
});

const commandContext = (args: string[], flags: CloudCliFlags = {}, locale = "en") => {
  const lines: string[] = [];
  const writes: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://example.test", token: "token", output: "json", locale },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("Not used by these commands");
    },
    fetch: async (path, init) => {
      if (init?.method && init.method !== "GET") {
        if (typeof init.body !== "string") throw new Error("Expected JSON body");
        const body: unknown = JSON.parse(init.body);
        writes.push(body);
        return Response.json(noteFixture);
      }
      if (path === "/api/notebooks/wiki01") return Response.json(notebookFixture);
      if (path.endsWith("/anchor")) return Response.json({ ...noteFixture, id: "anchor", title: "Setup" });
      if (path.endsWith("/other1")) return Response.json({ ...noteFixture, id: "other1", notebookId: "other2" });
      if (path.includes("/resolve?")) return Response.json({ ...noteFixture, id: "anchor", title: "Setup" });
      return Response.json({ ...noteFixture, position: 7 });
    },
    readJson: async (response) => response.json(),
    print: (value = "") => {
      lines.push(value);
    },
    write: async (value) => {
      lines.push(value);
    },
    error: (value) => {
      lines.push(value);
    },
    json: (value) => {
      lines.push(JSON.stringify(value));
    },
    jsonLine: (value) => {
      lines.push(JSON.stringify(value));
    },
    table: () => undefined,
  };
  return { ctx, lines, writes };
};

test("mv sends only the requested placement and omits parent without a target", async () => {
  for (const [flags, expected] of [
    [{ first: true }, { position: "first" }],
    [{ last: true }, { position: "last" }],
    [{ position: "0" }, { position: 0 }],
    [{ before: "anchor" }, { before: "anchor" }],
    [{ after: "anchor" }, { after: "anchor" }],
    [{ after: "wiki01:setup" }, { after: "anchor" }],
  ] satisfies [CloudCliFlags, unknown][]) {
    const { ctx, writes } = commandContext(["mv", "note01"], flags);
    await notebooksCli.run(ctx);
    expect(writes).toEqual([expected]);
  }
});

test("mv with a target preserves the level mode unless placement is supplied", async () => {
  const target = commandContext(["mv", "note01", "anchor"]);
  await notebooksCli.run(target.ctx);
  expect(target.writes).toEqual([{ parentId: "anchor" }]);
  const placement = commandContext(["mv", "note01", "wiki01:"], { last: true });
  await notebooksCli.run(placement.ctx);
  expect(placement.writes).toEqual([{ parentId: null, position: "last" }]);
});

test("mv refuses missing or ambiguous placements and anchors from another notebook", async () => {
  const missing = commandContext(["mv", "note01"]);
  await expect(notebooksCli.run(missing.ctx)).rejects.toThrow("exactly one placement flag");
  expect(missing.writes).toEqual([]);
  const german = commandContext(["mv", "note01"], {}, "de");
  await expect(notebooksCli.run(german.ctx)).rejects.toThrow("genau eine Platzierung");
  const ambiguousFlags: CloudCliFlags[] = [
    { first: true, last: true },
    { before: "anchor", position: "0" },
    { before: "anchor", after: "anchor" },
  ];
  for (const flags of ambiguousFlags) {
    const ambiguous = commandContext(["mv", "note01", "anchor"], flags);
    await expect(notebooksCli.run(ambiguous.ctx)).rejects.toThrow("at most one placement");
    expect(ambiguous.writes).toEqual([]);
  }
  const other = commandContext(["mv", "note01"], { after: "other1" });
  await expect(notebooksCli.run(other.ctx)).rejects.toThrow("same notebook");
  expect(other.writes).toEqual([]);
});

test("ls and tree display hand order and numeric alphabetical order", async () => {
  const outline = [
    { id: "ten001", parentId: null, title: "Chapter 10", position: 0, hasChildren: false, updatedAt: "" },
    { id: "two001", parentId: null, title: "Chapter 2", position: 0, hasChildren: false, updatedAt: "" },
    { id: "first1", parentId: null, title: "Zebra", position: 0, hasChildren: true, updatedAt: "" },
    { id: "child1", parentId: "first1", title: "Z", position: 1, hasChildren: false, updatedAt: "" },
    { id: "child2", parentId: "first1", title: "A", position: 2, hasChildren: false, updatedAt: "" },
  ];
  for (const command of ["ls", "tree"]) {
    const { ctx, lines } = commandContext([command, "wiki01"]);
    ctx.fetch = async (path) =>
      path.includes("/outline?") ? Response.json({ data: outline, pagination: { has_next: false } }) : Response.json(notebookFixture);
    await notebooksCli.run(ctx);
    const alphabetical = lines.join("");
    expect(alphabetical.indexOf('"two001"')).toBeLessThan(alphabetical.indexOf('"ten001"'));
    if (command === "tree") expect(alphabetical.indexOf('"child1"')).toBeLessThan(alphabetical.indexOf('"child2"'));
    outline[2]!.position = 1;
    outline[0]!.position = 2;
    outline[1]!.position = 3;
    lines.length = 0;
    await notebooksCli.run(ctx);
    const hand = lines.join("");
    expect(hand.indexOf('"first1"')).toBeLessThan(hand.indexOf('"ten001"'));
    expect(hand.indexOf('"ten001"')).toBeLessThan(hand.indexOf('"two001"'));
    for (const note of outline.filter((note) => note.parentId === null)) note.position = 0;
  }
});
