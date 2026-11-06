import { expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import chat from "./cli";

const state = { level: "all", choice: null, until: null, defaultLevel: "all", following: null };
const fixture = (args: string[], flags: CloudCliFlags = {}, output: CloudCliOutputMode = "text") => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const lines: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "fixture", server: "https://cloud.example.test", token: "fixture", output, locale: "de" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      calls.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Response.json(path.endsWith("/follow") ? { following: init?.method === "PUT" } : state);
    },
    readJson: (response) => response.json(),
    print: (value) => {
      lines.push(value);
    },
    error: (value) => {
      lines.push(value);
    },
    write: async (value) => {
      lines.push(value);
    },
    json: (value) => {
      lines.push(value);
    },
    jsonLine: (value) => {
      lines.push(value);
    },
    table: () => {},
  };
  return { ctx, calls, lines };
};
test("notify reads or saves a strict choice, localizes text, and preserves structured modes", async () => {
  for (const mode of ["text", "json", "jsonl"] as const) {
    const f = fixture(["notify", "Chat01"], {}, mode);
    await chat.run(f.ctx);
    expect(f.calls).toEqual([{ path: "/api/chat/conversations/Chat01/notifications", method: "GET", body: null }]);
    expect(f.lines).toEqual([mode === "text" ? "Benachrichtigungen: Alle Nachrichten (Standard)" : state]);
  }
  for (const level of ["all", "mentions", "default", "off"]) {
    const f = fixture(["notify", "Chat01", level]);
    await chat.run(f.ctx);
    expect(f.calls[0]?.body).toEqual(level === "off" ? { level: "none", for: "forever" } : { level });
  }
  const f = fixture(["notify", "Chat01", "off"], { for: "8h" });
  await chat.run(f.ctx);
  expect(f.calls[0]?.body).toEqual({ level: "none", for: "8h" });
  for (const args of [
    ["notify", "Chat01"],
    ["notify", "Chat01", "all"],
  ]) {
    const invalid = fixture(args, { for: "1h" });
    await expect(chat.run(invalid.ctx)).rejects.toThrow("Nutze --for nur mit off");
    expect(invalid.calls).toHaveLength(0);
  }
});
test("follow commands share the HTTP contract and localized help changes nothing", async () => {
  for (const verb of ["follow", "unfollow"]) {
    const f = fixture([verb, "Chat01", "Item01"], {}, "jsonl");
    await chat.run(f.ctx);
    expect(f.calls).toEqual([
      { path: "/api/chat/conversations/Chat01/threads/Item01/follow", method: verb === "follow" ? "PUT" : "DELETE", body: null },
    ]);
    expect(f.lines).toEqual([{ following: verb === "follow" }]);
  }
  expect(chat.help("de")).toContain("Benachrichtigungen");
});
