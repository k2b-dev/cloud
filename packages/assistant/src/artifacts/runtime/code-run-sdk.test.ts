import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CodeRuntimeInput } from "@k2b/cloud/ai/browser";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { generateCodeSdk } from "@k2b/cloud/code";
import { z } from "zod";
import { ChunkName, chunkSource } from "./chunks";
import { usesCodeRunSdk } from "./code-run-sdk";
import { compileArtifact } from "./compile";
import { createServiceCalls, type RuntimeSdkCallOptions } from "./services";

const manifest = compileCapabilityManifest("grids", {
  protocolVersion: 2,
  types: { table: { title: "Table", description: "A fictional table." } },
  queries: {
    "record.list": {
      title: "Records",
      description: "List fictional records.",
      target: "table",
      openWorld: false,
      input: z.object({}).strict(),
      data: z.array(z.object({ name: z.string(), amount: z.number() })),
      run: () => {
        throw new Error("Never call a real provider in this acceptance test");
      },
    },
  },
});

test("one code_run input imports the shared SDK and converts dynamic table records directly to CSV", async () => {
  const input = CodeRuntimeInput.parse({
    operation: "run",
    code: `import {grids, sheet} from "@sdk";
    const tableId = ["t", "fictional"].join("_");
    export default async () => {
      const rows = await grids.table(tableId).record.list({});
      return sheet.toCsv(rows, {bom: false});
    };`,
  });
  if (input.operation !== "run") throw new Error("Expected code_run input");
  const sdk = generateCodeSdk([manifest], { mode: "code_run" });
  expect(sdk.declarations).not.toContain("export declare const app");
  expect(sdk.declarations).not.toContain("export declare const owner");
  const source = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: input.code! }] }, undefined, sdk);
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
      return {
        data: [
          { name: "Ada", amount: 12.5 },
          { name: "=formula", amount: 4 },
        ],
      };
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
  expect(await output.promise).toBe("name;amount\r\nAda;12.5\r\n'=formula;4\r\n");
  expect(calls).toEqual([
    { name: "grids.record.list", input: {}, options: { target: { type: "grids.table", id: "t_fictional" }, refs: {} } },
  ]);
  expect(chunks).toEqual(["csv"]);
});

test("@sdk is a trusted compile input and does not enable arbitrary package imports", async () => {
  const source = (content: string) => ({ entry: "main.ts", files: [{ path: "main.ts", content }] });
  await expect(compileArtifact(source('import {grids} from "@sdk"; export default () => grids;'))).rejects.toThrow();
  await expect(
    compileArtifact(
      source('import fs from "node:fs"; export default () => fs;'),
      undefined,
      generateCodeSdk([manifest], { mode: "code_run" }),
    ),
  ).rejects.toThrow();
});

test("only @sdk import specifiers request a catalog, including imports in helper files", () => {
  const source = (content: string) => [{ path: "main.ts", content }];
  expect(usesCodeRunSdk(source('const mail = "support@sdk.example"; // import "@sdk"\nexport default () => mail;'))).toBe(false);
  expect(usesCodeRunSdk(source('/* @sdk */ export default () => "@sdk";'))).toBe(false);
  for (const content of ['import {grids} from "@sdk";', "import {grids} from '@sdk';", 'const sdk = import("@sdk");'])
    expect(usesCodeRunSdk(source(content))).toBe(true);
  expect(
    usesCodeRunSdk([
      ...source('export {default} from "./helper.ts";'),
      { path: "helper.ts", content: 'import {grids} from "@sdk"; export default () => grids;' },
    ]),
  ).toBe(true);
});
