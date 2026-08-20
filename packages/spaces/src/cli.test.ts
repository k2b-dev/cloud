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
      if (url.pathname === "/api/spaces/Space1/items/Item01/blocks" && request.method === "GET") {
        return Response.json([
          {
            dependent: { id: "Next01", spaceId: "Space1", title: "Publish release", completedAt: null },
            createdAt: "2026-08-11T09:00:00.000Z",
          },
        ]);
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
