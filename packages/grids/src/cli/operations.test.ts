import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@valentinkolb/cloud/cli";
import { evidenceCommands } from "./evidence";
import { recordDiscussionCommands } from "./record-discussion";
import { recordEventCommands } from "./record-events";

const commands = [...evidenceCommands, ...recordDiscussionCommands, ...recordEventCommands];
const command = (path: string) => {
  const value = commands.find((item) => item.path.join(" ") === path);
  if (!value) throw new Error(`Missing command: ${path}`);
  return value;
};
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
const record = { table: "TABLE1", record: "REC001" };

describe("Grids operational CLI", () => {
  test("keeps the skill command index aligned with operational commands", async () => {
    const reference = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();
    const index = reference.split("```text").at(-1)!.split("```")[0]!;
    const paths = index.split("\n").flatMap((line) => {
      const parts = line.trim().split(" ");
      const tail = parts.pop() ?? "";
      return tail.split("|").map((verb) => [...parts, verb].join(" "));
    });
    for (const item of commands) expect(paths).toContain(item.path.join(" "));
    expect(reference).toContain("records files list|upload|replace|download|delete");
    expect(reference).not.toMatch(/\\\ncld grids/);
  });
  test("preserves comments pagination and permissions without resolving a Base", async () => {
    const page = { items: [{ id: "COMM01", body: "Hello" }], nextCursor: "next", permissions: { canWrite: false } };
    const { ctx, calls, values } = context([Response.json(page)]);
    await command("records comments list").run({ ctx, args: record, flags: { cursor: "a+b/c", limit: 5 } });
    expect(calls[0]?.path).toBe("/api/grids/records/TABLE1/REC001/comments?cursor=a%2Bb%2Fc&limit=5");
    expect(values).toEqual([page]);
  });
  test("passes comment Markdown unchanged and surfaces authorization failure", async () => {
    const { ctx, calls } = context([Response.json({ message: "Forbidden" }, { status: 403 })]);
    await expect(
      command("records comments create").run({
        ctx,
        args: record,
        flags: { body: { source: "value", value: "First\n**Second**", provided: true } },
      }),
    ).rejects.toThrow("Forbidden");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ body: "First\n**Second**" });
  });
  test("requires deletion confirmation before any request and accepts empty 204", async () => {
    const { ctx, calls, values } = context([new Response(null, { status: 204 })]);
    const args = { ...record, comment: "COMM01" };
    await expect(command("records comments delete").run({ ctx, args, flags: {} })).rejects.toThrow("--yes");
    expect(calls).toHaveLength(0);
    await command("records comments delete").run({ ctx, args, flags: { yes: true } });
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(values).toEqual([{ deleted: true }]);
  });
  test("uses the bounded referenced-by API and validates resource IDs", async () => {
    const { ctx, calls } = context([Response.json({ items: [], nextCursor: null })]);
    await command("records referenced-by").run({ ctx, args: record, flags: { limit: 5, relationField: "FIELD1" } });
    expect(calls[0]?.path).toEndWith("/referenced-by?limit=5&relationFieldId=FIELD1");
    await expect(command("records referenced-by").run({ ctx, args: { ...record, record: "not-an-id" }, flags: {} })).rejects.toThrow(
      "public id",
    );
    expect(calls).toHaveLength(1);
  });
  test("creates evidence only after confirmation with the validated scope", async () => {
    const { ctx, calls } = context([
      Response.json({ items: [{ id: "BASE01", name: "Base" }] }),
      Response.json({ id: "EXP001", status: "queued" }),
    ]);
    const args = { args: [] };
    await expect(command("evidence create").run({ ctx, args, flags: {} })).rejects.toThrow("--yes");
    expect(calls).toHaveLength(0);
    await command("evidence create").run({
      ctx,
      args,
      flags: { yes: true, body: { source: "value", value: '{"tableId":"TABLE1","sections":["records"]}', provided: true } },
    });
    expect(calls[1]?.path).toBe("/api/grids/evidence-exports/by-base/BASE01");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ tableId: "TABLE1", sections: ["records"] });
  });
  test("replay uses the exact retained failure and never invents an event payload", async () => {
    const { ctx, calls } = context([Response.json({ accepted: true }, { status: 202 })]);
    const args = { base: "BASE01", failure: "99999999-9999-4999-8999-999999999999" };
    await expect(command("record-events replay").run({ ctx, args, flags: {} })).rejects.toThrow("--yes");
    await command("record-events replay").run({ ctx, args, flags: { yes: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/api/grids/admin/bases/BASE01/record-event-failures/${args.failure}/replay`);
    expect(calls[0]?.init?.body).toBe("{}");
  });

  test("preflight remains read-only and preserves the scope query", async () => {
    const { ctx, calls } = context([Response.json({ items: [{ id: "BASE01", name: "Base" }] }), Response.json({})]);
    await command("evidence preflight").run({
      ctx,
      args: { args: [] },
      flags: {
        body: {
          source: "value",
          provided: true,
          value: '{"tableId":"TABLE1","sections":["records","files"]}',
        },
      },
    });
    expect(calls[1]?.init?.method).toBeUndefined();
    const url = new URL(calls[1]!.path, "http://cloud.test");
    expect(url.pathname).toEndWith("/preflight");
    expect(url.searchParams.get("tableId")).toBe("TABLE1");
    expect(url.searchParams.get("sections")).toBe("records,files");
  });

  test("evidence state changes require confirmation and preserve returned intermediate states", async () => {
    for (const action of ["retry", "cancel"]) {
      const result = { id: "EXP001", status: action === "retry" ? "queued" : "cancel_requested" };
      const { ctx, calls, values } = context([Response.json(result)]);
      await expect(command(`evidence ${action}`).run({ ctx, args: { id: "EXP001" }, flags: {} })).rejects.toThrow("--yes");
      expect(calls).toHaveLength(0);
      await command(`evidence ${action}`).run({ ctx, args: { id: "EXP001" }, flags: { yes: true } });
      expect(calls[0]?.path).toBe(`/api/grids/evidence-exports/EXP001/${action}`);
      expect(values).toEqual([result]);
    }
  });

  test("comment updates use their own resource route and JSONL retains the complete page", async () => {
    const { ctx, calls, values } = context([
      Response.json({ id: "COMM01", body: "Updated" }),
      Response.json({ items: [], nextCursor: "more" }),
    ]);
    await command("records comments update").run({
      ctx,
      args: { ...record, comment: "COMM01" },
      flags: {
        body: {
          source: "value",
          provided: true,
          value: "Updated",
        },
      },
    });
    expect(calls[0]?.path).toEndWith("/comments/COMM01");
    expect(calls[0]?.init?.method).toBe("PATCH");
    ctx.options.output = "jsonl";
    ctx.json = () => {
      throw new Error("JSONL must use jsonLine");
    };
    await command("records comments list").run({ ctx, args: record, flags: { limit: 5 } });
    expect(values.at(-1)).toEqual({ items: [], nextCursor: "more" });
  });
});
