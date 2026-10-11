import { describe, expect, test } from "bun:test";
import account from "./account";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "./index";

function fixture(args: string[], flags: CloudCliFlags = {}, output: CloudCliOutputMode = "text") {
  const lines: string[] = [];
  const tables: Record<string, unknown>[][] = [];
  const calls: { path: string; body: unknown }[] = [];
  const credentials = [
    { id: "full", name: "Full", scopes: [], tokenPrefix: "full-prefix", expiresAt: null, lastUsedAt: null },
    { id: "models", name: "Models", scopes: ["ai:inference"], tokenPrefix: "models-prefix", expiresAt: null, lastUsedAt: null },
  ];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: String(path), body });
      return Response.json(init?.method === "POST" ? { credential: credentials[1], token: "new-token" } : { items: credentials });
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error("request failed");
      return response.json();
    },
    print: (text = "") => lines.push(text),
    error: (text) => lines.push(text),
    write: async (text) => void lines.push(text),
    json: (value) => lines.push(JSON.stringify(value)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => void tables.push(rows),
  };
  return { ctx, lines, tables, calls, credentials };
}
describe("account API key access", () => {
  for (const access of ["full", "models"] as const) {
    test(`creates ${access} keys and prints the models-only instruction when needed`, async () => {
      const f = fixture(["api-keys", "create", "Client"], { access });
      await account.run(f.ctx);
      expect(f.calls[0]).toMatchObject({ path: "/api/me/api-keys", body: { name: "Client", access } });
      expect(f.lines[0]).toContain("Token: new-token");
      expect(f.lines.join("\n").includes("/api/ai/openai/v1")).toBe(access === "models");
    });
  }
  test("defaults to full and rejects invalid access without a request", async () => {
    const f = fixture(["api-keys", "create", "Client"]);
    await account.run(f.ctx);
    expect(f.calls[0]?.body).toMatchObject({ access: "full" });
    const invalid = fixture(["api-keys", "create", "Client"], { access: "other" });
    await expect(account.run(invalid.ctx)).rejects.toThrow();
    expect(invalid.calls).toHaveLength(0);
  });
  test("table includes access while JSON list remains the server payload", async () => {
    const f = fixture(["api-keys", "list"]);
    await account.run(f.ctx);
    expect(f.tables[0]?.map((row) => row.access)).toEqual(["full", "models"]);
    const json = fixture(["api-keys", "list"], {}, "json");
    await account.run(json.ctx);
    expect(JSON.parse(json.lines[0] ?? "")).toEqual({ items: json.credentials });
  });
  test("JSON creation has no extra instruction", async () => {
    const f = fixture(["api-keys", "create", "Client"], { access: "models" }, "json");
    await account.run(f.ctx);
    expect(f.lines).toHaveLength(1);
    expect(JSON.parse(f.lines[0] ?? "")).toEqual({ credential: f.credentials[1], token: "new-token" });
  });
});
