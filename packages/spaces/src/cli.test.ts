import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: ReturnType<typeof Bun.serve>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

test("uses only six-character Space IDs as direct resource references", async () => {
  const legacyUuid = "11111111-1111-4111-8111-111111111111";
  const requestUrls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requestUrls.push(request.url);
      const url = new URL(request.url);
      if (url.pathname === "/api/spaces/space1") {
        return Response.json({
          id: "space1",
          name: "Roadmap",
          description: null,
          color: "#3b82f6",
          icalToken: null,
          createdAt: "2026-08-11T08:00:00.000Z",
          updatedAt: "2026-08-11T09:00:00.000Z",
          columns: [],
          tags: [],
        });
      }
      return Response.json([]);
    },
  });
  servers.push(server);

  const direct = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "spaces", "get", "space1"]);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout).toContain('"id": "space1"');

  const legacy = await runCli(`http://127.0.0.1:${server.port}`, ["spaces", "get", legacyUuid]);
  expect(legacy.exitCode).toBe(1);
  expect(requestUrls.map((value) => new URL(value).pathname)).toEqual(["/api/spaces/space1", "/api/spaces"]);
}, 10_000);

test("sends task estimates and blocker relationships through the public REST contract", async () => {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  const space = {
    id: "Space1",
    name: "Roadmap",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    columns: [{ id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1024", isDone: false }],
    tags: [],
  };
  const item = (id: string, title: string, estimatedDurationMinutes: number | null = null) => ({
    id,
    spaceId: "Space1",
    columnId: "Col001",
    title,
    description: null,
    location: null,
    url: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    deadline: null,
    estimatedDurationMinutes,
    activeBlockerCount: 0,
    priority: null,
    recurrence: null,
    recurringEventId: null,
    recurrenceId: null,
    rank: "1024",
    completedAt: null,
    createdBy: null,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    assignees: [],
    tags: [],
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/spaces/Space1" && request.method === "GET") return Response.json(space);
      if (url.pathname === "/api/spaces/Space1/items/Item01") return Response.json(item("Item01", "Ship release"));
      if (url.pathname === "/api/spaces/Space1/items/Block1") return Response.json(item("Block1", "Approve scope"));
      if (url.pathname === "/api/spaces/Space1/items" && request.method === "POST") {
        const body = await request.json();
        writes.push({ path: url.pathname, method: request.method, body });
        return Response.json(item("New001", "Estimate me", 45));
      }
      if (url.pathname === "/api/spaces/Space1/items/Item01/blockers" && request.method === "POST") {
        const body = await request.json();
        writes.push({ path: url.pathname, method: request.method, body });
        return Response.json({
          blocker: { id: "Block1", spaceId: "Space1", title: "Approve scope", completedAt: null },
          createdAt: "2026-08-11T09:00:00.000Z",
        });
      }
      if (url.pathname === "/api/spaces/Space1/items/Item01/blocks/page" && request.method === "GET") {
        return Response.json({
          items: [
            {
              dependent: { id: "Next01", spaceId: "Space1", title: "Publish release", completedAt: null },
              createdAt: "2026-08-11T09:00:00.000Z",
            },
          ],
          page: 1,
          perPage: 50,
          total: 1,
          hasNext: false,
        });
      }
      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const estimate = await runCli(baseUrl, [
    "--json",
    "spaces",
    "add-item",
    "Space1",
    "Estimate me",
    "--column",
    "Col001",
    "--estimate-minutes",
    "45",
  ]);
  expect(estimate.exitCode).toBe(0);

  const block = await runCli(baseUrl, ["--json", "spaces", "block", "Space1", "Item01", "Block1"]);
  expect(block.exitCode).toBe(0);
  const blocks = await runCli(baseUrl, ["--json", "spaces", "blocks", "Space1", "Item01"]);
  expect(blocks.exitCode).toBe(0);
  expect(blocks.stdout).toContain("Publish release");
  expect(writes).toEqual([
    {
      path: "/api/spaces/Space1/items",
      method: "POST",
      body: {
        columnId: "Col001",
        title: "Estimate me",
        estimatedDurationMinutes: 45,
        assigneeIds: [],
        tagIds: [],
      },
    },
    {
      path: "/api/spaces/Space1/items/Item01/blockers",
      method: "POST",
      body: { blockerItemId: "Block1" },
    },
  ]);
}, 10_000);

test("lists, uploads, downloads, and deletes task attachments through the public REST contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spaces-cli-attachments-"));
  tempDirs.push(directory);
  const uploadPath = join(directory, "bug.png");
  const outputPath = join(directory, "downloaded.webp");
  await Bun.write(uploadPath, new Uint8Array([137, 80, 78, 71]));

  const attachment = {
    id: "File01",
    filename: "broken-dialog.webp",
    mimeType: "image/webp",
    sizeBytes: 11,
    kind: "image",
    createdAt: "2026-08-20T15:00:00.000Z",
  } as const;
  const space = {
    id: "Space1",
    name: "Roadmap",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    columns: [],
    tags: [],
  };
  const item = {
    id: "Item01",
    spaceId: "Space1",
    columnId: "Col001",
    title: "Fix screenshot bug",
    description: null,
    location: null,
    url: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    deadline: null,
    estimatedDurationMinutes: null,
    activeBlockerCount: 0,
    priority: null,
    recurrence: null,
    recurringEventId: null,
    recurrenceId: null,
    rank: "1024",
    completedAt: null,
    createdBy: null,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    assignees: [],
    tags: [],
  };
  const writes: Array<{ method: string; filename?: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/spaces/Space1" && request.method === "GET") return Response.json(space);
      if (url.pathname === "/api/spaces/Space1/items/Item01" && request.method === "GET") return Response.json(item);
      if (url.pathname === "/api/spaces/Space1/items/Item01/attachments" && request.method === "GET") {
        return Response.json([attachment]);
      }
      if (url.pathname === "/api/spaces/Space1/items/Item01/attachments" && request.method === "POST") {
        const file = (await request.formData()).get("file");
        writes.push({ method: "POST", filename: file instanceof File ? file.name : undefined });
        return Response.json({ ...attachment, id: "File02", filename: "bug.png", mimeType: "image/png", sizeBytes: 4 });
      }
      if (url.pathname === "/api/spaces/Space1/items/Item01/attachments/File01/content" && request.method === "GET") {
        return new Response("image-bytes");
      }
      if (url.pathname === "/api/spaces/Space1/items/Item01/attachments/File01" && request.method === "DELETE") {
        writes.push({ method: "DELETE" });
        return Response.json({ message: "Attachment deleted" });
      }
      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const detail = await runCli(baseUrl, ["--json", "spaces", "item", "Space1", "Item01"]);
  expect(detail.exitCode).toBe(0);
  expect(detail.stdout).toContain('"attachments"');
  expect(detail.stdout).toContain('"File01"');

  const listed = await runCli(baseUrl, ["--json", "spaces", "attachments", "Space1", "Item01"]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain('"broken-dialog.webp"');

  const uploaded = await runCli(baseUrl, ["--json", "spaces", "add-attachment", "Space1", "Item01", "--file", uploadPath]);
  expect(uploaded.exitCode).toBe(0);
  expect(uploaded.stdout).toContain('"File02"');

  const downloaded = await runCli(baseUrl, [
    "--json",
    "spaces",
    "download-attachment",
    "Space1",
    "Item01",
    "File01",
    "--output",
    outputPath,
  ]);
  expect(downloaded.exitCode).toBe(0);
  expect(await readFile(outputPath, "utf8")).toBe("image-bytes");

  const refused = await runCli(baseUrl, ["spaces", "delete-attachment", "Space1", "Item01", "File01"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("without --yes");

  const deleted = await runCli(baseUrl, ["--json", "spaces", "delete-attachment", "Space1", "Item01", "File01", "--yes"]);
  expect(deleted.exitCode).toBe(0);
  expect(writes).toEqual([{ method: "POST", filename: "bug.png" }, { method: "DELETE" }]);
}, 20_000);

test("agent CLI preserves filters, complete context, paginated history and write payloads", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const space = { id: "Space1", name: "Project", columns: [{ id: "Col001", name: "Open" }], tags: [{ id: "Tag001", name: "Backend" }] };
  const item = {
    id: "Item01",
    spaceId: "Space1",
    title: "Implement",
    description: "Full requirements",
    startsAt: null,
    endsAt: null,
    completedAt: null,
    activeBlockerCount: 0,
  };
  const claimId = "11111111-1111-4111-8111-111111111111";
  const actor = { kind: "service_account", id: "22222222-2222-4222-8222-222222222222" };
  const work = { claim: { id: claimId, actor, claimedAt: "2026-09-08T12:00:00.000Z" }, progress: null, result: null };
  const page = { items: [{ id: "Note01", content: "Older handoff" }], page: 2, perPage: 10, total: 63, hasNext: true };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const body = request.method === "GET" ? undefined : await request.json();
      requests.push({ path: path + url.search, method: request.method, body });
      if (path === "/api/spaces/Space1") return Response.json(space);
      if (path === "/api/spaces/Space1/items/Item01") return Response.json(item);
      if (path.endsWith("/items/filter")) return Response.json({ items: [item], page: 3, pageSize: 10, total: 31, totalPages: 4 });
      if (path.endsWith("/comments/page")) return Response.json(page);
      if (path.endsWith("/blocks/page")) return Response.json({ items: [], page: 2, perPage: 10, total: 0, hasNext: false });
      if (path.endsWith("/work") || path.endsWith("/claim") || path.endsWith("/release") || path.endsWith("/progress"))
        return Response.json(work);
      if (path.endsWith("/completed")) return Response.json({ ...item, completedAt: "2026-09-08T12:00:00.000Z" });
      if (path.endsWith("/activity"))
        return Response.json({
          data: [{ action: "task.progress", metadata: { content: "Previous progress" } }],
          nextCursor: "next-cursor",
        });
      if (path.endsWith("/checklist") && request.method === "POST")
        return Response.json({ id: "Check1", label: "Verify", completed: false });
      if (path.endsWith("/checklist/Check1")) return Response.json({ id: "Check1", label: "Verify", completed: true });
      if (path.endsWith("/references") && request.method !== "GET") return Response.json({ deleted: true });
      if (path.endsWith("/attachments") || path.endsWith("/checklist") || path.endsWith("/blockers") || path.endsWith("/references"))
        return Response.json([]);
      return Response.json({ message: "Unexpected test request" }, { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const directory = await mkdtemp(join(tmpdir(), "spaces-agent-cli-"));
  tempDirs.push(directory);
  const notePath = join(directory, "result.md");
  await Bun.write(notePath, "Implemented.\nVerified: concurrency and rollback.");
  const commands = [
    [
      "items",
      "Space1",
      "--ready",
      "--assigned-to",
      "unassigned",
      "--priority",
      "high",
      "--column",
      "Open",
      "--tag",
      "Backend",
      "--deadline",
      "week",
      "--page",
      "3",
      "--page-size",
      "10",
      "--sort",
      "priority",
      "--ascending",
    ],
    ["item", "Space1", "Item01", "--context", "--page", "2", "--page-size", "10"],
    ["comments", "Space1", "Item01", "--page", "2", "--page-size", "10"],
    ["claim", "Space1", "Item01", "--claim-id", claimId],
    ["progress", "Space1", "Item01", "--claim-id", claimId, "--file", notePath],
    ["done", "Space1", "Item01", "--claim-id", claimId, "--file", notePath, "--commit", "a1b2c3d"],
    ["update-item", "Space1", "Item01", "--clear-tags", "--clear-assignees"],
    ["checklist", "add", "Space1", "Item01", "--label", "Verify"],
    ["checklist", "update", "Space1", "Item01", "Check1", "--completed"],
    ["references", "add", "Space1", "Item01", "--type", "notebooks.note", "--id", "Note01", "--label", "Design"],
    ["activity", "Space1", "Item01", "--cursor", "previous", "--limit", "10"],
  ];
  const results = await Promise.all(commands.map((args) => runCli(base, ["--json", "spaces", ...args])));
  for (const result of results) expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(results[1]!.stdout)).toMatchObject({
    description: "Full requirements",
    comments: page,
    work,
    checklist: [],
    references: [],
    blocks: { hasNext: false },
  });
  expect(JSON.parse(results[2]!.stdout)).toEqual(page);
  expect(requests.find((r) => r.path.endsWith("/items/filter"))?.body).toMatchObject({
    blocked: false,
    type: "task",
    status: "active",
    assignedTo: "unassigned",
    priority: ["high"],
    columnIds: ["Col001"],
    tagIds: ["Tag001"],
    deadlineFilter: "week",
    page: 3,
    pageSize: 10,
    sort: "priority",
    sortDesc: false,
  });
  expect(requests.find((r) => r.path.endsWith("/progress"))?.body).toEqual({
    claimId,
    content: "Implemented.\nVerified: concurrency and rollback.",
  });
  expect(requests.find((r) => r.path.endsWith("/completed"))?.body).toEqual({
    completed: true,
    claimId,
    result: "Implemented.\nVerified: concurrency and rollback.",
    commit: "a1b2c3d",
  });
  expect(requests.find((r) => r.method === "PATCH" && r.path.endsWith("/Item01"))?.body).toEqual({ tagIds: [], assigneeIds: [] });
  expect(requests.find((r) => r.path.endsWith("/checklist/Check1"))?.body).toEqual({ completed: true });
  expect(requests.find((r) => r.method === "POST" && r.path.endsWith("/references"))?.body).toEqual({
    ref: { type: "notebooks.note", id: "Note01" },
    label: "Design",
  });
  expect(requests.some((r) => r.path.endsWith("/activity?limit=10&cursor=previous"))).toBe(true);
}, 30_000);
