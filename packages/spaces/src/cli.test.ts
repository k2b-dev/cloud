import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFirstPartyModules } from "../../cloud-cli/test/fixtures/first-party";

/** The spaces module as a package plugin in a private config home; cld loads it like any installed module. */
const cliHome = await mkdtemp(join(tmpdir(), "cld-spaces-cli-"));
await installFirstPartyModules(cliHome, ["spaces"]);
afterAll(() => rm(cliHome, { recursive: true, force: true }));

/**
 * `cld spaces` against a recording mock of the Spaces REST API: addressing,
 * every command's request, and the stable `--json` shapes.
 */

// Every case spawns the real CLI several times in sequence.
setDefaultTimeout(60_000);

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

const space = {
  id: "Space1",
  name: "Roadmap",
  description: null,
  color: "#3b82f6",
  icalToken: null,
  createdAt: "2026-08-11T08:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};
const spaceDetail = {
  ...space,
  columns: [
    { id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1024", isDone: false },
    { id: "Col002", spaceId: "Space1", name: "Doing", color: null, rank: "2048", isDone: false },
  ],
  tags: [{ id: "Tag001", spaceId: "Space1", name: "Backend", color: null }],
};
const item = (id: string, title: string) => ({
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
});
const task = item("Item01", "Ship release");
const blocker = item("Block1", "Approve scope");
const attachment = {
  id: "File01",
  filename: "broken-dialog.webp",
  mimeType: "image/webp",
  sizeBytes: 11,
  kind: "image",
  createdAt: "2026-08-20T15:00:00.000Z",
};
const work = { claim: { id: CLAIM_ID, claimedAt: "2026-09-08T12:00:00.000Z" }, progress: null, result: null };
const link = {
  url: "https://github.com/k2b-dev/cloud/issues/263",
  label: null,
  createdAt: "2026-08-11T08:00:00.000Z",
  preview: { kind: "github", repo: "k2b-dev/cloud", number: 263, type: "issue", title: "Links on items", state: "open" },
};
const commentsPage = { items: [{ id: "Cmt001", content: "Looks good", userName: "Ada" }], page: 2, perPage: 10, total: 11, hasNext: false };
const blocksPage = {
  items: [{ dependent: { id: "Next01", spaceId: "Space1", title: "Announce", completedAt: null }, createdAt: "x" }],
  page: 1,
  perPage: 50,
  total: 1,
  hasNext: false,
};
const blockers = [{ blocker: { id: "Block1", spaceId: "Space1", title: "Approve scope", completedAt: null }, createdAt: "x" }];

type Recorded = { method: string; path: string; body: unknown };
const requests: Recorded[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";

const conflict = (message: string) => Response.json({ code: "CONFLICT", message }, { status: 409 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spaces-cli-"));
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const type = request.headers.get("content-type") ?? "";
      const body = type.includes("json")
        ? await request.json()
        : type.includes("multipart")
          ? { file: ((await request.formData()).get("file") as File).name }
          : undefined;
      requests.push({ method: request.method, path: path + url.search, body });
      const json = (value: unknown) => Response.json(value);

      if (path === "/api/me") return json({ id: USER_ID });
      if (path === "/api/spaces" && request.method === "GET") return json([space, { ...space, id: "Space2", name: "Hiring" }]);
      if (path === "/api/spaces" && request.method === "POST") return json({ ...space, id: "New001", ...(body as object) });
      if (path === "/api/spaces/resolve") {
        const ref = url.searchParams.get("space");
        const title = url.searchParams.get("title");
        if (ref === "Twins")
          return conflict('"Twins" matches several spaces: Twins (TwinA1), Twins (TwinB2). Use one of these paths or IDs.');
        if (ref !== "Roadmap" && ref !== "Space1")
          return Response.json({ message: `No space has the ID or exact name "${ref}"` }, { status: 404 });
        if (title === null) return json({ space, item: null });
        if (title === "Duplicate")
          return conflict(
            '"Duplicate" matches several items: Roadmap:Duplicate (Dup001), Roadmap:Duplicate (Dup002). Use one of these paths or IDs.',
          );
        if (title === "Ship release") return json({ space, item: task });
        if (title === "Approve scope") return json({ space, item: blocker });
        return Response.json({ message: "No item" }, { status: 404 });
      }
      if (path === "/api/spaces/items/Item01") return json(task);
      if (path === "/api/spaces/items/Block1") return json(blocker);
      if (path.startsWith("/api/spaces/items/")) return Response.json({ message: "Item not found" }, { status: 404 });
      if (path === "/api/spaces/Space1") return json(spaceDetail);
      if (path === "/api/spaces/Space1/assignable-users") return json([{ id: OTHER_ID, uid: "ada", displayName: "Ada", avatarHash: null }]);
      if (path === "/api/spaces/Space1/items/filter") return json({ items: [task], total: 1, page: 1, pageSize: 50, totalPages: 1 });
      if (path === "/api/spaces/Space1/items") return json({ ...task, ...(body as object), id: "New002" });
      if (path === "/api/spaces/calendar")
        return json([
          { id: "Evt001", spaceId: "Space1", spaceName: "Roadmap", title: "Launch", startsAt: "a", endsAt: "b" },
          { id: "Evt002", spaceId: "Other1", spaceName: "Other", title: "Else", startsAt: "a", endsAt: "b" },
        ]);
      if (path === "/api/spaces/calendar/overlap")
        return json([{ itemId: "Evt001", spaceId: "Space1", spaceName: "Roadmap", title: "Launch" }]);

      const itemPath = path.match(/^\/api\/spaces\/Space1\/items\/(Item01|Block1)(\/.*)?$/);
      if (itemPath) {
        const suffix = itemPath[2] ?? "";
        if (suffix === "" && request.method === "PATCH") return json({ ...task, ...(body as object) });
        if (suffix === "" && request.method === "DELETE") return json({ message: "Item deleted" });
        if (suffix === "/completed") return json({ ...task, completedAt: (body as { completed: boolean }).completed ? "now" : null });
        if (suffix === "/blockers" && request.method === "GET") return json(blockers);
        if (suffix === "/blockers") return json(request.method === "POST" ? blockers[0] : { message: "ok" });
        if (suffix === "/blocks/page") return json(blocksPage);
        if (suffix === "/comments/page") return json(commentsPage);
        if (suffix === "/comments") return json({ id: "Cmt002", content: (body as { content: string }).content });
        if (suffix === "/comments/Cmt001")
          return json(request.method === "DELETE" ? { message: "ok" } : { id: "Cmt001", ...(body as object) });
        if (suffix === "/attachments" && request.method === "GET") return json([attachment]);
        if (suffix === "/attachments") return json({ ...attachment, id: "File02", filename: "bug.png" });
        if (suffix === "/attachments/File01/content") return new Response("image-bytes");
        if (suffix === "/attachments/File01") return json({ message: "Attachment deleted" });
        if (["/work", "/claim", "/release", "/progress"].includes(suffix)) return json(work);
        if (suffix.startsWith("/activity")) return json({ data: [], nextCursor: null });
        if (suffix === "/checklist" && request.method === "GET") return json([]);
        if (suffix === "/checklist") return json({ id: "Check1", label: "Verify", completed: false });
        if (suffix === "/checklist/Check1")
          return json(request.method === "DELETE" ? { deleted: true } : { id: "Check1", label: "Verify", completed: true });
        if (suffix === "/references")
          return json(request.method === "GET" ? [] : request.method === "DELETE" ? { deleted: true } : { ref: {} });
        if (suffix === "/links")
          return json(
            request.method === "GET"
              ? [link]
              : request.method === "DELETE"
                ? { deleted: true }
                : { ...(body as object), createdAt: "2026-08-11T08:00:00.000Z", preview: null },
          );
        if (suffix === "/invitation-context") return json({ mailboxes: [], attendees: [], lastDelivery: null });
        if (suffix === "/invitation-draft") return json({ draftId: "d1", href: "/mail/d1" });
      }
      return Response.json({ message: `Unexpected ${request.method} ${path}` }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const cld = async (args: string[], stdin?: string) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "../cloud-cli/src/index.ts", "--server", base, "--token", "test-token", ...args],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_CONFIG_HOME: cliHome },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

/** Run one `--json` command and return its parsed output plus the requests it made. */
const run = async (args: string[]) => {
  const start = requests.length;
  const result = await cld(["--json", "spaces", ...args]);
  expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  return { json: JSON.parse(result.stdout) as unknown, requests: requests.slice(start) };
};

/** Run one command expected to fail; returns stderr and the requests it made. */
const failing = async (args: string[]) => {
  const start = requests.length;
  const result = await cld(["spaces", ...args]);
  expect(result.exitCode).toBe(1);
  return { stderr: result.stderr, requests: requests.slice(start) };
};

const writes = (recorded: Recorded[]) => recorded.filter((entry) => entry.method !== "GET");

describe("addressing", () => {
  test("an item ID resolves without naming its space", async () => {
    const { json, requests: made } = await run(["show", "Item01"]);
    expect(json).toMatchObject({ id: "Item01", attachments: [attachment] });
    expect(made[0]).toMatchObject({ method: "GET", path: "/api/spaces/items/Item01" });
  });

  test("<space>:<title> resolves on the server by space name and exact title", async () => {
    const { json, requests: made } = await run(["show", "Roadmap:Ship release"]);
    expect(json).toMatchObject({ id: "Item01" });
    expect(made[0]!.path).toBe(`/api/spaces/resolve?${new URLSearchParams({ space: "Roadmap", title: "Ship release" })}`);
  });

  test("ambiguous titles and space names fail with every candidate, never a guess", async () => {
    const title = await failing(["set", "Roadmap:Duplicate", "--priority", "high"]);
    expect(title.stderr).toContain("Roadmap:Duplicate (Dup001), Roadmap:Duplicate (Dup002)");
    expect(writes(title.requests)).toEqual([]);
    const name = await failing(["ls", "Twins"]);
    expect(name.stderr).toContain("Twins (TwinA1), Twins (TwinB2)");
  });

  test("rejects addresses that are neither an ID nor <space>:<title> before any request", async () => {
    for (const raw of ["Ship release", "./notes.md", "Roadmap:"]) {
      const result = await failing(["rm", raw, "--yes"]);
      expect(result.stderr).toContain("not an item address");
      expect(result.requests).toEqual([]);
    }
  });

  test("<space>: addresses the space itself", async () => {
    const { json } = await run(["show", "Roadmap:"]);
    expect(json).toEqual(spaceDetail);
  });
});

describe("browse", () => {
  test("ls lists spaces, filtered by -q", async () => {
    expect((await run(["ls"])).json).toHaveLength(2);
    expect((await run(["ls", "--q", "hir"])).json).toEqual([{ ...space, id: "Space2", name: "Hiring" }]);
  });

  test("ls <space> sends every filter through the item filter", async () => {
    const { json, requests: made } = await run([
      "ls",
      "Roadmap",
      "--mine",
      "--ready",
      "--due-before",
      "2026-10-01",
      "--due",
      "week",
      "--priority",
      "high",
      "--column",
      "Doing",
      "--tag",
      "Backend",
      "--inactive",
      "--sort",
      "priority",
      "--ascending",
      "--page",
      "2",
      "--per-page",
      "10",
    ]);
    expect(json).toMatchObject({ items: [{ id: "Item01" }], total: 1, page: 1, totalPages: 1 });
    expect(made.find((entry) => entry.path.endsWith("/items/filter"))?.body).toEqual({
      type: "task",
      status: "active",
      blocked: false,
      assignedTo: "me",
      assigneeIds: [],
      priority: ["high"],
      columnIds: ["Col002"],
      tagIds: ["Tag001"],
      deadlineFilter: "week",
      deadlineBefore: "2026-10-01T00:00:00.000Z",
      activity: "inactive",
      sort: "priority",
      sortDesc: false,
      groupBy: "none",
      page: 2,
      pageSize: 10,
    });
  });

  test("show --context bundles work, checklist, deps, references and a comments page", async () => {
    const { json } = await run(["show", "Item01", "--context", "--page", "2", "--per-page", "10"]);
    expect(json).toMatchObject({
      id: "Item01",
      work,
      checklist: [],
      blockers,
      blocks: blocksPage,
      references: [],
      links: [link],
      comments: commentsPage,
    });
  });
});

describe("changes", () => {
  test("create, add, set, mv and rm send the documented payloads", async () => {
    expect((await run(["create", "Hiring", "--description", "People"])).requests[0]?.body).toEqual({
      name: "Hiring",
      description: "People",
      color: "#3b82f6",
    });

    const descriptionPath = join(dir, "description.md");
    await Bun.write(descriptionPath, "Long text");
    const added = await run([
      "add",
      "Roadmap:Write notes",
      "--from",
      descriptionPath,
      "--deadline",
      "2026-10-20",
      "--estimate-minutes",
      "90",
      "--tag",
      "Backend",
      "--assignee",
      "me",
      "--assignee",
      "ada",
    ]);
    expect(added.json).toMatchObject({ id: "New002", title: "Write notes" });
    expect(writes(added.requests)[0]?.body).toEqual({
      columnId: "Col001",
      title: "Write notes",
      description: "Long text",
      deadline: "2026-10-20T23:59:59.999Z",
      estimatedDurationMinutes: 90,
      assigneeIds: [USER_ID, OTHER_ID],
      tagIds: ["Tag001"],
    });

    const set = await run(["set", "Item01", "--title", "Ship it", "--clear-tags", "--clear-assignees", "--clear-estimate"]);
    expect(writes(set.requests)[0]).toEqual({
      method: "PATCH",
      path: "/api/spaces/Space1/items/Item01",
      body: { title: "Ship it", estimatedDurationMinutes: null, assigneeIds: [], tagIds: [] },
    });

    expect(writes((await run(["mv", "Roadmap:Ship release", "Doing"])).requests)[0]?.body).toEqual({ columnId: "Col002" });

    const refused = await failing(["rm", "Item01"]);
    expect(refused.stderr).toContain("--yes");
    expect(refused.requests).toEqual([]);
    const removed = await run(["rm", "Item01", "--yes"]);
    expect(removed.json).toEqual({ deleted: { id: "Item01", spaceId: "Space1", title: "Ship release" } });
    expect(writes(removed.requests)).toEqual([{ method: "DELETE", path: "/api/spaces/Space1/items/Item01", body: undefined }]);
  });

  test("quick actions complete, reopen, assign and set deadlines", async () => {
    const resultPath = join(dir, "result.md");
    await Bun.write(resultPath, "Verified.");
    const done = await run(["done", "Item01", "--from", resultPath, "--commit", "a1b2c3d", "--claim-id", CLAIM_ID]);
    expect(done.json).toMatchObject({ id: "Item01", completedAt: "now" });
    expect(writes(done.requests)[0]?.body).toEqual({ completed: true, result: "Verified.", commit: "a1b2c3d", claimId: CLAIM_ID });
    expect(writes((await run(["reopen", "Item01"])).requests)[0]?.body).toEqual({ completed: false });

    expect(writes((await run(["assign", "Item01", "me"])).requests)[0]?.body).toEqual({ assigneeIds: [USER_ID] });
    expect(writes((await run(["assign", "Item01", "ada"])).requests)[0]?.body).toEqual({ assigneeIds: [OTHER_ID] });
    expect(writes((await run(["assign", "Item01", "none"])).requests)[0]?.body).toEqual({ assigneeIds: [] });
    expect((await failing(["assign", "Item01", "nobody"])).stderr).toContain('"nobody"');

    expect(writes((await run(["due", "Item01", "2026-10-20"])).requests)[0]?.body).toEqual({ deadline: "2026-10-20T23:59:59.999Z" });
    expect(writes((await run(["due", "Item01", "none"])).requests)[0]?.body).toEqual({ deadline: null });
  });

  test("deps lists both directions and adds or removes blockers by address", async () => {
    const listed = await run(["deps", "Item01"]);
    expect(listed.json).toEqual({ item: { id: "Item01", title: "Ship release" }, blockers, blocks: blocksPage });
    expect(writes(listed.requests)).toEqual([]);

    const changed = await run(["deps", "Item01", "--add", "Roadmap:Approve scope", "--rm", "Block1"]);
    expect(changed.json).toMatchObject({ item: { id: "Item01" }, blockers, blocks: blocksPage });
    expect(writes(changed.requests)).toEqual([
      { method: "POST", path: "/api/spaces/Space1/items/Item01/blockers", body: { blockerItemId: "Block1" } },
      { method: "DELETE", path: "/api/spaces/Space1/items/Item01/blockers", body: { blockerItemId: "Block1" } },
    ]);
  });
});

describe("secondary resources", () => {
  test("comments list, add, update and delete", async () => {
    expect((await run(["comments", "list", "Item01", "--page", "2", "--per-page", "10"])).json).toEqual(commentsPage);
    expect(writes((await run(["comments", "add", "Item01", "--content", "Ready"])).requests)[0]?.body).toEqual({ content: "Ready" });
    const updated = await run(["comments", "update", "Item01", "Cmt001", "--content", "Edited"]);
    expect(writes(updated.requests)[0]).toMatchObject({ method: "PATCH", path: "/api/spaces/Space1/items/Item01/comments/Cmt001" });
    expect((await failing(["comments", "delete", "Item01", "Cmt001"])).requests).toEqual([]);
    expect((await run(["comments", "delete", "Item01", "Cmt001", "--yes"])).json).toEqual({ deleted: { id: "Cmt001", itemId: "Item01" } });
  });

  test("attachments list, add, download and delete", async () => {
    const upload = join(dir, "bug.png");
    const out = join(dir, "downloaded.webp");
    await Bun.write(upload, new Uint8Array([137, 80, 78, 71]));
    expect((await run(["attachments", "list", "Item01"])).json).toEqual([attachment]);
    const added = await run(["attachments", "add", "Item01", upload]);
    expect(added.json).toMatchObject({ id: "File02" });
    expect(writes(added.requests)[0]?.body).toEqual({ file: "bug.png" });
    const downloaded = await run(["attachments", "download", "Item01", "broken-dialog.webp", "--out", out]);
    expect(downloaded.json).toEqual({ attachment, out });
    expect(await readFile(out, "utf8")).toBe("image-bytes");
    expect((await failing(["attachments", "delete", "Item01", "File01"])).requests).toEqual([]);
    expect((await run(["attachments", "delete", "Item01", "File01", "--yes"])).json).toEqual({ deleted: attachment });
  });

  test("work, claim, release, progress and activity", async () => {
    expect((await run(["work", "Item01"])).json).toEqual(work);
    expect(writes((await run(["claim", "Item01", "--claim-id", CLAIM_ID])).requests)[0]?.body).toEqual({ claimId: CLAIM_ID });
    expect(writes((await run(["release", "Item01", "--claim-id", CLAIM_ID, "--force"])).requests)[0]?.body).toEqual({
      claimId: CLAIM_ID,
      force: true,
    });
    const start = requests.length;
    expect((await cld(["--json", "spaces", "progress", "Item01", "--from", "-"], "From stdin")).exitCode).toBe(0);
    expect(writes(requests.slice(start))[0]?.body).toEqual({ content: "From stdin" });
    expect(writes((await run(["progress", "Item01", "--content", "Handoff"])).requests)[0]?.body).toEqual({ content: "Handoff" });
    const activity = await run(["activity", "Item01", "--cursor", "c1", "--limit", "10"]);
    expect(activity.requests.at(-1)?.path).toBe("/api/spaces/Space1/items/Item01/activity?limit=10&cursor=c1");
  });

  test("checklist and references", async () => {
    expect((await run(["checklist", "list", "Item01"])).json).toEqual([]);
    expect(writes((await run(["checklist", "add", "Item01", "Verify", "--completed"])).requests)[0]?.body).toEqual({
      label: "Verify",
      completed: true,
    });
    expect(writes((await run(["checklist", "update", "Item01", "Check1", "--reopen"])).requests)[0]?.body).toEqual({ completed: false });
    expect((await run(["checklist", "delete", "Item01", "Check1", "--yes"])).json).toEqual({ deleted: true });
    const reference = ["--type", "notebooks.note", "--id", "Note01"];
    expect(writes((await run(["references", "add", "Item01", ...reference, "--label", "Design"])).requests)[0]?.body).toEqual({
      ref: { type: "notebooks.note", id: "Note01" },
      label: "Design",
    });
    expect((await failing(["references", "delete", "Item01", ...reference])).requests).toEqual([]);
    expect((await run(["references", "delete", "Item01", ...reference, "--yes"])).json).toEqual({ deleted: true });
  });

  test("links", async () => {
    expect((await run(["links", "ls", "Item01"])).json).toEqual({ references: [], links: [link] });
    const added = await run(["links", "add", "Item01", "https://example.org/spec", "--label", "Spec"]);
    expect(writes(added.requests)[0]).toMatchObject({
      path: "/api/spaces/Space1/items/Item01/links",
      body: { url: "https://example.org/spec", label: "Spec" },
    });
    expect(added.json).toMatchObject({ url: "https://example.org/spec", label: "Spec", preview: null });
    expect((await failing(["links", "rm", "Item01", "https://example.org/spec"])).requests).toEqual([]);
    const removed = await run(["links", "rm", "Item01", "https://example.org/spec", "--yes"]);
    expect(writes(removed.requests)[0]).toMatchObject({ method: "DELETE", body: { url: "https://example.org/spec" } });
    expect(removed.json).toEqual({ deleted: true });
  });

  test("calendar, overlap and invitations", async () => {
    const calendar = await run(["calendar", "2026-10-01", "2026-10-31", "--space", "Roadmap"]);
    expect(calendar.json).toEqual([{ id: "Evt001", spaceId: "Space1", spaceName: "Roadmap", title: "Launch", startsAt: "a", endsAt: "b" }]);
    expect(calendar.requests.at(-1)?.path).toBe(
      `/api/spaces/calendar?${new URLSearchParams({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" })}`,
    );
    const overlap = await run(["overlap", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z", "--exclude", "Item01"]);
    expect(overlap.requests.at(-1)?.path).toContain("excludeItemId=Item01");
    expect((await run(["invitation", "context", "Item01"])).json).toEqual({ mailboxes: [], attendees: [], lastDelivery: null });
    const draft = await run(["invitation", "draft", "Item01", "--mailbox", "m1", "--identity", "i1", "--to", "a@example.org"]);
    expect(writes(draft.requests)[0]?.body).toMatchObject({ mailboxId: "m1", senderIdentityId: "i1", method: "request" });
  });
});

test("help is available in English and German with unchanged command names", async () => {
  const en = await cld(["spaces", "help"]);
  const de = await cld(["--locale", "de", "spaces", "help"]);
  expect(en.stdout).toContain("List spaces, or the items of one space");
  expect(de.stdout).toContain("Spaces oder die Einträge eines Space auflisten");
  for (const name of ["ls", "show", "add", "set", "mv", "rm", "done", "assign", "due", "deps", "comments", "attachments"])
    expect(de.stdout).toContain(`  ${name} `);
});
