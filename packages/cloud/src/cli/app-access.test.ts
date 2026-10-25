import { expect, test } from "bun:test";
import type { AccessEntry } from "../contracts/shared";
import type { AppAccessSnapshot } from "../services/app-access-management";
import { createAppAccessCommands } from "./app-access";
import { type CloudCliContext, type CloudCliFlags, defineCliCommands } from "./index";

const accessId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const entry: AccessEntry = { id: accessId, principal: { type: "user", userId }, permission: "admin", createdAt: "2026-01-01T00:00:00Z" };
const snapshot: AppAccessSnapshot = {
  appId: "demo",
  name: "Demo",
  entries: [entry],
  ownEntryIds: [entry.id],
  configured: true,
  hasEffectiveManager: true,
  inheritedSignedIn: false,
  canUse: true,
};
const mod = () => defineCliCommands({ name: "demo", summary: "Fictional app", commands: createAppAccessCommands("demo") });
const context = (args: string[], flags: CloudCliFlags = {}, response?: (path: string, init?: RequestInit) => Response) => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://cloud.test", token: "fixture", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path: String(path), init });
      return response?.(String(path), init) ?? Response.json(init?.method === "POST" ? { entry, canUse: true } : snapshot);
    },
    readJson: async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json();
    },
    print: (value) => output.push(value),
    write: async (value) => {
      output.push(value);
    },
    error: (value) => output.push(value),
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: (value) => {
      output.push(value);
    },
  };
  return { ctx, requests, output };
};

test("app commands reuse access list, grant, set, revoke and principal search", async () => {
  const { ctx, requests, output } = context(["access", "list"]);
  await mod().run(ctx);
  expect(requests.map((r) => r.path)).toEqual(["/_cloud/app-access/demo"]);
  expect(output).toEqual([{ resource: { id: "demo", label: "demo" }, entries: [entry] }]);
  const help = context(["access", "grant"], { help: true });
  await mod().run(help.ctx);
  const rendered = help.output.join("\n");
  expect(rendered).toContain("use");
  expect(rendered).toContain("manage");
  expect(rendered).toContain("--service-account");
  expect(rendered).not.toContain("--public");
  expect(createAppAccessCommands("demo")).toHaveLength(5);
});

test("use/manage flags become read/admin only at the transport boundary", async () => {
  for (const [permission, stored] of [
    ["use", "read"],
    ["manage", "admin"],
  ] as const) {
    const { ctx, requests } = context(["access", "grant"], { user: userId, permission });
    await mod().run(ctx);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      action: "grant",
      principal: { type: "user", userId },
      permission: stored,
    });
  }
  for (const permission of ["read", "admin", "write", "invalid"]) {
    const { ctx, requests } = context(["access", "grant"], { user: userId, permission });
    await expect(mod().run(ctx)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  }
});

test("set reuses existing grants and revoke retains the shared confirmation guard", async () => {
  const update = context(["access", "set"], { user: userId, permission: "use" });
  await mod().run(update.ctx);
  expect(update.requests).toHaveLength(2);
  expect(JSON.parse(String(update.requests[1]?.init?.body))).toEqual({ action: "update", accessId, permission: "read" });
  const blocked = context(["access", "revoke"], { "access-id": accessId });
  await expect(mod().run(blocked.ctx)).rejects.toThrow("--yes");
  expect(blocked.requests).toHaveLength(0);
  const revoke = context(["access", "revoke"], { "access-id": accessId, yes: true });
  await mod().run(revoke.ctx);
  expect(JSON.parse(String(revoke.requests[0]?.init?.body))).toEqual({ action: "revoke", accessId });
});

test("app commands never select repair and surface authorization failures and missing mutation results", async () => {
  const denied = context(["access", "grant"], { authenticated: true, permission: "use" }, () =>
    Response.json({ code: "FORBIDDEN" }, { status: 403 }),
  );
  await expect(mod().run(denied.ctx)).rejects.toThrow("FORBIDDEN");
  expect(denied.requests[0]?.path).toBe("/_cloud/app-access/demo");
  const missing = context(["access", "grant"], { user: userId, permission: "manage" }, () => Response.json({ canUse: false }));
  await expect(mod().run(missing.ctx)).rejects.toThrow("returned no entry");
  const extra = context(["access", "list", "other-app"]);
  await expect(mod().run(extra.ctx)).rejects.toThrow("no resource argument");
  expect(extra.requests).toHaveLength(0);
});
