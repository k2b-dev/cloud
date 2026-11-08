import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { ChunkName, chunkSource } from "../../packages/assistant/src/chat-code/runtime/chunks";
import { compileScript } from "../../packages/assistant/src/chat-code/runtime/compile";
import { createServiceCalls, type RuntimeSdkCallOptions } from "../../packages/assistant/src/chat-code/runtime/services";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { generateCodeSdk } from "../../packages/cloud/src/code";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
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
  try {
    await writeFile(runtime, sdk.runtime);
    await writeFile(declarations, sdk.declarations);
    const loaded = await import(runtime);
    for (const app of sdk.manifest.apps) expect(loaded[app.exportName].app().id).toBe(app.appId);
    const compiler = join(workspaceRoot, "node_modules/.bin/tsc");
    const proc = Bun.spawn([compiler, "--checkers", "1", "--ignoreConfig", "--strict", "--noEmit", "--target", "esnext", declarations], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await unlink(runtime);
    await unlink(declarations);
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
