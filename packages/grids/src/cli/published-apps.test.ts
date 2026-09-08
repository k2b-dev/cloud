import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@valentinkolb/cloud/cli";
import { publishedAppCommands } from "./published-apps";

const context = (responses: Response[]) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const values: unknown[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { output: "json", server: "http://cloud.test", token: "test", profile: "test" },
    getDefault: async () => "BASE01",
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Not used");
    },
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? "Request failed");
      return value;
    },
    print: () => {},
    write: async () => {},
    error: () => {},
    table: () => {},
    json: (value) => values.push(value),
    jsonLine: (value) => values.push(value),
  };
  return { ctx, calls, values };
};

const command = (verb: string) => {
  const item = publishedAppCommands.find((item) => item.path.join(" ") === `apps runtime ${verb}`);
  if (!item) throw new Error(`Missing ${verb}`);
  return item;
};
const args = { app: "APP001", page: "request", block: "detail" };
const body = (value: unknown) => ({ source: "value" as const, value: JSON.stringify(value), provided: true });

describe("published App terminal journeys", () => {
  test("discovers a page without looking up a Base and keeps the whole JSONL envelope", async () => {
    const result = { page: { id: "request" }, blocks: [], navigation: [] };
    const { ctx, calls, values } = context([Response.json(result)]);
    ctx.options.output = "jsonl";
    await command("read").run({ ctx, args: { app: args.app }, flags: { page: "request", params: '{"request_id":"REC001"}' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/grids/apps/runtime/APP001/request?request_id=REC001");
    expect(values).toEqual([result]);
  });
  test("preserves search, cursor and page scope", async () => {
    const { ctx, calls } = context([Response.json({ rows: [], nextCursor: "next" })]);
    await command("records").run({ ctx, args, flags: { params: '{"request_id":"REC001"}', search: "a&b", cursor: "a+b/c" } });
    expect(calls[0]?.path).toEndWith("/records?request_id=REC001&_search=a%26b&_cursor=a%2Bb%2Fc");
  });
  test("keeps page parameters separate from record and comment controls", async () => {
    const { ctx, calls } = context([Response.json({}), Response.json({}), Response.json({})]);
    const params = '{"q":"REC001","cursor":"REC002","limit":"REC003"}';
    await command("records").run({ ctx, args, flags: { params } });
    await command("records").run({ ctx, args, flags: { params, search: "needle", cursor: "next+page" } });
    await command("comments list").run({ ctx, args, flags: { params, cursor: "comments+page", limit: 5 } });
    for (const call of calls) {
      const query = new URL(call.path, "http://cloud.test").searchParams;
      expect(Object.fromEntries(["q", "cursor", "limit"].map((key) => [key, query.get(key)]))).toEqual({
        q: "REC001",
        cursor: "REC002",
        limit: "REC003",
      });
    }
    expect(calls[0]?.path).toEndWith("?q=REC001&cursor=REC002&limit=REC003");
    expect(calls[1]?.path).toEndWith("&_search=needle&_cursor=next%2Bpage");
    expect(calls[2]?.path).toEndWith("&_cursor=comments%2Bpage&_limit=5");
  });
  test.each(["submit", "update", "scan", "action", "row-action", "sidebar-submit"])(
    "%s requires confirmation before network access",
    async (verb) => {
      const { ctx, calls } = context([]);
      await expect(command(verb).run({ ctx, args: { ...args, action: "approve" }, flags: { body: body({}) } })).rejects.toThrow("--yes");
      expect(calls).toHaveLength(0);
    },
  );
  test.each([
    ["submit", "POST", "/request/detail/submit"],
    ["update", "PATCH", "/request/detail/record"],
    ["scan", "POST", "/request/detail/scanner"],
    ["action", "POST", "/request/detail/actions/approve"],
    ["row-action", "POST", "/request/detail/row-actions/approve"],
  ])("%s uses only its published endpoint and keeps the caller's operation ID", async (verb, method, suffix) => {
    const { ctx, calls, values } = context([Response.json({ status: "queued" })]);
    const input = { operationId: "stable-retry-id", values: { FIELD1: "Value" } };
    await command(verb).run({ ctx, args: { ...args, action: "approve" }, flags: { body: body(input), yes: true } });
    expect(calls[0]?.path).toEndWith(suffix!);
    expect(calls[0]?.init?.method).toBe(method);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
    expect(values).toEqual([{ status: "queued" }]);
  });
  test("sidebar submission is App-global and ignores page arguments", async () => {
    const { ctx, calls } = context([Response.json({ recordId: "REC001" })]);
    await command("sidebar-submit").run({
      ctx,
      args: { app: "APP001", action: "new" },
      flags: { body: body({ FIELD1: "hello" }), yes: true },
    });
    expect(calls[0]?.path).toBe("/api/grids/apps/runtime/APP001/sidebar/forms/new/submit");
  });
  test("run status remains action scoped and surfaces revoked access", async () => {
    const { ctx, calls } = context([Response.json({ message: "Not found" }, { status: 404 })]);
    await expect(
      command("run").run({ ctx, args: { ...args, run: "RUN001" }, flags: { action: "approve", params: '{"request_id":"REC001"}' } }),
    ).rejects.toThrow("Not found");
    expect(calls[0]?.path).toEndWith("/actions/approve/runs/RUN001?request_id=REC001");
  });
  test("comments keep server permissions and empty deletion responses", async () => {
    const { ctx, values } = context([Response.json({ body: "Hello" }), new Response(null, { status: 204 })]);
    await command("comments create").run({ ctx, args, flags: { body: body({ body: "Hello" }) } });
    await command("comments delete").run({ ctx, args, flags: { comment: "COMM01", yes: true } });
    expect(values).toEqual([{ body: "Hello" }, { deleted: true }]);
  });
  test("file mutations require confirmation and downloads require an output file before fetching", async () => {
    const { ctx, calls } = context([]);
    await expect(command("files delete").run({ ctx, args: { ...args, field: "FIELD1" }, flags: { id: "FILE01" } })).rejects.toThrow(
      "--yes",
    );
    await expect(command("files download").run({ ctx, args: { ...args, field: "FIELD1" }, flags: { id: "FILE01" } })).rejects.toThrow(
      "--out",
    );
    expect(calls).toHaveLength(0);
  });
  test("rejects path traversal and non-public Record parameters before fetching", async () => {
    const { ctx, calls } = context([]);
    await expect(command("read").run({ ctx, args, flags: { page: "../admin" } })).rejects.toThrow("identifier");
    await expect(command("read").run({ ctx, args, flags: { params: '{"request_id":"Unknown record"}' } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  test("keeps every published command in the skill index", async () => {
    const reference = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();
    const paths = reference
      .split("```text")
      .at(-1)!
      .split("```")[0]!
      .split("\n")
      .flatMap((line) => {
        const parts = line.trim().split(" ");
        return (parts.pop() ?? "").split("|").map((verb) => [...parts, verb].join(" "));
      });
    for (const item of publishedAppCommands) expect(paths).toContain(item.path.join(" "));
  });
});
