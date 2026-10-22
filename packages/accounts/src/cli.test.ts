import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags } from "@k2b/cloud/cli";
import accountsCli from "./cli";

type FetchCall = {
  path: string;
  init?: RequestInit;
};

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = []) => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const tables: unknown[][] = [];
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
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, lines, tables };
};

const pagination = { page: 1, per_page: 100, total: 1, total_pages: 1, has_next: false };
const user = (overrides: Partial<Record<"id" | "uid" | "displayName" | "mail", string | null>>) => ({
  id: overrides.id ?? "u1",
  uid: overrides.uid ?? "alice",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Alice",
  sn: "Example",
  displayName: overrides.displayName ?? "Alice Example",
  mail: overrides.mail ?? "alice@example.org",
  avatarHash: null,
});
const group = (overrides: Partial<Record<"id" | "name", string>>) => ({
  id: overrides.id ?? "g1",
  provider: "local",
  name: overrides.name ?? "team",
  description: null,
  gidnumber: null,
});

describe("accounts CLI", () => {
  test("guards Linux mutations before resolving accounts", async () => {
    for (const action of ["prepare", "update"]) {
      const { ctx, calls } = createContext(
        ["users", "linux", action, "alice"],
        action === "update" ? { home: "/home/alice", shell: "/bin/bash" } : {},
      );
      await expect(accountsCli.run(ctx)).rejects.toThrow("without --yes");
      expect(calls).toHaveLength(0);
    }
  });

  test("inspects and prepares one identity through the shared admin API", async () => {
    for (const action of ["get", "prepare"]) {
      const result = { id: "u1", state: "prepared" };
      const { ctx, calls, lines } = createContext(["users", "linux", action, "alice"], action === "prepare" ? { yes: true } : {}, [
        jsonResponse({ users: [user({})], pagination }),
        jsonResponse(result),
      ]);
      ctx.options.output = "jsonl";
      await accountsCli.run(ctx);
      expect(calls[1]?.path).toBe("/api/admin/core/linux-identities/users/u1");
      expect(calls[1]?.init?.method).toBe(action === "prepare" ? "POST" : undefined);
      expect(lines).toEqual([JSON.stringify(result)]);
    }
  });

  test("updates home and shell without sending numeric identity fields", async () => {
    const { ctx, calls } = createContext(["users", "linux", "update", "alice"], { yes: true, home: "/srv/home/alice", shell: "/bin/sh" }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ state: "prepared" }),
    ]);
    await accountsCli.run(ctx);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ homeDirectory: "/srv/home/alice", loginShell: "/bin/sh" });
  });

  test("propagates denied identity preparation without printing success or retrying", async () => {
    const { ctx, calls, lines } = createContext(["users", "linux", "prepare", "alice"], { yes: true }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ message: "Administrator required" }, 403),
    ]);
    await expect(accountsCli.run(ctx)).rejects.toThrow("Administrator required");
    expect(calls).toHaveLength(2);
    expect(lines).toHaveLength(0);
  });

  test("uses the same group POSIX operation for both providers", async () => {
    for (const provider of ["local", "ipa"]) {
      const { ctx, calls } = createContext(["groups", "make-posix", "team"], { yes: true }, [
        jsonResponse({ groups: [{ ...group({}), provider }], pagination }),
        jsonResponse({ gidNumber: 200000, message: "Prepared" }),
      ]);
      await accountsCli.run(ctx);
      expect(calls[1]?.path).toBe("/api/accounts/groups/g1/posix");
      expect(calls[1]?.init?.method).toBe("PUT");
    }
  });

  test("lists personal Linux groups only with --include-personal and names their owner", async () => {
    const personal = {
      ...group({ id: "g2", name: "qdt" }),
      gidnumber: 200001,
      personalOwner: { id: "u1", uid: "qdt", displayName: "Quinn" },
    };
    const hidden = createContext(["groups", "list"], {}, [jsonResponse({ groups: [{ ...group({}), personalOwner: null }], pagination })]);
    await accountsCli.run(hidden.ctx);
    expect(hidden.calls[0]?.path).toBe("/api/accounts/groups?page=1&per_page=50&scope=member");

    const shown = createContext(["groups", "list"], { "include-personal": true, scope: "all" }, [
      jsonResponse({ groups: [personal], pagination }),
    ]);
    await accountsCli.run(shown.ctx);
    expect(shown.calls[0]?.path).toBe("/api/accounts/groups?page=1&per_page=50&scope=all&include_personal=true");
    expect(shown.tables[0]).toEqual([expect.objectContaining({ name: "qdt", personal: "qdt" })]);
  });

  test("creates a local POSIX group in one request", async () => {
    const { ctx, calls } = createContext(["groups", "create", "staff"], { provider: "local", posix: true }, [
      jsonResponse({ ...group({ name: "staff" }), provider: "local", gidnumber: 200000 }),
    ]);
    await accountsCli.run(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/accounts/groups");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ provider: "local", name: "staff", posix: true });
  });

  test("lists users through the accounts API with filters", async () => {
    const { ctx, calls, tables } = createContext(
      ["users", "list"],
      { page: "2", "per-page": "3", q: "alice", provider: "local", profile: "user" },
      [
        jsonResponse({
          users: [
            {
              id: "u1",
              uid: "alice",
              roles: ["user"],
              provider: "local",
              profile: "user",
              givenname: "Alice",
              sn: "Example",
              displayName: "Alice Example",
              mail: "alice@example.org",
              avatarHash: null,
            },
          ],
          pagination: { page: 2, per_page: 3, total: 1, total_pages: 1, has_next: false },
        }),
      ],
    );

    await accountsCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/accounts/users?page=2&per_page=3&search=alice&provider=local&profile=user");
    expect(tables[0]).toEqual([
      {
        uid: "alice",
        name: "Alice Example",
        email: "alice@example.org",
        provider: "local",
        profile: "user",
        roles: "user",
        id: "u1",
      },
    ]);
  });

  test("lists and revokes a user's paired sign-in devices through the accounts API", async () => {
    const devices = createContext(["users", "devices", "list", "alice"], {}, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({
        devices: [
          {
            id: "d1",
            name: "Phone",
            createdAt: "2026-09-01T10:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
            assisted: true,
          },
        ],
      }),
    ]);
    await accountsCli.run(devices.ctx);
    expect(devices.calls.map((call) => call.path)).toEqual([
      "/api/accounts/users?page=1&per_page=100&search=alice",
      "/api/accounts/users/u1/devices",
    ]);
    expect(devices.tables[0]).toEqual([{ name: "Phone", pairedAt: "2026-09-01T10:00:00.000Z", lastUsedAt: "", assisted: "yes", id: "d1" }]);

    const deviceId = "33333333-3333-4333-8333-333333333333";
    const unconfirmed = createContext(["users", "devices", "revoke", "alice", deviceId], {}, []);
    await expect(accountsCli.run(unconfirmed.ctx)).rejects.toThrow("without --yes");
    expect(unconfirmed.calls).toHaveLength(0);
    const byName = createContext(["users", "devices", "revoke", "alice", "Phone"], { yes: true }, []);
    await expect(accountsCli.run(byName.ctx)).rejects.toThrow("device ID");
    expect(byName.calls).toHaveLength(0);

    const revoke = createContext(["users", "devices", "revoke", "alice", deviceId], { yes: true }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ message: "Device revoked." }),
    ]);
    await accountsCli.run(revoke.ctx);
    expect(revoke.calls[1]?.path).toBe(`/api/accounts/users/u1/devices/${deviceId}`);
    expect(revoke.calls[1]?.init?.method).toBe("DELETE");
    expect(revoke.lines).toEqual(["Device revoked."]);
  });

  test("lists and removes a user's phones in the mobile app through the accounts API", async () => {
    const device = {
      id: "p1",
      name: "iPhone",
      platform: "ios",
      createdAt: "2026-10-01T08:00:00.000Z",
      lastUsedAt: "2026-10-05T00:00:00.000Z",
      current: false,
    };
    const list = createContext(["users", "app-devices", "list", "alice"], {}, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ devices: [device] }),
    ]);
    await accountsCli.run(list.ctx);
    expect(list.calls.map((call) => call.path)).toEqual([
      "/api/accounts/users?page=1&per_page=100&search=alice",
      "/api/accounts/users/u1/app-devices",
    ]);
    expect(list.tables[0]).toEqual([
      { name: "iPhone", platform: "ios", pairedAt: "2026-10-01T08:00:00.000Z", lastUsedAt: "2026-10-05T00:00:00.000Z", id: "p1" },
    ]);

    // JSON output is the full API response, not the table projection.
    const json = createContext(["users", "app-devices", "list", "alice"], {}, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ devices: [device] }),
    ]);
    json.ctx.options.output = "json";
    await accountsCli.run(json.ctx);
    expect(JSON.parse(json.lines[0]!)).toEqual({ devices: [device] });

    const deviceId = "44444444-4444-4444-8444-444444444444";
    const unconfirmed = createContext(["users", "app-devices", "remove", "alice", deviceId], {}, []);
    await expect(accountsCli.run(unconfirmed.ctx)).rejects.toThrow("without --yes");
    expect(unconfirmed.calls).toHaveLength(0);
    const byName = createContext(["users", "app-devices", "remove", "alice", "iPhone"], { yes: true }, []);
    await expect(accountsCli.run(byName.ctx)).rejects.toThrow("device ID");
    expect(byName.calls).toHaveLength(0);

    const remove = createContext(["users", "app-devices", "remove", "alice", deviceId], { yes: true }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ revoked: true }),
    ]);
    await accountsCli.run(remove.ctx);
    expect(remove.calls[1]?.path).toBe(`/api/accounts/users/u1/app-devices/${deviceId}`);
    expect(remove.calls[1]?.init?.method).toBe("DELETE");
    expect(remove.lines).toEqual(["Phone removed."]);

    const again = createContext(["users", "app-devices", "remove", "alice", deviceId], { yes: true }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ revoked: false }),
    ]);
    again.ctx.options.output = "json";
    await accountsCli.run(again.ctx);
    expect(JSON.parse(again.lines[0]!)).toEqual({ revoked: false });
  });

  test("guards destructive user mutations before resolving refs", async () => {
    const { ctx, calls } = createContext(["users", "set-admin", "alice"], { enabled: true }, []);

    await expect(accountsCli.run(ctx)).rejects.toThrow("without --yes");
    expect(calls).toHaveLength(0);
  });

  test("adds group members through the user-accessible group relation endpoint", async () => {
    const { ctx, calls, lines } = createContext(["groups", "members", "add", "team"], { user: "alice", yes: true }, [
      jsonResponse({
        groups: [{ id: "g1", provider: "local", name: "team", description: null, gidnumber: null }],
        pagination,
      }),
      jsonResponse({
        items: [
          {
            kind: "user",
            user: {
              id: "u1",
              uid: "alice",
              roles: ["user"],
              provider: "local",
              profile: "user",
              givenname: "Alice",
              sn: "Example",
              displayName: "Alice Example",
              mail: "alice@example.org",
              avatarHash: null,
            },
          },
        ],
        pagination,
      }),
      jsonResponse({ message: "User added as member." }),
    ]);

    await accountsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      "/api/accounts/groups?page=1&per_page=100&search=team&scope=all&include_personal=true",
      "/api/accounts/entities?page=1&per_page=100&search=alice&kinds=user",
      "/api/accounts/groups/g1/members",
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ type: "user", id: "u1" });
    expect(lines).toEqual(["User added as member."]);
  });

  test("filters service account keys by resolved user", async () => {
    const { ctx, calls } = createContext(["service-accounts", "list"], { user: "alice" }, [
      jsonResponse({
        users: [
          {
            id: "u1",
            uid: "alice",
            roles: ["user"],
            provider: "local",
            profile: "user",
            givenname: "Alice",
            sn: "Example",
            displayName: "Alice Example",
            mail: "alice@example.org",
            avatarHash: null,
          },
        ],
        pagination,
      }),
      jsonResponse({ credentials: [], pagination: { page: 1, per_page: 50, total: 0, total_pages: 0, has_next: false } }),
    ]);

    await accountsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      "/api/accounts/users?page=1&per_page=100&search=alice",
      "/api/accounts/service-accounts?page=1&per_page=50&userId=u1",
    ]);
  });

  test("detects exact user matches across all pages before resolving", async () => {
    const { ctx, calls } = createContext(["service-accounts", "list"], { user: "Sam Example" }, [
      jsonResponse({
        users: [user({ id: "u1", uid: "sam.one", displayName: "Sam Example", mail: "sam.one@example.org" })],
        pagination: { page: 1, per_page: 100, total: 2, total_pages: 2, has_next: true },
      }),
      jsonResponse({
        users: [user({ id: "u2", uid: "sam.two", displayName: "Sam Example", mail: "sam.two@example.org" })],
        pagination: { page: 2, per_page: 100, total: 2, total_pages: 2, has_next: false },
      }),
    ]);

    await expect(accountsCli.run(ctx)).rejects.toThrow('User "Sam Example" is ambiguous');
    expect(calls.map((call) => call.path)).toEqual([
      "/api/accounts/users?page=1&per_page=100&search=Sam+Example",
      "/api/accounts/users?page=2&per_page=100&search=Sam+Example",
    ]);
  });

  test("detects exact user entity matches across all pages before group mutations", async () => {
    const { ctx, calls } = createContext(["groups", "members", "add", "team"], { user: "Sam Example", yes: true }, [
      jsonResponse({ groups: [group({ id: "g1", name: "team" })], pagination }),
      jsonResponse({
        items: [{ kind: "user", user: user({ id: "u1", uid: "sam.one", displayName: "Sam Example", mail: "sam.one@example.org" }) }],
        pagination: { page: 1, per_page: 100, total: 2, total_pages: 2, has_next: true },
      }),
      jsonResponse({
        items: [{ kind: "user", user: user({ id: "u2", uid: "sam.two", displayName: "Sam Example", mail: "sam.two@example.org" }) }],
        pagination: { page: 2, per_page: 100, total: 2, total_pages: 2, has_next: false },
      }),
    ]);

    await expect(accountsCli.run(ctx)).rejects.toThrow('User "Sam Example" is ambiguous');
    expect(calls.map((call) => call.path)).toEqual([
      "/api/accounts/groups?page=1&per_page=100&search=team&scope=all&include_personal=true",
      "/api/accounts/entities?page=1&per_page=100&search=Sam+Example&kinds=user",
      "/api/accounts/entities?page=2&per_page=100&search=Sam+Example&kinds=user",
    ]);
  });

  test("detects exact group matches across all pages before resolving", async () => {
    const { ctx, calls } = createContext(["groups", "members", "list", "team"], {}, [
      jsonResponse({
        groups: [group({ id: "g1", name: "team" })],
        pagination: { page: 1, per_page: 100, total: 2, total_pages: 2, has_next: true },
      }),
      jsonResponse({
        groups: [group({ id: "g2", name: "team" })],
        pagination: { page: 2, per_page: 100, total: 2, total_pages: 2, has_next: false },
      }),
    ]);

    await expect(accountsCli.run(ctx)).rejects.toThrow('Group "team" is ambiguous');
    expect(calls.map((call) => call.path)).toEqual([
      "/api/accounts/groups?page=1&per_page=100&search=team&scope=all&include_personal=true",
      "/api/accounts/groups?page=2&per_page=100&search=team&scope=all&include_personal=true",
    ]);
  });

  test("creates local full accounts without --email and leaves the policy to the server", async () => {
    const { ctx, calls } = createContext(["users", "create"], { provider: "local", "given-name": "Ada", sn: "Lovelace" }, [
      jsonResponse({ id: "u1", uid: "ada", accountExpires: null, notificationSent: false }, 201),
    ]);
    await accountsCli.run(ctx);
    expect(calls[0]?.path).toBe("/api/accounts/users");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({ provider: "local", profile: "user", givenname: "Ada", sn: "Lovelace" });
    expect(body).not.toHaveProperty("email");

    const ipa = createContext(["users", "create"], { provider: "ipa", "given-name": "Ada", sn: "Lovelace" });
    await expect(accountsCli.run(ipa.ctx)).rejects.toThrow("FreeIPA accounts need --email.");
    expect(ipa.calls).toHaveLength(0);
  });

  test("removes an email with --remove-email and rejects combining it with --mail", async () => {
    const { ctx, calls } = createContext(["users", "update", "alice"], { "remove-email": true }, [
      jsonResponse({ users: [user({})], pagination }),
      jsonResponse({ message: "User updated." }),
    ]);
    await accountsCli.run(ctx);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ mail: null });

    const both = createContext(["users", "update", "alice"], { "remove-email": true, mail: "a@example.org" });
    await expect(accountsCli.run(both.ctx)).rejects.toThrow("Use either --mail or --remove-email.");
    expect(both.calls).toHaveLength(0);
  });

  test("validates avatar input before resolving the user", async () => {
    const { ctx, calls } = createContext(["users", "avatar", "set", "alice"], {}, []);

    await expect(accountsCli.run(ctx)).rejects.toThrow("Missing avatar input");
    expect(calls).toHaveLength(0);
  });
});

