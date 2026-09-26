import { describe, expect, test } from "bun:test";
import { type CloudCliContext, cliAmbiguityText } from "@k2b/cloud/cli";
import { requirePublicId, resolveBase, resolveNamedResource, resolveRecordFromCommand, resolveTableFromCommand } from "./resources";

const resource = {
  id: "Ab12C3",
  name: "Equipment",
};
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Grids CLI public IDs", () => {
  test("resolves only an exact name or the exact 6-character public id", () => {
    expect(resolveNamedResource([resource], "Equipment", "table")).toBe(resource);
    expect(resolveNamedResource([resource], "Ab12C3", "table")).toBe(resource);
    expect(() => resolveNamedResource([resource], "equipment", "table")).toThrow('Unknown table "equipment"');
    expect(() => resolveNamedResource([resource], "Ab12C", "table")).toThrow("Public ids contain exactly 6");
  });

  test("rejects private UUIDs and validates direct public-id arguments", () => {
    expect(() => resolveNamedResource([resource], uuid, "table")).toThrow("do not accept UUIDs");
    expect(() => resolveNamedResource([resource], "019f0000-0000-7000-8000-000000000001", "table")).toThrow("do not accept UUIDs");
    expect(requirePublicId("Ab12C3", "Table id")).toBe("Ab12C3");
    expect(() => requirePublicId("Ab12C", "Table id")).toThrow("must be a 6-character public id");
    expect(() => requirePublicId(uuid, "Table id")).toThrow("must be a 6-character public id");
  });
});

type Call = { path: string };

const addressContext = (args: string[], flags: Record<string, string> = {}, responses: Response[] = [], defaultBase?: string) => {
  const calls: Call[] = [];
  const ctx = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "json" as const },
    getDefault: async () => defaultBase,
    fetch: async (path: string) => {
      calls.push({ path });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response: Response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.message);
      return value;
    },
  } as unknown as CloudCliContext;
  return { ctx, calls };
};

const base = { id: "bk001A", name: "Bookshop" };
const table = { id: "auth1A", name: "Authors" };
const resolved = (record: string | null = null) => Response.json({ base, table, record: record ? { id: record } : null });

describe("Grids CLI addresses", () => {
  test("a base resolves by ID or exact name through one resolve request", async () => {
    const { ctx, calls } = addressContext([], {}, [Response.json({ base, table: null, record: null })]);
    expect(await resolveBase(ctx, "Bookshop")).toMatchObject(base);
    expect(calls.map((call) => call.path)).toEqual(["/api/grids/resolve?base=Bookshop"]);
  });

  test("a table resolves as <base>:<table>, as a leading base, or in the default base", async () => {
    const address = addressContext(["Team Docs:Q1: Plan", "extra"], {}, [resolved()]);
    expect(await resolveTableFromCommand(address.ctx, address.ctx.args, 1)).toMatchObject({ table, rest: ["extra"] });
    expect(address.calls[0]?.path).toBe("/api/grids/resolve?base=Team+Docs&table=Q1%3A+Plan");

    const leading = addressContext(["Bookshop", "Authors"], {}, [resolved()]);
    await resolveTableFromCommand(leading.ctx, leading.ctx.args);
    expect(leading.calls[0]?.path).toBe("/api/grids/resolve?base=Bookshop&table=Authors");

    const byDefault = addressContext(["Authors"], {}, [resolved()], "bk001A");
    await resolveTableFromCommand(byDefault.ctx, byDefault.ctx.args);
    expect(byDefault.calls[0]?.path).toBe("/api/grids/resolve?base=bk001A&table=Authors");

    const idOnly = addressContext([], { table: "auth1A" }, [resolved()]);
    await resolveTableFromCommand(idOnly.ctx, idOnly.ctx.args);
    expect(idOnly.calls[0]?.path).toBe("/api/grids/resolve?table=auth1A");
  });

  test("a record resolves as <base>:<table>/<id>, as an ID alone, or from [base] <table> <record>", async () => {
    const address = addressContext(["Bookshop:Authors/Rc01Ab"], {}, [resolved("Rc01Ab")]);
    expect(await resolveRecordFromCommand(address.ctx, address.ctx.args)).toMatchObject({ table, recordId: "Rc01Ab", rest: [] });
    expect(address.calls[0]?.path).toBe("/api/grids/resolve?base=Bookshop&table=Authors&record=Rc01Ab");

    const nested = addressContext(["Bookshop:Reports/2026/Rc01Ab"], {}, [resolved("Rc01Ab")]);
    await resolveRecordFromCommand(nested.ctx, nested.ctx.args);
    expect(nested.calls[0]?.path).toBe("/api/grids/resolve?base=Bookshop&table=Reports%2F2026&record=Rc01Ab");

    const idOnly = addressContext(["Rc01Ab", "Name"], {}, [resolved("Rc01Ab")], "bk001A");
    expect(await resolveRecordFromCommand(idOnly.ctx, idOnly.ctx.args, 1)).toMatchObject({ recordId: "Rc01Ab", rest: ["Name"] });
    expect(idOnly.calls[0]?.path).toBe("/api/grids/resolve?record=Rc01Ab");

    const legacy = addressContext(["Bookshop", "Authors", "Rc01Ab"], {}, [resolved("Rc01Ab")]);
    await resolveRecordFromCommand(legacy.ctx, legacy.ctx.args);
    expect(legacy.calls[0]?.path).toBe("/api/grids/resolve?base=Bookshop&table=Authors&record=Rc01Ab");

    const flagged = addressContext([], { record: "Rc01Ab" }, [resolved("Rc01Ab")]);
    await resolveRecordFromCommand(flagged.ctx, flagged.ctx.args);
    expect(flagged.calls[0]?.path).toBe("/api/grids/resolve?record=Rc01Ab");
  });

  test("rejects local paths, table addresses without a record, and UUIDs before any request", async () => {
    const local = addressContext(["./authors.json"]);
    await expect(resolveTableFromCommand(local.ctx, local.ctx.args)).rejects.toThrow("is a local path");
    const noRecord = addressContext(["Bookshop:Authors"]);
    await expect(resolveRecordFromCommand(noRecord.ctx, noRecord.ctx.args)).rejects.toThrow("names no record");
    const badRecord = addressContext(["Bookshop:Authors/42"]);
    await expect(resolveRecordFromCommand(badRecord.ctx, badRecord.ctx.args)).rejects.toThrow("must be a 6-character public id");
    const internal = addressContext([], {}, []);
    await expect(resolveBase(internal.ctx, uuid)).rejects.toThrow("Base references do not accept UUIDs");
    expect([local, noRecord, badRecord, internal].flatMap((item) => item.calls)).toEqual([]);
  });

  test("passes the server's ambiguity message through unchanged", async () => {
    const message = cliAmbiguityText({
      value: "Twin",
      resources: { en: "bases", de: "Basen" },
      candidates: [
        { path: "Twin", id: "Tw01Aa" },
        { path: "Twin", id: "Tw02Bb" },
      ],
    }).en;
    const { ctx } = addressContext([], {}, [Response.json({ message }, { status: 409 })]);
    await expect(resolveBase(ctx, "Twin")).rejects.toThrow(message);
  });
});
