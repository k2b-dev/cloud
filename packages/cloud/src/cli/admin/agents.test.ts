import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "../index";
import { AGENT_CLIENT_SCOPES, agentCommands } from "./agents";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release agent",
  kind: "agent",
  status: "active",
  createdBy: null,
  createdAt: "2026-11-03T00:00:00Z",
};
const key = {
  id: "22222222-2222-4222-8222-222222222222",
  serviceAccountId: agent.id,
  name: "Automation",
  status: "active",
  tokenPrefix: "cld_fixture",
  scopes: ["read", "write", "admin"],
  createdAt: "2026-11-03T00:00:00Z",
  expiresAt: null,
  lastUsedAt: null,
};
const page = (items = [key]) => ({ items, page: 1, perPage: 100, total: items.length, hasNext: false });
const keysPath = `/api/admin/identity/service-accounts/${agent.id}/api-keys`;
const fixture = (
  args: string[],
  flags: CloudCliFlags = {},
  output: CloudCliOutputMode = "text",
  locale = "en",
  respond?: (path: string, method: string) => unknown,
) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const printed: unknown[] = [];
  const saved: unknown[] = [];
  const ctx: CloudCliContext = {
    args: ["agents", ...args],
    flags,
    options: { profile: "test", server: "https://cloud.example.test", token: "test", output, locale },
    getDefault: async () => undefined,
    setDefault: async () => {},
    profiles: {
      saveClientCredentials: async (input) => {
        saved.push(input);
      },
    },
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      const method = init?.method ?? "GET";
      requests.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (respond) return Response.json(respond(path, method));
      if (method === "DELETE") return Response.json({ message: "API key revoked." });
      if (path.endsWith("/api-keys") && method === "POST") return Response.json({ credential: key, token: "fictional-one-time-token" });
      if (path.includes("/api-keys")) return Response.json(page());
      if (path === "/api/oauth/admin/clients")
        return Response.json({
          id: "client",
          clientId: "oauth-client",
          clientSecret: "fictional-client-secret",
          name: "Agent client",
          scopes: [...AGENT_CLIENT_SCOPES],
        });
      if (method === "POST" || path.endsWith(agent.id)) return Response.json(agent);
      return Response.json({ items: [agent], page: 1, perPage: 50, total: 1, hasNext: false });
    },
    readJson: (response) => response.json(),
    print: (value) => {
      printed.push(value);
    },
    write: async () => {},
    error: () => {},
    json: (value) => {
      printed.push(value);
    },
    jsonLine: (value) => {
      printed.push(value);
    },
    table: (rows, columns) => {
      printed.push(
        rows.map((row) => Object.fromEntries(columns.map((column) => [column.key, column.value ? column.value(row) : row[column.key]]))),
      );
    },
  };
  return { requests, printed, saved, run: () => defineCliCommands({ name: "admin", summary: "Agents", commands: agentCommands }).run(ctx) };
};

for (const mode of ["text", "json", "jsonl"] as const)
  test(`agent key create omits scopes and prints the token exactly once in ${mode}`, async () => {
    const f = fixture(["keys", "create", "Release agent"], { name: "Automation", expires: "2027-01-01T00:00:00Z" }, mode);
    await f.run();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toEqual({
      path: `/api/admin/identity/service-accounts/${agent.id}/api-keys`,
      method: "POST",
      body: { name: "Automation", access: "full", expiresAt: "2027-01-01T00:00:00Z" },
    });
    expect(f.printed).toEqual(mode === "text" ? ["fictional-one-time-token"] : [{ credential: key, token: "fictional-one-time-token" }]);
    expect(JSON.stringify(f.printed).split("fictional-one-time-token")).toHaveLength(2);
  });

