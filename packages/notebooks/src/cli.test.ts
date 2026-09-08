import { afterEach, expect, test } from "bun:test";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const runCli = async (server: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "../cloud-cli/src/index.ts", "--server", server, "--token", "test-token", ...args],
    cwd: new URL("..", import.meta.url).pathname,
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

const editingServer = () => {
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
      return Response.json(noteFixture);
    },
  });
  servers.push(server);
  return { server: `http://127.0.0.1:${server.port}`, writes };
};

test("updates only valid default presentation modes", async () => {
  const { server, writes } = editingServer();
  for (const mode of ["book", "write", "readonly"]) {
    const result = await runCli(server, ["notebooks", "update", "--notebook", "wiki01", "--default-presentation-mode", mode]);
    expect(result.exitCode).toBe(0);
  }
  const invalid = await runCli(server, ["notebooks", "update", "--notebook", "wiki01", "--default-presentation-mode", "edit"]);
  expect(invalid.exitCode).toBe(1);
  expect(writes).toEqual([
    { defaultPresentationMode: "book" },
    { defaultPresentationMode: "write" },
    { defaultPresentationMode: "readonly" },
  ]);
});

test("rejects ambiguous edit operations before a write", async () => {
  const { server, writes } = editingServer();
  const result = await runCli(server, [
    "notebooks",
    "edit",
    "--notebook",
    "wiki01",
    "--note",
    "note01",
    "--append",
    "--set-content",
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
    const result = await runCli(server, [
      "notebooks",
      "edit",
      "--notebook",
      "wiki01",
      "--note",
      "note01",
      flag!,
      value!,
      "--content",
      ":::toc\n:::",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid");
  }
  expect(writes).toEqual([]);
});

test("dry-run honors the same updatedAt precondition as saved edits", async () => {
  const { server, writes } = editingServer();
  const args = [
    "--json",
    "notebooks",
    "edit",
    "--notebook",
    "wiki01",
    "--note",
    "note01",
    "--append",
    "--content",
    ":::query\nsource: notes\n:::\n",
    "--dry-run",
    "--if-updated-at",
  ];
  const stale = await runCli(server, [...args, "2020-01-01T00:00:00.000Z"]);
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("updatedAt changed");
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
      if (request.method === "GET" && path === "/api/notebooks/wiki01/notes/note01") return Response.json(noteFixture);
      if (request.method === "POST" && path === "/api/notebooks/wiki01/notes/note01/block-preview") {
        bodies.push(await request.json());
        return Response.json(preview);
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  servers.push(server);
  for (const input of [[], ["--content", ""], ["--content", ":::query\nsource: notes\n:::\n"]]) {
    const result = await runCli(`http://127.0.0.1:${server.port}`, [
      "--json",
      "notebooks",
      "preview",
      "--notebook",
      "wiki01",
      "--note",
      "note01",
      ...input,
    ]);
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
    "--notebook",
    "wiki01",
    "--note",
    "note01",
    "--content",
    ":::toc\n:::",
    "--stdin",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("only one of --content, --file, or --stdin");
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
  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "notebooks",
    "preview",
    "--notebook",
    "wiki01",
    "--note",
    "note01",
  ]);
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
    "--all",
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

test("destructive notebook deletion requires explicit confirmation", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ message: "unexpected" }, { status: 500 }) });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", "delete", "wiki01"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("without --yes");
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

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "notebooks", "get", "--notebook", "Wiki"]);

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

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["notebooks", "get", "--notebook", legacyUuid]);

  expect(result.exitCode).toBe(1);
  expect(requestUrls).toHaveLength(1);
  const requestUrl = new URL(requestUrls[0]!);
  expect(requestUrl.pathname).toBe("/api/notebooks");
  expect(requestUrl.searchParams.get("q")).toBe(legacyUuid);
  expect(requestUrl.pathname).not.toContain(legacyUuid);
});

test("create-note sends markdown without a separate title", async () => {
  const createBodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01") return Response.json(notebookFixture);
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
    "create-note",
    "--notebook",
    "wiki01",
    "--content",
    "# Incident review\n",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(createBodies).toEqual([{ contentMd: "# Incident review\n" }]);
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
    "--notebook",
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
      if (request.method === "GET" && url.pathname === "/api/notebooks/wiki01/notes/note01") return Response.json(note);
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
    "add-comment",
    "--notebook",
    "wiki01",
    "--note",
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
