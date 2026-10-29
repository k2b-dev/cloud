import { expect, test } from "bun:test";
import type { AiProjectAccess } from "@k2b/cloud/ai";
import type { CloudCliContext } from "@k2b/cloud/cli";
import assistant from "../cli";

const machineId = "11111111-1111-4111-8111-111111111111";
const entry = (kind: "standalone" | "agent" = "agent"): AiProjectAccess => ({
  id: "Ac2345",
  shortId: "Ac2345",
  principal: { type: "service_account", serviceAccountId: machineId },
  permission: "admin",
  displayName: "Build agent",
  serviceAccountKind: kind,
  createdAt: "1970-01-01T00:00:00.000Z",
});
const session = (
  resource: "projects" | "skills",
  action: string,
  options: {
    flags?: CloudCliContext["flags"];
    recipient?: string;
    entries?: AiProjectAccess[];
    kind?: "standalone" | "agent";
    directory?: "denied" | "ambiguous";
    output?: "text" | "json";
  } = {},
) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const values: unknown[] = [],
    printed: string[] = [];
  const tables: Parameters<CloudCliContext["table"]>[0][] = [];
  const base = `/api/ai/${resource}/Rs2345`;
  const ctx: CloudCliContext = {
    args: [
      resource,
      "access",
      action,
      ...(action === "search-principals" ? ["Build"] : ["Build resources"]),
      ...(options.recipient ? [options.recipient] : []),
    ],
    flags: options.flags ?? {},
    options: { profile: "test", server: "https://cloud.example", token: "fixture", output: options.output ?? "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ path, method, body });
      if (path.startsWith("/api/accounts/entities?")) {
        if (options.directory === "denied") return Response.json({ error: "Directory requires a user-backed identity" }, { status: 403 });
        const principal = {
          kind: "service_account",
          serviceAccount: { id: machineId, name: "Build agent", kind: options.kind ?? "agent" },
        };
        return Response.json({
          items:
            options.directory === "ambiguous"
              ? [principal, { ...principal, serviceAccount: { ...principal.serviceAccount, id: "22222222-2222-4222-8222-222222222222" } }]
              : [principal],
        });
      }
      const item = { id: "Rs2345", shortId: "Rs2345", name: "Build resources", permission: "admin" };
      if (path === "/api/ai/projects") return Response.json({ projects: [item] });
      if (path.startsWith("/api/ai/skills?")) return Response.json({ skills: [item] });
      if (path === base && method === "GET") return Response.json({ skill: item });
      if (path === `${base}/access` && method === "GET") return Response.json({ access: options.entries ?? [entry(options.kind)] });
      if (path === `${base}/access` && method === "POST") return Response.json({ access: entry(options.kind) }, { status: 201 });
      if (path === `${base}/access/Ac2345` && (method === "PATCH" || method === "DELETE")) return Response.json({ updated: true });
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    },
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
    table: (rows) => {
      tables.push(rows);
    },
  };
  return { ctx, requests, values, printed, tables, base };
};

