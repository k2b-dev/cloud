import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { instanceCommands } from "./instance";
import { syncCommands } from "./sync";
const module = defineCliCommands({ name: "admin", summary: "Sync", commands: [...syncCommands, ...instanceCommands] });
const snapshot = {
  sampledAt: "2026-09-08T12:00:00Z",
  apps: [{ appId: "mail", appName: "Mail", status: "unavailable", error: "offline", health: null }],
  resources: [],
  schedules: [],
  deadLetters: [],
  truncatedStores: ["mail/queue/work"],
};
const invoke = async (args: string[], flags: CloudCliFlags = {}, output: "json" | "jsonl" = "json", response: unknown = snapshot) => {
  const paths: string[] = [];
  const bodies: (string | undefined)[] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://test", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : undefined);
      paths.push(path);
      return Response.json(response);
    },
    readJson: async (response) => response.json(),
    print: (value = "") => {
      lines.push(value);
    },
    write: async (value) => {
      lines.push(value);
    },
    error: (value) => {
      lines.push(value);
    },
    jsonLine: (value) => {
      lines.push(JSON.stringify(value));
    },
    json: (value) => {
      lines.push(JSON.stringify(value));
    },
    table: () => {},
  };
  await module.run(ctx);
  return { paths, lines, bodies };
};

test("Sync CLI preserves incomplete app context and filters", async () => {
  const result = await invoke(["sync", "status"], { app: "mail", resource: "work", problems: true });
  expect(result.paths).toEqual(["/api/gateway/sync?app=mail&resource=work&problems=true"]);
  expect(JSON.parse(result.lines[0]!)).toEqual(snapshot);
  const lines = (await invoke(["sync", "resources", "list"], {}, "jsonl")).lines.map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({ type: "snapshot", apps: snapshot.apps });
});
test("DLQ pages retain opaque cursor and direct lookup sequence", async () => {
  const page = {
    sampledAt: snapshot.sampledAt,
    store: { name: "work", entries: [{ messageId: "x", streamSequence: 42 }], truncated: true },
    nextCursor: "opaque/+=",
  };
  const result = await invoke(
    ["sync", "dead-letters", "list", "mail", "queue", "work"],
    { cursor: "opaque/+=", limit: "3" },
    "jsonl",
    page,
  );
  expect(new URL(result.paths[0]!, "http://test").searchParams.get("cursor")).toBe("opaque/+=");
  expect(JSON.parse(result.lines[0]!)).toMatchObject({ type: "snapshot", nextCursor: page.nextCursor, truncated: true });
  expect(JSON.parse(result.lines[1]!)).toMatchObject({ messageId: "x", streamSequence: 42 });
  expect((await invoke(["sync", "dead-letters", "get", "mail", "queue", "work", "x/y"], { sequence: "42" })).paths[0]).toBe(
    "/api/gateway/sync/dead-letters/mail/queue/work/x%2Fy?sequence=42",
  );
  await expect(invoke(["sync", "dead-letters", "list", "mail", "invalid", "work"])).rejects.toThrow("kind must");
});
test("recovery and schedule commands require explicit confirmation and preserve request identity", async () => {
  for (const operation of ["delete", "requeue"]) {
    await expect(invoke(["sync", "dead-letters", operation, "mail", "queue", "work", "message"])).rejects.toThrow("--yes");
  }
  await expect(invoke(["sync", "dead-letters", "requeue", "mail", "topic", "work", "message"], { yes: true })).rejects.toThrow("replay");
  await expect(invoke(["sync", "schedules", "run", "mail", "scheduler", "schedule"], { "request-id": "stable" })).rejects.toThrow("--yes");
  const result = await invoke(
    ["sync", "schedules", "run", "mail", "scheduler", "schedule"],
    { "request-id": "stable", yes: true },
    "json",
    { runId: "run1" },
  );
  expect(JSON.parse(result.bodies[0]!)).toEqual({ requestId: "stable" });
  const check = await invoke(
    ["sync", "schedules", "runs", "get", "mail", "scheduler", "schedule", "run1"],
    { "timeout-ms": "5000" },
    "json",
    { completed: false, error: null },
  );
  expect(check.paths[0]).toContain("/runs/run1?timeoutMs=5000");
  expect(JSON.parse(check.lines[0]!)).toEqual({ completed: false, error: null });
});

test("diagnose includes both snapshots and removes payload previews from support output", async () => {
  const response = { ...snapshot, deadLetters: [{ messageId: "failure", reason: "failed", dataPreview: "user payload" }], cluster: { status: "available" }, inventory: { status: "partial", matchedTotal: null } };
  const result = await invoke(["diagnose"], { include: "sync,nats" }, "json", response);
  expect(result.paths).toEqual(["/api/gateway/sync?problems=true", "/api/gateway/nats?problems=true&limit=20"]);
  const bundle = JSON.parse(result.lines[0]!);
  expect(bundle.sync.data.deadLetters).toEqual([{ messageId: "failure", reason: "failed" }]);
  expect(bundle.nats.data.inventory.status).toBe("partial");
  expect(JSON.stringify(bundle.sync)).not.toContain("user payload");
});
