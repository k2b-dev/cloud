import { describe, expect, test } from "bun:test";
import type { AccessEntry, Principal } from "../contracts";
import { createAccessCommands } from "./access";
import { type CloudCliContext, type CloudCliFlags, type CloudCliOutputMode, defineCliCommands } from "./index";

const userId = "11111111-1111-4111-8111-111111111111";
const accessId = "22222222-2222-4222-8222-222222222222";

const userEntry = (permission: AccessEntry["permission"]): AccessEntry => ({
  id: accessId,
  principal: { type: "user", userId },
  permission,
  displayName: "Valentin Kolb",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const createContext = (
  args: string[],
  flags: CloudCliFlags,
  fetchImpl: (path: string, init?: RequestInit) => Response | Promise<Response>,
  output: CloudCliOutputMode = "text",
) => {
  const lines: string[] = [];
  const tables: Record<string, unknown>[][] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://example.test", token: "token", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => fetchImpl(String(path), init),
    readJson: async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return response.json();
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => void tables.push(rows),
  };
  return { ctx, lines, tables };
};

const serviceAccountEntry = (
  id: string,
  displayName: string,
  permission: AccessEntry["permission"],
  serviceAccountKind?: AccessEntry["serviceAccountKind"],
): AccessEntry => ({
  id,
  principal: { type: "service_account", serviceAccountId: id },
  permission,
  displayName,
  serviceAccountKind,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const serviceAccountEntries = (): AccessEntry[] => [
  userEntry("read"),
  serviceAccountEntry("33333333-3333-4333-8333-333333333333", "Release agent", "write", "agent"),
  serviceAccountEntry("44444444-4444-4444-8444-444444444444", "CI export", "read", "standalone"),
  serviceAccountEntry("55555555-5555-4555-8555-555555555555", "Roadmap API access", "write", "resource_bound"),
  serviceAccountEntry("66666666-6666-4666-8666-666666666666", "Unknown Service Account", "read"),
];

const tableSummary = (rows: Record<string, unknown>[] | undefined) =>
  rows?.map((row) => `${row.principal} | ${row.type} | ${row.permission}`);

const createModule = (
  state: { entries: AccessEntry[]; grants: Principal[]; updates: string[]; revokes: string[] },
  options: { allowAuthenticated?: boolean; allowServiceAccounts?: boolean } = {},
) =>
  defineCliCommands({
    name: "demo",
    summary: "Demo commands",
    commands: createAccessCommands({
      resourceLabel: "demo",
      resourceArgLabel: "demo",
      allowAuthenticated: options.allowAuthenticated,
      allowServiceAccounts: options.allowServiceAccounts,
      resolveResource: async (_ctx, args) => ({ id: args[0] ?? "default", label: args[0] ?? "default" }),
      list: async () => state.entries,
      grant: async (_ctx, _resource, principal, permission) => {
        state.grants.push(principal);
        const entry: AccessEntry = { ...userEntry(permission), id: "new-access", principal };
        state.entries.push(entry);
        return entry;
      },
      update: async (_ctx, _resource, id, permission) => {
        state.updates.push(`${id}:${permission}`);
        state.entries = state.entries.map((entry) => (entry.id === id ? { ...entry, permission } : entry));
      },
      revoke: async (_ctx, _resource, id) => {
        state.revokes.push(id);
        state.entries = state.entries.filter((entry) => entry.id !== id);
      },
    }),
  });

describe("access CLI helper", () => {
  test("does not expose public grants unless the adapter allows them", async () => {
    const mod = createModule({ entries: [], grants: [], updates: [], revokes: [] });
    const { ctx, lines } = createContext(["access", "grant"], { help: true }, () => Response.json({}));

    await mod.run(ctx);

    const help = lines.join("\n");
    expect(help).toContain("--authenticated");
    expect(help).not.toContain("--public");
  });

  test("can hide unsupported authenticated-audience grants", async () => {
    const mod = createModule({ entries: [], grants: [], updates: [], revokes: [] }, { allowAuthenticated: false });
    const { ctx, lines } = createContext(["access", "grant"], { help: true }, () => Response.json({}));

    await mod.run(ctx);

    expect(lines.join("\n")).not.toContain("--authenticated");
  });

  test("set resolves a principal and updates an existing direct grant", async () => {
    const state = { entries: [userEntry("read")], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "set", "resource-a"], { user: "valentin.kolb", permission: "admin" }, (path) => {
      expect(path).toContain("/api/accounts/entities");
      return Response.json({
        items: [{ kind: "user", user: { id: userId, uid: "valentin.kolb", displayName: "Valentin Kolb", mail: "valentin@example.test" } }],
        pagination: { has_next: false },
      });
    });

    await mod.run(ctx);

    expect(state.grants).toEqual([]);
    expect(state.updates).toEqual([`${accessId}:admin`]);
  });

  test("emits access list output as JSONL when requested", async () => {
    const state = { entries: [userEntry("read")], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx, lines } = createContext(["access", "list", "resource-a"], {}, () => Response.json({}), "jsonl");

    await mod.run(ctx);

    expect(lines).toEqual([JSON.stringify({ resource: { id: "resource-a", label: "resource-a" }, entries: state.entries })]);
  });

  test("access list table shows standalone and agent service accounts and hides resource-bound ones", async () => {
    const state = { entries: serviceAccountEntries(), grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state, { allowServiceAccounts: true });
    const { ctx, tables } = createContext(["access", "list", "resource-a"], {}, () => Response.json({}));

    await mod.run(ctx);

    expect(tableSummary(tables[0])).toEqual([
      "Release agent | agent | write",
      "CI export | service account | read",
      "Unknown Service Account | service account | read",
      "Valentin Kolb | user | read",
    ]);
  });

  test("access list table includes resource-bound service accounts on request", async () => {
    const state = { entries: serviceAccountEntries(), grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state, { allowServiceAccounts: true });
    const { ctx, tables } = createContext(["access", "list", "resource-a"], { "include-service-accounts": true }, () => Response.json({}));

    await mod.run(ctx);

    expect(tableSummary(tables[0])).toEqual([
      "Release agent | agent | write",
      "Roadmap API access | resource-bound | write",
      "CI export | service account | read",
      "Unknown Service Account | service account | read",
      "Valentin Kolb | user | read",
    ]);
  });

  test("uuid principal refs are used directly instead of entity search", async () => {
    const state = { entries: [userEntry("read")], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "set", "resource-a"], { user: userId, permission: "write" }, () => {
      throw new Error("uuid refs should not call entity search");
    });

    await mod.run(ctx);

    expect(state.updates).toEqual([`${accessId}:write`]);
  });

  test("set creates a grant when no direct grant exists", async () => {
    const state = { entries: [], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "set", "resource-a"], { user: "valentin.kolb", permission: "read" }, () =>
      Response.json({
        items: [{ kind: "user", user: { id: userId, uid: "valentin.kolb", displayName: "Valentin Kolb", mail: "valentin@example.test" } }],
        pagination: { has_next: false },
      }),
    );

    await mod.run(ctx);

    expect(state.grants).toEqual([{ type: "user", userId }]);
    expect(state.updates).toEqual([]);
  });

  test("revoke requires explicit confirmation", async () => {
    const state = { entries: [userEntry("read")], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "revoke", "resource-a"], { "access-id": accessId }, () => Response.json({}));

    await expect(mod.run(ctx)).rejects.toThrow("Refusing to revoke access without --yes.");
    expect(state.revokes).toEqual([]);
  });

  test("revoke rejects mixing access id and principal flags", async () => {
    const state = { entries: [userEntry("read")], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "revoke", "resource-a"], { "access-id": accessId, user: userId, yes: true }, () =>
      Response.json({}),
    );

    await expect(mod.run(ctx)).rejects.toThrow("Pass either --access-id or one principal flag, not both.");
    expect(state.revokes).toEqual([]);
  });

  test("search principals rejects service accounts unless enabled", async () => {
    const state = { entries: [], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state);
    const { ctx } = createContext(["access", "search-principals", "svc"], { kind: "service_account" }, () => Response.json({}));

    await expect(mod.run(ctx)).rejects.toThrow("--kind must contain only: user, group.");
  });

  test("search principals allows service accounts when enabled", async () => {
    const state = { entries: [], grants: [] as Principal[], updates: [] as string[], revokes: [] as string[] };
    const mod = createModule(state, { allowServiceAccounts: true });
    let requestedPath = "";
    const { ctx } = createContext(["access", "search-principals", "svc"], { kind: "service_account" }, (path) => {
      requestedPath = path;
      return Response.json({ items: [], pagination: { has_next: false } });
    });

    await mod.run(ctx);

    expect(requestedPath).toContain("kinds=service_account");
  });
});
