import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { z } from "zod";
import { ChunkName, chunkSource } from "../../packages/assistant/src/chat-code/runtime/chunks";
import { compileScript } from "../../packages/assistant/src/chat-code/runtime/compile";
import { createServiceCalls, type RuntimeSdkCallOptions } from "../../packages/assistant/src/chat-code/runtime/services";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { CODE_CHECK_LIMITS, CodeDatabaseRequestSchema, CodeRouteResponseSchema, generateCodeSdk } from "../../packages/cloud/src/code";
import { CodeHttpRequestSchema } from "../../packages/cloud/src/contracts";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
import { acceptanceChecker } from "../../packages/core/src/code/acceptance.test-fixture";
import { parseGridsQueryDsl } from "../../packages/grids/src/query-dsl/parser";
import { packageIds } from "../workspace";
import { declarationOf } from "./capability-presentation";

const workspaceRoot = resolve(import.meta.dir, "../..");
const manifests: CapabilityManifest[] = [];
for (const appId of packageIds(workspaceRoot)) {
  const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
  if (!declaration) continue;
  if (declaration instanceof Error) throw declaration;
  const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
  const definitions = loaded[declaration.exportName];
  if (!definitions) throw new Error(`${declaration.exportName} is not exported`);
  const manifest = compileCapabilities(appId, definitions).manifest;
  manifests.push(manifest);
  test(`Code SDK accepts the ${appId} capability manifest`, () => {
    expect(generateCodeSdk([manifest], { mode: "personal" }).manifest.apps).toHaveLength(1);
  });
}

test("Code SDK generation accepts the combined built-in capability catalog", () => {
  expect(manifests.length).toBeGreaterThan(0);
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  expect(sdk.manifest.apps).toHaveLength(manifests.length);
  expect(sdk.manifest.operations.length).toBeGreaterThan(0);
});

test("the combined catalog SDK loads and its declarations compile with tsgo", async () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const directory = await mkdtemp(join(tmpdir(), "cloud-code-c15-catalog-"));
  const runtime = join(directory, "sdk.mjs");
  const declarations = join(directory, "sdk.d.ts");
  const consumer = join(directory, "consumer.ts");
  try {
    await writeFile(runtime, sdk.runtime);
    await writeFile(declarations, sdk.declarations);
    const loaded = await import(runtime);
    for (const app of sdk.manifest.apps) expect(loaded[app.exportName].id).toBe(app.appId);
    expect(loaded.capabilities.app("core")).toMatchObject({ type: "capabilities.app", id: "core" });
    expect(() => loaded.capabilities.app()).toThrow("code_sdk_invalid_id");
    loaded.__codeSdk.bind({
      async call() {
        return { data: { items: [] } };
      },
    });
    await expect(loaded.capabilities.search({ query: "core", tags: [], limit: 10 })).resolves.toEqual({ data: { items: [] } });
    await writeFile(
      consumer,
      `import { capabilities } from "./sdk";
const handle = capabilities.app("core");
const type: "capabilities.app" = handle.type;
const id: "core" = handle.id;
capabilities.search({ query: "core", tags: [], limit: 10 });
// @ts-expect-error only the typed app(id) factory exists
capabilities.app();
`,
    );
    const compiler = join(workspaceRoot, "node_modules/.bin/tsc");
    const proc = Bun.spawn([compiler, "--checkers", "1", "--ignoreConfig", "--strict", "--noEmit", "--target", "esnext", consumer], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await unlink(runtime);
    await unlink(declarations);
    await unlink(consumer);
    await rmdir(directory);
  }
});