for (const resource of ["projects", "skills"] as const) {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${resource} access resolves ${kind} exact names to UUIDs and returns name/kind`, async () => {
      const run = session(resource, "grant", { kind, flags: { "service-account": "Build agent", permission: "write" } });
      await assistant.run(run.ctx);
      expect(run.requests.find((r) => r.method === "POST")).toEqual({
        path: `${run.base}/access`,
        method: "POST",
        body: { principal: { type: "service_account", serviceAccountId: machineId }, permission: "write" },
      });
      expect(run.values[0]).toMatchObject({ entry: { displayName: "Build agent", serviceAccountKind: kind } });
    });
    test(`${resource} access list displays ${kind} names and kind`, async () => {
      const run = session(resource, "list", { kind, output: "text" });
      await assistant.run(run.ctx);
      expect(run.tables[0]?.[0]).toMatchObject({
        principal: "Build agent",
        type: kind === "agent" ? "agent" : "service account",
        accessId: "Ac2345",
      });
    });
  }
  test(`${resource} UUID grants work without directory access; names preserve directory denial`, async () => {
    const uuid = session(resource, "grant", { directory: "denied", flags: { "service-account": machineId, permission: "read" } });
    await assistant.run(uuid.ctx);
    expect(uuid.requests.some((r) => r.path.startsWith("/api/accounts/"))).toBe(false);
    const name = session(resource, "grant", { directory: "denied", flags: { "service-account": "Build agent", permission: "read" } });
    await expect(assistant.run(name.ctx)).rejects.toThrow("HTTP 403");
    expect(name.requests.some((r) => r.method !== "GET")).toBe(false);
  });
  test(`${resource} refuses ambiguous names before granting`, async () => {
    const run = session(resource, "grant", { directory: "ambiguous", flags: { "service-account": "Build agent", permission: "read" } });
    await expect(assistant.run(run.ctx)).rejects.toThrow("ambiguous");
    expect(run.requests.some((r) => r.method !== "GET")).toBe(false);
  });
  test(`${resource} supports authenticated grants and idempotent set using public access IDs`, async () => {
    const audience = session(resource, "grant", { flags: { authenticated: true, permission: "read" } });
    await assistant.run(audience.ctx);
    expect(audience.requests.at(-1)?.body).toEqual({ principal: { type: "authenticated" }, permission: "read" });
    const update = session(resource, "set", { flags: { "service-account": machineId, permission: "write" } });
    await assistant.run(update.ctx);
    expect(update.requests.at(-1)).toEqual({ path: `${update.base}/access/Ac2345`, method: "PATCH", body: { permission: "write" } });
    expect(update.values[0]).toMatchObject({ action: "updated", accessId: "Ac2345" });
    const create = session(resource, "set", { entries: [], flags: { "service-account": machineId, permission: "read" } });
    await assistant.run(create.ctx);
    expect(create.requests.at(-1)?.method).toBe("POST");
    expect(create.values[0]).toMatchObject({ action: "created" });
  });
  test(`${resource} revocation requires confirmation and supports principal or access ID`, async () => {
    const refused = session(resource, "revoke", { flags: { "access-id": "Ac2345" } });
    await expect(assistant.run(refused.ctx)).rejects.toThrow("--yes");
    expect(refused.requests).toHaveLength(0);
    const choices: CloudCliContext["flags"][] = [
      { "access-id": "Ac2345", yes: true },
      { "service-account": machineId, yes: true },
    ];
    for (const flags of choices) {
      const run = session(resource, "revoke", { flags });
      await assistant.run(run.ctx);
      expect(run.requests.at(-1)).toEqual({ path: `${run.base}/access/Ac2345`, method: "DELETE", body: undefined });
    }
  });
  test(`${resource} searches principals through the shared directory endpoint`, async () => {
    const run = session(resource, "search-principals");
    await assistant.run(run.ctx);
    const url = new URL(run.requests[0]!.path, run.ctx.options.server);
    expect(url.pathname).toBe("/api/accounts/entities");
    expect(url.searchParams.get("kinds")).toBe("user,group,service_account");
    expect(url.searchParams.get("search")).toBe("Build");
  });
}

test("established Project positional grant/update/revoke paths remain supported", async () => {
  const grant = session("projects", "grant", { recipient: machineId, flags: { type: "service_account" } });
  await assistant.run(grant.ctx);
  expect(grant.requests.at(-1)?.body).toEqual({ principal: { type: "service_account", serviceAccountId: machineId }, permission: "read" });
  const update = session("projects", "update", { recipient: "Ac2345", flags: { permission: "write" } });
  await assistant.run(update.ctx);
  expect(update.requests.at(-1)?.method).toBe("PATCH");
  const revoke = session("projects", "revoke", { recipient: "Ac2345", flags: { yes: true } });
  await assistant.run(revoke.ctx);
  expect(revoke.requests.at(-1)?.method).toBe("DELETE");
});
