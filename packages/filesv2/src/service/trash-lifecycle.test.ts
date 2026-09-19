import { describe, expect, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { FilegateError, type Node } from "@k2b/filegate";
import type { BaseSummary } from "../contracts";
import type { TrashRow, trash } from "../data/trash";
import { normalizeSelection, runFileBatch } from "./batches";
import { FilesError } from "./errors";
import { createTrashLifecycle, type TrashAuthority, type TrashLocation } from "./trash-lifecycle";

const actor: Extract<RequestActor, { kind: "user" }> = {
  kind: "user",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    uid: "alice",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Alice",
    sn: "Example",
    displayName: "Alice",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
};
const base: BaseSummary = {
  id: "cloud:users:alice",
  name: "Alice",
  area: "cloud",
  kind: "users",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const node = (path: string, directory = false): Node => ({
  root: "cloud",
  path,
  directory,
  size: 3,
  modified: "2026-09-19T10:00:00Z",
  uid: 1000,
  gid: 1000,
  mode: directory ? "0700" : "0600",
});
function fixture() {
  const rows = new Map<string, TrashRow>();
  const nodes = new Map<string, Node>([
    ["home/alice", node("home/alice", true)],
    ["home/alice/report.txt", node("home/alice/report.txt")],
  ]);
  const calls: string[] = [];
  const denied = new Set<string>();
  let lostResponse = false;
  let failInsert = false;
  let failFinish = false;
  let serverUrl = "http://filegate:4000";
  let beforeLock: (() => Promise<void>) | undefined;
  const store: typeof trash = {
    async create(input) {
      calls.push("intent");
      if (failInsert) throw new Error("db unavailable");
      const row: TrashRow = { ...input, restore_path: null, error_code: null, deleted_at: new Date(), updated_at: new Date() };
      rows.set(row.id, row);
      return structuredClone(row);
    },
    async list(baseId, after, limit = 50) {
      return structuredClone(
        [...rows.values()]
          .filter((row) => row.base_id === baseId && ["pending", "trashed", "restoring"].includes(row.state))
          .sort((a, b) => b.deleted_at.getTime() - a.deleted_at.getTime() || a.id.localeCompare(b.id))
          .filter(
            (row) =>
              !after || row.deleted_at.toISOString() < after.date || (row.deleted_at.toISOString() === after.date && row.id > after.id),
          )
          .slice(0, limit),
      );
    },
    async get(id, baseId) {
      const row = rows.get(id);
      return row?.base_id === baseId ? structuredClone(row) : null;
    },
    async at(baseId, path, includeRestored = false) {
      return structuredClone(
        [...rows.values()].find(
          (row) =>
            row.base_id === baseId &&
            row.trashed === path &&
            (["pending", "trashed", "restoring"].includes(row.state) || (includeRestored && row.state === "restored")),
        ) ?? null,
      );
    },
    async pending(baseId, original) {
      return structuredClone(
        [...rows.values()].find((row) => row.base_id === baseId && row.original === original && row.state === "pending") ?? null,
      );
    },
    async restoring(id, path, snapshot, serverUrl) {
      if (rows.get(id)?.state !== "trashed") throw new Error("operation_unresolved");
      Object.assign(rows.get(id)!, { state: "restoring", restore_path: path, snapshot, server_url: serverUrl });
    },
    async finish(id, state) {
      if (failFinish) throw new Error("db unavailable");
      if (rows.get(id)?.state !== (state === "trashed" ? "pending" : state === "restored" ? "restoring" : "trashed"))
        throw new Error("operation_unresolved");
      Object.assign(rows.get(id)!, { state, error_code: null });
    },
    async error(id, code) {
      rows.get(id)!.error_code = code;
    },
  };
  const root: TrashLocation["root"] = {
    async stat(path) {
      const found = nodes.get(path);
      if (!found) throw new FilegateError(404, "not_found", "Missing");
      return found;
    },
    async list(path = "", options) {
      const items = [...nodes.values()]
        .filter((entry) => entry.path.startsWith(`${path}/`) && !entry.path.slice(path.length + 1).includes("/"))
        .sort((a, b) => a.path.localeCompare(b.path));
      const offset = Number(options?.after ?? 0);
      const limit = options?.limit ?? 50;
      return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { next: String(offset + limit) } : {}) };
    },
    async transfer(path, _root, target, options) {
      calls.push("move");
      expect(options).toEqual({ move: true, onConflict: "error" });
      const value = await root.stat(path);
      if (nodes.has(target)) throw new FilegateError(409, "exists", "Exists");
      nodes.delete(path);
      const result = { ...value, path: target };
      nodes.set(target, result);
      if (lostResponse) throw new Error("network lost after effect");
      return result;
    },
  };
  const check = async (path: string) => {
    if (denied.has(path)) throw new FilesError("permission_denied", 403);
  };
  const authorize: TrashAuthority = async (_actor, _baseId, path, access) => {
    const absolute = path ? `home/alice/${path}` : "home/alice";
    const target = access === "write-parent" ? absolute.split("/").slice(0, -1).join("/") : absolute;
    await check(target);
    return {
      root,
      rootName: "cloud",
      serverUrl,
      basePath: "home/alice",
      bindingId: "00000000-0000-4000-8000-000000000002",
      userId: actor.user.id,
      base,
      relative: path,
      node: await root.stat(target),
      check,
      async ensureTrash() {
        nodes.set("home/alice/trash", node("home/alice/trash", true));
      },
      async forget() {
        calls.push("forget");
      },
    };
  };
  const service = createTrashLifecycle(authorize, store, async (_key, run) => {
    const callback = beforeLock;
    beforeLock = undefined;
    await callback?.();
    return run();
  });
  return {
    service,
    nodes,
    rows,
    calls,
    denied,
    setBeforeLock(callback: () => Promise<void>) {
      beforeLock = callback;
    },
    setServerUrl(value: string) {
      serverUrl = value;
    },
    setLostResponse(value: boolean) {
      lostResponse = value;
    },
    setFailInsert(value: boolean) {
      failInsert = value;
    },
    setFailFinish(value: boolean) {
      failFinish = value;
    },
  };
}