// Real application catalogs are loaded here, never from another application's tests.
test("the documented Gustav export compiles and runs against the built-in catalog", async () => {
  const docs = await Bun.file(join(workspaceRoot, "docs-site/docs/en/platform/gustav-code-tools.md")).text();
  const code = docs.split("<!-- gustav-code-export -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const sdk = generateCodeSdk(manifests, { mode: "code_run" });
  expect(sdk.declarations).not.toContain("export declare const app");
  expect(sdk.declarations).not.toContain("export declare const owner");

  const directory = await mkdtemp(join(tmpdir(), "cloud-code-export-"));
  const paths = ["sdk.d.ts", "main.ts", "tsconfig.json"];
  try {
    // The one-off host supplies sheet in addition to the generated capability SDK.
    await writeFile(
      join(directory, "sdk.d.ts"),
      sdk.declarations + "\nexport declare const sheet: { toCsv(rows: Record<string, unknown>[]): Promise<string> };\n",
    );
    await writeFile(join(directory, "main.ts"), code);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          types: [],
          skipLibCheck: true,
          paths: { "@sdk": ["./sdk.d.ts"] },
        },
        files: ["main.ts"],
      }),
    );
    const proc = Bun.spawn(
      [join(workspaceRoot, "node_modules/.bin/tsc"), "--checkers", "1", "--project", join(directory, "tsconfig.json"), "--pretty", "false"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ exit, stdout, stderr: exit === 0 ? undefined : stderr }).toEqual({ exit: 0, stdout: "", stderr: undefined });
  } finally {
    for (const path of paths) await unlink(join(directory, path));
    await rmdir(directory);
  }

  const source = await compileScript({ entry: "main.ts", files: [{ path: "main.ts", content: code }] }, sdk);
  const output = Promise.withResolvers<unknown>();
  let receive: ((event: unknown) => void) | undefined;
  const calls: { name: string; input: unknown; options?: RuntimeSdkCallOptions }[] = [];
  const chunks: string[] = [];
  const request = createServiceCalls({
    chunk: async (name) => {
      chunks.push(name);
      return chunkSource(ChunkName.parse(name));
    },
    capability: async (name, input, _signal, options) => {
      calls.push({ name, input, options });
      return { data: { ok: true, mode: "rows", columns: [], rows: [{ values: { Name: "Example" }, links: [] }], limit: 100 } };
    },
  });
  const signal = new AbortController().signal;
  const context = createContext({
    crypto,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    File,
    Response,
    TextEncoder,
    TextDecoder,
    URL: {
      createObjectURL: () => {
        // The worker's chunk loader is asynchronous, but createObjectURL itself is synchronous.
        // csv is the only lazy module this script uses; use the same bytes as the production loader.
        return csvUrl;
      },
      revokeObjectURL() {},
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "message") receive = listener;
    },
    postMessage: (message: { type: string; id?: number; method?: string; args?: unknown[]; value?: unknown; text?: string }) => {
      if (message.type === "output") output.resolve(message.value);
      if (message.type === "error") output.reject(new Error(message.text));
      if (message.type === "rpc")
        void request(message.method!, message.args!, signal).then(
          (value) => receive?.({ data: { type: "result", id: message.id, value } }),
          (error) => receive?.({ data: { type: "result", id: message.id, error: String(error) } }),
        );
    },
  });
  const csvUrl = `data:text/javascript;base64,${Buffer.from(await chunkSource("csv")).toString("base64")}`;
  runInContext(source.runtime, context, { importModuleDynamically: (specifier) => import(specifier) });
  runInContext('__artifactInit({locale:"en-US",timeZone:"UTC",user:null},[]);', context);
  runInContext(source.code, context);
  expect(await output.promise).toContain("Name\r\nExample\r\n");
  expect(calls).toEqual([
    {
      name: "grids.gql.execute",
      input: { query: "from table Orders\nselect Name\nlimit 100", pageSize: 100, limit: 100, showTableToUser: false },
      options: { target: { type: "grids.base", id: "Base001" }, refs: {} },
    },
  ]);
  const query = calls[0]?.input;
  if (!query || typeof query !== "object" || !("query" in query) || typeof query.query !== "string")
    throw new Error("Expected a GQL query from the documented example");
  expect(parseGridsQueryDsl(query.query).ok).toBe(true);
  expect(chunks).toEqual(["csv"]);
});

test("built-in SDK paths use camelCase and the Files export while preserving capability IDs", async () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  expect(sdk.manifest.apps.find((app) => app.appId === "filesv2")?.exportName).toBe("files");
  expect(loaded.files.id).toBe("filesv2");
  expect(loaded.filesv2).toBeUndefined();
  expect(typeof loaded.spaces.space("Space001").task.setCompleted).toBe("function");
  expect(typeof loaded.grids.table("Table001").record.upsertExternal).toBe("function");
  expect(typeof loaded.mail.mailbox("Mail001").mailingList.subscription.get).toBe("function");
  for (const [capability, methodPath] of [
    ["spaces.task.set-completed", ["task", "setCompleted"]],
    ["grids.record.upsert-external", ["record", "upsertExternal"]],
    ["pulse.saved_query.list", ["savedQuery", "list"]],
  ] as const)
    expect(sdk.manifest.operations.find((op) => op.capability === capability)?.methodPath).toEqual([...methodPath]);
  expect(sdk.manifest.events.filter((event) => event.type.startsWith("filesv2.")).length).toBeGreaterThan(0);
  expect(sdk.manifest.events.some((event) => event.type.startsWith("files."))).toBe(false);
  for (const suffix of ["", ".batch"]) {
    expect(sdk.manifest.omitted).toContainEqual(
      expect.objectContaining({ capability: `mail.conversation.status.update${suffix}`, reason: "code_false" }),
    );
    expect(sdk.manifest.operations.some((op) => op.capability === `mail.conversation.status.set${suffix}`)).toBe(true);
  }
  // message queues attributable inter-chat communication; deliver/run have different lifecycle contracts.
  expect(sdk.manifest.operations.some((op) => op.capability === "core.ai.chat.message")).toBe(true);
});