describe("local group machine recipients", () => {
  for (const kind of ["standalone", "agent"] as const) {
    for (const action of ["add", "remove"] as const) {
      test(`${action} resolves a named ${kind} and sends its identity to the member API`, async () => {
        const recipient = { id: "11111111-1111-4111-8111-111111111111", name: "Named worker", kind, status: "active" };
        const { ctx, calls } = createContext(["groups", "members", action, "team"], { "service-account": recipient.name, yes: true }, [
          jsonResponse({ groups: [group({})], pagination }),
          jsonResponse({ items: [{ kind: "service_account", serviceAccount: recipient }], pagination }),
          jsonResponse({ message: "Changed" }),
        ]);
        await accountsCli.run(ctx);
        expect(calls[1]?.path).toContain("search=Named+worker&kinds=service_account");
        expect(calls[2]?.path).toBe("/api/accounts/groups/g1/members");
        expect(calls[2]?.init?.method).toBe(action === "add" ? "POST" : "DELETE");
        expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ type: "service_account", id: recipient.id });
      });
    }
  }
  test("ambiguous names across pages cannot mutate group membership", async () => {
    const machine = (id: string) => ({ kind: "service_account", serviceAccount: { id, name: "Worker", kind: "agent", status: "active" } });
    const { ctx, calls } = createContext(["groups", "members", "add", "team"], { "service-account": "Worker", yes: true }, [
      jsonResponse({ groups: [group({})], pagination }),
      jsonResponse({ items: [machine("one")], pagination: { ...pagination, has_next: true } }),
      jsonResponse({ items: [machine("two")], pagination: { ...pagination, page: 2 } }),
    ]);
    await expect(accountsCli.run(ctx)).rejects.toThrow("ambiguous");
    expect(calls).toHaveLength(3);
  });
  test("a UUID reference uses exact machine filtering", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { ctx, calls } = createContext(["groups", "members", "remove", "team"], { "service-account": id, yes: true }, [
      jsonResponse({ groups: [group({})], pagination }),
      jsonResponse({
        items: [{ kind: "service_account", serviceAccount: { id, name: "Worker", kind: "agent", status: "disabled" } }],
        pagination,
      }),
      jsonResponse({ message: "Removed" }),
    ]);
    await accountsCli.run(ctx);
    expect(calls[1]?.path).toContain(`service_account_ids=${id}`);
  });
});

test("group member tables preserve named machine account kinds and directness", async () => {
  for (const kind of ["standalone", "agent"] as const) {
    const { ctx, calls, tables } = createContext(["groups", "members", "list", "team"], { type: "service_account", recursive: true }, [
      jsonResponse({ groups: [group({})], pagination }),
      jsonResponse({
        items: [
          {
            kind: "service_account",
            serviceAccount: { id: "machine", name: "Named worker", kind, status: "active" },
            relation: { direct: false },
          },
        ],
        pagination,
      }),
    ]);
    await accountsCli.run(ctx);
    expect(calls[1]?.path).toContain("kinds=service_account&member_of_group_id=g1&recursive=true");
    expect(tables[0]).toEqual([{ kind, name: "Named worker", provider: "", profile: "active", direct: "no", id: "machine" }]);
  }
});