describe("recoverable trash lifecycle", () => {
  test("records intent before moving to a UUID target, preserving the user-facing name", async () => {
    const f = fixture();
    const result = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    expect(result.entries[0]).toMatchObject({ original: "report.txt", name: "report.txt", state: "trashed" });
    expect(f.calls.slice(0, 2)).toEqual(["intent", "move"]);
    expect([...f.rows.values()][0]!.trashed).toBe(`trash/${result.entries[0]!.id}`);
    expect(f.nodes.has("home/alice/report.txt")).toBeFalse();
  });
  test("never moves a source whose durable intent could not be stored", async () => {
    const f = fixture();
    f.setFailInsert(true);
    const result = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    expect(result.results[0]?.ok).toBeFalse();
    expect(f.calls).not.toContain("move");
    expect(f.nodes.has("home/alice/report.txt")).toBeTrue();
  });
  test("a lost transfer response is reconciled without another move", async () => {
    const f = fixture();
    f.setLostResponse(true);
    const result = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    expect(result.results[0]?.ok).toBeTrue();
    expect(f.calls.filter((call) => call === "move")).toHaveLength(1);
  });
  test("listing after restart repairs a move whose database completion failed", async () => {
    const f = fixture();
    f.setFailFinish(true);
    await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    expect([...f.rows.values()][0]?.state).toBe("pending");
    f.setFailFinish(false);
    const result = await f.service.trash(actor, { baseId: base.id });
    expect(result.entries[0]?.state).toBe("trashed");
    expect([...f.rows.values()][0]?.state).toBe("trashed");
    expect(f.calls.filter((call) => call === "move")).toHaveLength(1);
  });
  test("restore records its intent and recovers a lost response without overwriting", async () => {
    const f = fixture();
    const removed = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    f.setLostResponse(true);
    const result = await f.service.restoreTrash(actor, { baseId: base.id, id: removed.entries[0]!.id, path: "restored.txt" });
    expect(result.entry.path).toBe("restored.txt");
    expect([...f.rows.values()][0]?.state).toBe("restored");
  });
  test("an existing restore destination leaves the trash untouched", async () => {
    const f = fixture();
    const removed = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    f.nodes.set("home/alice/report.txt", node("home/alice/report.txt"));
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id: removed.entries[0]!.id })).rejects.toMatchObject({
      code: "path_conflict",
    });
    expect([...f.rows.values()][0]?.state).toBe("trashed");
  });
  test("completed restores replay only while the freshly authorized destination still matches", async () => {
    const f = fixture();
    const removed = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    const id = removed.entries[0]!.id;
    await f.service.restoreTrash(actor, { baseId: base.id, id });
    expect((await f.service.restoreTrash(actor, { baseId: base.id, id })).entry.path).toBe("report.txt");
    expect(f.calls.filter((call) => call === "move")).toHaveLength(2);
    f.nodes.set("home/alice/report.txt", { ...node("home/alice/report.txt"), size: 9 });
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id })).rejects.toMatchObject({ code: "source_changed" });
    f.denied.add("home/alice/report.txt");
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id })).rejects.toMatchObject({ code: "permission_denied" });
  });
  test("a restored file is recovered after the completion write failed", async () => {
    const f = fixture();
    const removed = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    const id = removed.entries[0]!.id;
    f.setFailFinish(true);
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id, path: "recovered.txt" })).rejects.toThrow();
    f.setFailFinish(false);
    expect((await f.service.restoreTrash(actor, { baseId: base.id, id })).entry.path).toBe("recovered.txt");
    expect(f.calls.filter((call) => call === "move")).toHaveLength(2);
  });
  test("journal records cannot act on a different file server with matching root names", async () => {
    const f = fixture();
    const removed = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    const row = [...f.rows.values()][0]!;
    row.server_url = "http://other-filegate:4000";
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id: removed.entries[0]!.id })).rejects.toMatchObject({
      code: "binding_changed",
    });
    expect(f.calls.filter((call) => call === "move")).toHaveLength(1);
  });
  test("filesystem-only trash entries keep original and time unknown and require an explicit target", async () => {
    const f = fixture();
    f.nodes.set("home/alice/trash", node("home/alice/trash", true));
    f.nodes.set("home/alice/trash/manual.txt", node("home/alice/trash/manual.txt"));
    const first = await f.service.trash(actor, { baseId: base.id });
    const listed = await f.service.trash(actor, { baseId: base.id, after: first.next! });
    expect(listed.entries[0]).toMatchObject({ original: null, deletedAt: null, name: "manual.txt" });
    const id = listed.entries[0]!.id;
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id })).rejects.toMatchObject({ code: "restore_destination_required" });
    const restored = await f.service.restoreTrash(actor, { baseId: base.id, id, path: "manual.txt" });
    expect(restored.entry.path).toBe("manual.txt");
    expect((await f.service.restoreTrash(actor, { baseId: base.id, id })).entry.path).toBe("manual.txt");
    expect(f.calls.filter((call) => call === "move")).toHaveLength(1);
  });
  test("rechecks location identity after taking the root lock", async () => {
    const f = fixture();
    f.setBeforeLock(async () => {
      f.setServerUrl("http://other-filegate:4000");
    });
    const result = await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    expect(result.results).toEqual([{ path: "report.txt", ok: false, error: "binding_changed" }]);
    expect(f.calls).not.toContain("move");
  });
  test("reconciliation rereads state under the root lock instead of overwriting a concurrent restore", async () => {
    const f = fixture();
    f.setFailFinish(true);
    await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    f.setFailFinish(false);
    const row = [...f.rows.values()][0]!;
    f.setBeforeLock(async () => {
      row.state = "restored";
      row.restore_path = "report.txt";
      row.error_code = null;
      f.nodes.set("home/alice/report.txt", node("home/alice/report.txt"));
      f.nodes.delete(`home/alice/${row.trashed}`);
    });
    const result = await f.service.trash(actor, { baseId: base.id });
    expect(result.entries).toEqual([]);
    expect(row.state).toBe("restored");
    expect(row.error_code).toBeNull();
  });
  test("encoded filesystem cursors allow the full Filegate cursor length", async () => {
    const f = fixture();
    f.nodes.set("home/alice/trash", node("home/alice/trash", true));
    const after = Buffer.from(JSON.stringify({ phase: "filesystem", after: "a".repeat(8192) })).toString("base64url");
    expect(after.length).toBeGreaterThan(8192);
    await expect(f.service.trash(actor, { baseId: base.id, after })).resolves.toMatchObject({ entries: [], next: null });
    await expect(f.service.trash(actor, { baseId: base.id, after: "a".repeat(16385) })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  test("filesystem-only entries are individually checked and cannot bypass the reserved subtree", async () => {
    const f = fixture();
    f.nodes.set("home/alice/trash", node("home/alice/trash", true));
    f.nodes.set("home/alice/trash/secret.txt", node("home/alice/trash/secret.txt"));
    f.denied.add("home/alice/trash/secret.txt");
    const first = await f.service.trash(actor, { baseId: base.id });
    expect((await f.service.trash(actor, { baseId: base.id, after: first.next! })).entries).toEqual([]);
    const id = `fs:${Buffer.from("report.txt").toString("base64url")}`;
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id, path: "copy.txt" })).rejects.toMatchObject({ code: "invalid_path" });
  });
  test("unknown outcomes remain pending; missing source and destination never become success", async () => {
    const f = fixture();
    f.setFailFinish(true);
    await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    f.setFailFinish(false);
    const row = [...f.rows.values()][0]!;
    f.nodes.delete(`home/alice/${row.trashed}`);
    await expect(f.service.restoreTrash(actor, { baseId: base.id, id: row.id })).rejects.toMatchObject({ code: "operation_unresolved" });
    expect(row.state).toBe("pending");
    expect(row.error_code).toBe("operation_unresolved");
    const listed = await f.service.trash(actor, { baseId: base.id });
    expect(listed.entries[0]).toMatchObject({ state: "pending", error: "operation_unresolved" });
  });
  test("filesystem-only pages have a cursor and never repeat registered UUID trash targets", async () => {
    const f = fixture();
    await f.service.remove(actor, { baseId: base.id, paths: ["report.txt"] });
    for (let i = 0; i < 57; i++) {
      const path = `home/alice/trash/manual-${String(i).padStart(2, "0")}.txt`;
      f.nodes.set(path, node(path));
    }
    const first = await f.service.trash(actor, { baseId: base.id });
    expect(first.entries).toHaveLength(1);
    const second = await f.service.trash(actor, { baseId: base.id, after: first.next! });
    expect(second.next).not.toBeNull();
    const third = await f.service.trash(actor, { baseId: base.id, after: second.next! });
    expect(third.next).toBeNull();
    expect([...second.entries, ...third.entries]).toHaveLength(57);
    expect([...second.entries, ...third.entries].every((entry) => entry.original === null)).toBeTrue();
  });
});