// Read the published Fibel example itself, then run its checked bundle with real
// SQLite. Only the remote service and task provider are replaced.
test("the Fibel webhook keeps shipment claims after receipts expire and fences uncertain task outcomes", async () => {
  const markdown = await Bun.file(join(workspaceRoot, "docs-site/code-content/en/use-cases.md")).text();
  const source = markdown.split("## Receive a webhook")[1]!.match(/```ts\n([\s\S]*?)```/)![1]!;
  const checker = await acceptanceChecker();
  const database = new Database(":memory:");
  try {
    const result = await checker.check({
      sdk: generateCodeSdk(manifests, { mode: "personal" }),
      entry: "code.ts",
      files: { "code.ts": source },
      aiOperations: ["core.ai.generate", "core.ai.decide", "core.ai.chat.run"],
      limits: { ...CODE_CHECK_LIMITS, checkMs: 60_000 },
    });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
    if (!result.ok) return;
    let tasks = 0;
    const taskReceipts = new Map<string, number>();
    let loseTaskResponse = false;
    let delivered = true;
    const bridge = {
      async call(operation: string, input: unknown) {
        if (operation.startsWith("db.")) {
          if (!input || typeof input !== "object") throw new Error("Missing database input");
          const request = CodeDatabaseRequestSchema.parse({ ...input, operation });
          if (request.operation === "db.batch") throw new Error("Unexpected batch");
          const parameters = request.params.map((value) => (typeof value === "boolean" ? Number(value) : value));
          const statement = database.query(request.sql);
          return request.operation === "db.query" ? statement.all(...parameters) : { changes: statement.run(...parameters).changes };
        }
        if (operation === "http.fetch") {
          const request = CodeHttpRequestSchema.parse(input);
          expect(request.url).toMatch(/^https:\/\/api\.shipping\.example\/v1\/shipments\/shipment_[12]$/);
          expect(request.headers).toEqual({ authorization: "Bearer [secret:SHIPPING]" });
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ status: delivered ? "delivered" : "in_transit" })).toString("base64"),
          };
        }
        expect(operation).toBe("spaces.task.create");
        expect(input).toMatchObject({ call: { target: { type: "spaces.space", id: "Spc001" } } });
        const { metadata } = z.object({ metadata: z.object({ idempotencyKey: z.string() }) }).parse(input);
        if ((taskReceipts.get(metadata.idempotencyKey) ?? 0) > Date.now()) return {};
        tasks++;
        taskReceipts.set(metadata.idempotencyKey, Date.now() + 24 * 60 * 60 * 1000);
        if (loseTaskResponse) throw new Error("unknown_task_outcome");
        return {};
      },
    };
    let load = 0;
    const invoke = async (shipmentId: string) => {
      // Each request is a fresh module. Durable state belongs only to the DB.
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(`${result.bundle}\n// request ${++load}\n`).toString("base64")}`
      );
      const response = await module["route:POST:/hooks/shipments"](
        {
          codeId: "c_shipments",
          method: "POST",
          path: "/hooks/shipments",
          query: "",
          params: {},
          contentType: "application/json",
          body: JSON.stringify({ shipmentId }),
          user: null,
        },
        bridge,
      );
      return CodeRouteResponseSchema.parse(response);
    };
    setSystemTime(new Date("2026-11-10T00:00:00Z"));
    delivered = false;
    expect(await invoke("shipment_1")).toMatchObject({ kind: "json", status: 200 });
    expect(tasks).toBe(0);
    delivered = true;
    expect(await invoke("shipment_1")).toMatchObject({ kind: "json", status: 200 });
    expect(tasks).toBe(1);
    expect(await invoke("shipment_1")).toMatchObject({ kind: "json", status: 200 });
    expect(tasks).toBe(1);
    // The provider's receipt now expires. A fresh request must still find the
    // durable business claim and never attempt another task.
    setSystemTime(new Date("2026-11-11T01:00:00Z"));
    expect(await invoke("shipment_1")).toMatchObject({ kind: "json", status: 200 });
    expect(tasks).toBe(1);
    loseTaskResponse = true;
    await expect(invoke("shipment_2")).rejects.toThrow("unknown_task_outcome");
    expect(tasks).toBe(2);
    loseTaskResponse = false;
    setSystemTime(new Date("2026-11-12T02:00:00Z"));
    const pending = await invoke("shipment_2");
    expect(pending).toMatchObject({ kind: "json", status: 409 });
    if (pending.kind !== "json") throw new Error("Expected JSON reconciliation notice");
    expect(JSON.parse(pending.body)).toEqual({ ok: false, code: "reconciliation_required" });
    expect(tasks).toBe(2);
    expect(result.manifest.database).toBe(true);
    expect(database.query("SELECT shipment_id, state FROM processed ORDER BY shipment_id").all()).toEqual([
      { shipment_id: "shipment_1", state: "done" },
      { shipment_id: "shipment_2", state: "pending" },
    ]);
  } finally {
    setSystemTime();
    database.close();
    await checker.close();
  }
}, 90_000);
