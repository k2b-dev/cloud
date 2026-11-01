import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { ADMIN_OPERATIONS, administrationCommands } from "./administration";

const module = defineCliCommands({ name: "admin", summary: "Administration", commands: administrationCommands });
const invoke = async (args: string[], flags: CloudCliFlags = {}) => {
  const requests: { path: string; method: string; body: unknown }[] = [],
    output: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://cloud.example.test", token: "fixture", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ secret: "never-print-mutation-response", id: "created-id", access: { id: "created-id" }, jobId: "created-job" });
    },
    readJson: (response) => response.json(),
    print: (value) => output.push(value),
    write: async () => {},
    error: () => {},
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: (rows) => output.push(rows),
  };
  await module.run(ctx);
  return { requests, output };
};

test("every added admin mutation stops without confirmation before reading input or issuing requests", async () => {
  for (const operation of ADMIN_OPERATIONS.filter((item) => item.method !== "GET")) {
    const args = [...operation.command.split(" "), ...[...operation.path.matchAll(/:([a-zA-Z]+)/g)].map(() => "fixture")];
    await expect(invoke(args, operation.body ? { from: "/does-not-exist" } : {})).rejects.toThrow("--yes");
  }
});
test("protected input reaches the owning API and responses cannot echo submitted credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-admin-cli-"));
  const file = join(directory, "input.json");
  try {
    await writeFile(file, '{"token":"fixture-secret"}', { mode: 0o600 });
    for (const operation of ADMIN_OPERATIONS.filter((item) => item.method !== "GET")) {
      const args = [...operation.command.split(" "), ...[...operation.path.matchAll(/:([a-zA-Z]+)/g)].map(() => "exact/id")];
      const result = await invoke(args, { yes: true, ...(operation.body ? { from: file } : {}) });
      expect(result.requests).toEqual([
        {
          path: operation.path.replace(/:[a-zA-Z]+/g, "exact%2Fid") + (operation.query ? `?${new URLSearchParams(operation.query)}` : ""),
          method: operation.method,
          body: operation.body ? { token: "fixture-secret" } : null,
        },
      ]);
      expect(result.output).toEqual([
        {
          saved: true,
          ...Object.fromEntries((operation.resultFields ?? []).map((field) => [field, field === "jobId" ? "created-job" : "created-id"])),
        },
      ]);
    }
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});
test("read commands preserve documented pagination and filter queries", async () => {
  const result = await invoke(["capabilities", "executions", "list"], { query: "limit=10&cursor=next&app=mail" });
  expect(result.requests[0]?.path).toBe("/api/gateway/capabilities/executions?limit=10&cursor=next&app=mail");
});
