import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import assistant from "../cli";

const context = (args: string[], output: CloudCliContext["options"]["output"] = "text") => {
  const printed: string[] = [];
  const values: unknown[] = [];
  const requests: Array<{ path: string; method: string }> = [];
  const tables: Array<{ rows: Parameters<CloudCliContext["table"]>[0]; columns: string[] }> = [];
  const approval: { id: string; title: string; app: { name: string }; website: null; conversationId: string | null; lastUsedAt: string } = {
    id: "preference",
    title: "Create task",
    app: { name: "Spaces" },
    website: null,
    conversationId: null,
    lastUsedAt: "2026-10-10T12:00:00Z",
  };
  const ctx: CloudCliContext = {
    args,
    flags: {},
    options: { profile: "test", server: "https://cloud.example", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, method: init?.method ?? "GET" });
      if (path.startsWith("/api/ai/approval-preferences"))
        return Response.json(init?.method === "DELETE" ? { deleted: true } : { approvals: [approval] });
      throw new Error(`Unexpected path: ${path}`);
    },
    readJson: (response) => response.json(),
    print: (value = "") => {
      printed.push(value);
    },
    write: async () => {},
    error: () => {},
    json: (value) => {
      values.push(value);
    },
    jsonLine: (value) => {
      values.push(value);
    },
    table: (rows, columns) => {
      tables.push({ rows, columns: columns.map((column) => String(column.key)) });
    },
  };
  return { ctx, approval, printed, values, tables, requests };
};

test.each([false, true])("approvals list selects exactly the requested scope (chat: %s)", async (chat) => {
  const session = context(["approvals", "list"]);
  if (chat) {
    session.ctx.flags.chat = "chat-id";
    session.approval.conversationId = "chat-uuid";
  }
  await assistant.run(session.ctx);
  expect(session.requests).toEqual([{ path: `/api/ai/approval-preferences${chat ? "?conversation=chat-id" : ""}`, method: "GET" }]);
  expect(session.tables).toHaveLength(1);
  expect(session.tables[0]?.rows).toEqual([
    { id: "preference", title: "Create task", app: "Spaces", scope: chat ? "chat" : "everywhere", lastUsed: "2026-10-10T12:00:00Z" },
  ]);
  expect(session.tables[0]?.columns).toEqual(["id", "title", "app", "scope", "lastUsed"]);
});

test.each(["json", "jsonl"] as const)("approvals list supports %s with printRows", async (output) => {
  const session = context(["approvals", "list"], output);
  await assistant.run(session.ctx);
  expect(session.tables).toEqual([]);
  expect(session.printed).toEqual([]);
  if (output === "json") expect(session.values).toEqual([{ approvals: [session.approval] }]);
  else
    expect(session.values).toEqual([
      { id: "preference", title: "Create task", app: "Spaces", scope: "everywhere", lastUsed: "2026-10-10T12:00:00Z" },
    ]);
});

test("approvals list labels websites and missing last use", async () => {
  const session = context(["approvals", "list"]);
  session.ctx.fetch = async () =>
    Response.json({
      approvals: [
        {
          id: "website",
          title: "example.com",
          app: null,
          website: { origin: "https://example.com", resourceId: null },
          conversationId: null,
          lastUsedAt: null,
        },
      ],
    });
  await assistant.run(session.ctx);
  expect(session.tables[0]?.rows).toEqual([{ id: "website", title: "example.com", app: "Website", scope: "everywhere", lastUsed: "" }]);
});

test("approvals list labels a missing app separately from a website", async () => {
  const session = context(["approvals", "list"]);
  session.ctx.fetch = async () => Response.json({ approvals: [{ ...session.approval, app: null, website: null }] });
  await assistant.run(session.ctx);
  expect(session.tables[0]?.rows).toEqual([
    { id: "preference", title: "Create task", app: "Cloud AI tool", scope: "everywhere", lastUsed: "2026-10-10T12:00:00Z" },
  ]);
});

test.each(["text", "json", "jsonl"] as const)("approvals revoke needs no --yes and supports %s", async (output) => {
  const session = context(["approvals", "revoke", "approval-id"], output);
  await assistant.run(session.ctx);
  expect(session.requests).toEqual([{ path: "/api/ai/approval-preferences/approval-id", method: "DELETE" }]);
  if (output === "text") expect(session.printed).toEqual(["Revoked approval-id."]);
  else expect(session.values).toEqual([{ deleted: true }]);
});

test.each([
  { flags: ["--allow-bash", "--no-bash"], error: "Pass either --allow-bash or --no-bash." },
  { flags: ["--print", "--allow-bash"], error: "--allow-bash is available only in interactive mode." },
  { flags: ["--print", "--no-bash"], error: "--no-bash is available only in interactive mode." },
])("Bash flags reject conflicting and print-mode use: %j", async ({ flags, error }) => {
  const session = context([]);
  session.ctx.flags = Object.fromEntries(flags.map((flag) => [flag.slice(2), true]));
  await expect(assistant.run(session.ctx)).rejects.toThrow(error);
  expect(session.requests).toEqual([]);
});

test("approvals group has its own summary", () => {
  expect(assistant.help?.()).toContain("List and revoke remembered Cloud approvals");
});
