import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags } from "@valentinkolb/cloud/cli";
import faqCli from "./cli";

type FetchCall = {
  path: string;
  init?: RequestInit;
};

const entry = {
  id: "019d0000-0000-7000-8000-000000000001",
  translations: {
    en: { question: "What is Cloud?", answer: "A platform." },
    de: { question: "Was ist Cloud?", answer: "Eine Plattform." },
  },
  audience: ["anonymous", "guest"],
  position: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = []) => {
  const calls: FetchCall[] = [];
  const json: unknown[] = [];
  const tables: unknown[][] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : response.statusText);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => json.push(value),
    jsonLine: (value) => json.push(value),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, json, tables, lines };
};

describe("FAQ CLI", () => {
  test("lists localized FAQ entries", async () => {
    const { ctx, calls, tables } = createContext(["list"], {}, [Response.json({ entries: [entry] })]);

    await faqCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/faq");
    expect(tables[0]).toEqual([
      {
        position: 0,
        question: "What is Cloud?",
        locales: "en,de",
        audience: "anonymous,guest",
        id: entry.id,
      },
    ]);
  });

  test("creates an entry through the FAQ API", async () => {
    const translations = JSON.stringify(entry.translations);
    const { ctx, calls } = createContext(["create"], { translations, audience: "anonymous,guest" }, [Response.json(entry)]);

    await faqCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/faq");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      translations: entry.translations,
      audience: ["anonymous", "guest"],
    });
  });

  test("rejects empty updates before calling the API", async () => {
    const { ctx, calls } = createContext(["update", entry.id]);

    await expect(faqCli.run(ctx)).rejects.toThrow("Pass --translations");
    expect(calls).toHaveLength(0);
  });

  test("guards deletion and sends the complete reorder list", async () => {
    const guarded = createContext(["delete", entry.id]);
    await expect(faqCli.run(guarded.ctx)).rejects.toThrow("without --yes");
    expect(guarded.calls).toHaveLength(0);

    const reordered = createContext(["reorder", entry.id], {}, [Response.json({ message: "FAQ entries reordered." })]);
    await faqCli.run(reordered.ctx);
    expect(reordered.calls[0]?.path).toBe("/api/faq/reorder");
    expect(reordered.calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(reordered.calls[0]?.init?.body))).toEqual({ ids: [entry.id] });
  });
});