describe("bounded file batches", () => {
  test("normalizes parent/child and duplicates with segment-aware comparisons", () => {
    expect(normalizeSelection(["Docs/a", "Docs", "Docs", "Docs2/a", "100%_done/a"])).toEqual(["Docs", "Docs2/a", "100%_done/a"]);
    expect(() => normalizeSelection(Array.from({ length: 101 }, (_, i) => `f${i}`))).toThrow();
    expect(() => normalizeSelection(["trash/a"])).toThrow();
  });
  test("preflights every path before effects and reports successes plus failures", async () => {
    const calls: string[] = [];
    const result = await runFileBatch(
      ["a", "b", "c"],
      async (path) => {
        calls.push(`prepare:${path}`);
        if (path === "b") throw new FilesError("permission_denied", 403);
        return path;
      },
      async (path) => {
        calls.push(`effect:${path}`);
        if (path === "c") throw new FilesError("path_conflict", 409);
        return { path };
      },
    );
    expect(calls).toEqual(["prepare:a", "prepare:b", "prepare:c", "effect:a", "effect:c"]);
    expect(result.entries).toEqual([{ path: "a" }]);
    expect(result.results).toEqual([
      { path: "a", ok: true, entry: { path: "a" } },
      { path: "b", ok: false, error: "permission_denied" },
      { path: "c", ok: false, error: "path_conflict" },
    ]);
  });
});
