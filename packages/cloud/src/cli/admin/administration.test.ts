import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { ADMIN_OPERATIONS, administrationCommands } from "./administration";

const module = defineCliCommands({ name: "admin", summary: "Administration", commands: administrationCommands });
const invoke = async (args: string[], flags: CloudCliFlags = {}, respond?: () => Response) => {
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
      if (respond) return respond();
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ secret: "never-print-mutation-response", id: "created-id", access: { id: "created-id" }, jobId: "created-job" });
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(`${response.status} refused`);
      return response.json();
    },
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
      if (operation.report) continue;
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
test("an operation that only runs a check or task never claims a save", () => {
  const runs = ADMIN_OPERATIONS.filter((operation) => /\/(test|run)-/.test(operation.path));
  expect(runs.map((operation) => operation.command).sort()).toEqual([
    "ai enrichment run",
    "settings test freeipa",
    "settings test pdf",
    "settings test storage",
  ]);
  for (const operation of runs) expect(operation.report).toBeDefined();
});
const REPORTS: { args: string[]; body: Record<string, unknown>; expected: Record<string, unknown> }[] = [
  { args: ["settings", "test", "storage"], body: { ok: true }, expected: { ok: true, message: "Object written, read and deleted" } },
  { args: ["settings", "test", "freeipa"], body: { ok: true }, expected: { ok: true, message: "FreeIPA connection succeeded" } },
  {
    args: ["settings", "test", "pdf"],
    body: { ok: true, bytes: 1024, contentType: "application/pdf" },
    expected: { ok: true, message: "PDF rendered", bytes: 1024, contentType: "application/pdf" },
  },
  {
    args: ["ai", "enrichment", "run"],
    body: { ok: true, summary: { scanned: 2, enriched: 1 } },
    expected: { ok: true, message: "AI enrichment ran", summary: { scanned: 2, enriched: 1 } },
  },
];
for (const { args, body, expected } of REPORTS)
  test(`${args.join(" ")} reports its result and does not echo other response fields`, async () => {
    const result = await invoke(args, { yes: true }, () => Response.json({ ...body, secret: "never-print" }));
    expect(result.output).toEqual([expected]);
  });
test("a failed check reports the failure, not a success", async () => {
  const failed = invoke(["settings", "test", "storage"], { yes: true }, () => Response.json({ message: "no bucket" }, { status: 502 }));
  await expect(failed).rejects.toThrow("502");
});
test("read commands preserve documented pagination and filter queries", async () => {
  const result = await invoke(["capabilities", "executions", "list"], { query: "limit=10&cursor=next&app=mail" });
  expect(result.requests[0]?.path).toBe("/api/gateway/capabilities/executions?limit=10&cursor=next&app=mail");
});