test("agent key create resolves an ID and preserves models-only access", async () => {
  const f = fixture(["keys", "create", agent.id], { name: "Models", models: true });
  await f.run();
  expect(f.requests[0]?.path).toBe(`/api/admin/identity/service-accounts/${agent.id}`);
  expect(f.requests[1]?.body).toEqual({ name: "Models", access: "models" });
  const missing = fixture(["keys", "create", agent.id]);
  await expect(missing.run()).rejects.toThrow("--name");
  expect(missing.requests).toEqual([]);
  const scoped = fixture(["keys", "create", agent.id], { name: "No scopes", scopes: "read" });
  await expect(scoped.run()).rejects.toThrow();
  expect(scoped.requests).toEqual([]);
});

test("agent references reject ambiguous names and non-agents before issuing a key", async () => {
  for (const result of [
    { items: [agent, { ...agent, id: "other" }], page: 1, perPage: 50, total: 2, hasNext: false },
    { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
  ]) {
    const f = fixture(["keys", "create", agent.name], { name: "Automation" }, "text", "en", () => result);
    await expect(f.run()).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  }
  const f = fixture(["keys", "create", agent.id], { name: "Automation" }, "text", "en", () => ({ ...agent, kind: "standalone" }));
  await expect(f.run()).rejects.toThrow("not an agent");
  expect(f.requests).toHaveLength(1);
});

for (const mode of ["text", "json", "jsonl"] as const)
  test(`agent keys list includes limits and metadata in ${mode}`, async () => {
    const credentials = [
      key,
      { ...key, id: "limited", scopes: ["read"] },
      { ...key, id: "empty", scopes: [] },
      { ...key, id: "models", scopes: ["ai:inference"] },
    ];
    const f = fixture(["keys", "list", agent.id], { page: "2", "per-page": "10" }, mode, "en", (path) =>
      path.includes("/api-keys") ? page(credentials) : agent,
    );
    await f.run();
    expect(f.requests[1]?.path).toBe(`${keysPath}?page=2&perPage=10`);
    const rows = credentials.map((item, i) => ({ ...item, access: ["full", "legacy, limited", "legacy, limited", "models"][i] }));
    expect(f.printed).toEqual([
      mode === "text" ? rows.map(({ scopes: _, serviceAccountId: __, ...row }) => row) : { ...page(credentials), items: rows },
    ]);
    expect(JSON.stringify(f.printed)).not.toContain("fictional-one-time-token");
  });

test("agent key revoke requires confirmation before requests and revokes through the agent's own route", async () => {
  const no = fixture(["keys", "revoke", agent.id, key.id], {}, "text", "de");
  await expect(no.run()).rejects.toThrow("erfordert --yes");
  expect(no.requests).toEqual([]);
  const invalid = fixture(["keys", "revoke", agent.id, "invalid"], { yes: true });
  await expect(invalid.run()).rejects.toThrow();
  expect(invalid.requests).toEqual([]);
  const revoked = fixture(["keys", "revoke", agent.id, key.id], { yes: true }, "json", "en", (_path, method) =>
    method === "DELETE" ? { revoked: true } : agent,
  );
  await revoked.run();
  expect(revoked.requests).toHaveLength(2);
  expect(revoked.requests[1]).toEqual({ path: `${keysPath}/${key.id}`, method: "DELETE", body: null });
  expect(revoked.printed).toEqual([{ revoked: true }]);
});

test("new agent OAuth clients include admin as a cap without printing their client secret", async () => {
  const f = fixture(["create", agent.name], { profile: "release-agent", yes: true });
  await f.run();
  expect(AGENT_CLIENT_SCOPES).toEqual(["openid", "profile", "email", "offline_access", "read", "write", "admin"]);
  expect(f.requests[1]?.body).toMatchObject({ scopes: [...AGENT_CLIENT_SCOPES], serviceAccountId: agent.id });
  expect(f.saved).toEqual([expect.objectContaining({ scope: AGENT_CLIENT_SCOPES.join(" "), clientSecret: "fictional-client-secret" })]);
  expect(JSON.stringify(f.printed)).not.toContain("fictional-client-secret");
});
