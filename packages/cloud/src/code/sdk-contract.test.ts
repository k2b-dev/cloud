import { expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities, parseCapabilityManifest, validateCapabilityResult } from "../_internal/capabilities";
import { compileCapabilityManifest } from "../capabilities/testing";
import { capabilityPage, defineCapabilities, type NormalizedCapabilityCall } from "../contracts/capabilities";
import { requireCodeCapabilityDeclared } from "./capability-set";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import type { GeneratedCodeSdk } from "./types";

let moduleIndex = 0;
const runtime = (sdk: GeneratedCodeSdk) =>
  import(`data:text/javascript;base64,${Buffer.from(sdk.runtime + "\n// instance " + moduleIndex++).toString("base64")}`);
const fixture = sdkFixture();
const camelFixture = {
  ...fixture,
  sdkExportName: "workshops",
  types: [...fixture.types, { ...fixture.types[1]!, localId: "stock_item" }],
  queries: [...fixture.queries, { ...fixture.queries[1]!, localId: "stock_item.read-all", target: "stock_item" }],
  actions: fixture.actions.map((op) => (op.localId === "item.create" ? { ...op, localId: "task.set-completed" } : op)),
};

test("SDK, checker, runtime and declared-capability guard agree on camelCase paths and canonical IDs", async () => {
  const sdk = generateCodeSdk([camelFixture], { mode: "personal" });
  const checked = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts": `import {app, workshops} from "@sdk";
app.schedule({cron:"0 8 * * *", name:"morning"}, async () => {
 await workshops.workshop("one").task.setCompleted({title:"Grüße 👋", idempotencyKey:"one"});
 await workshops.stockItem("stock").readAll({});
}); export default app;`,
    },
  });
  expect(checked.diagnostics).toEqual([]);
  expect(checked.permissions.map((p) => p.operation)).toContain("work-shop.task.set-completed");
  expect(checked.permissions.map((p) => p.operation)).toContain("work-shop.stock_item.read-all");
  const loaded = await runtime(sdk);
  const calls: NormalizedCapabilityCall[] = [];
  loaded.__codeSdk.bind({
    call: async (_operation: string, input: { call: NormalizedCapabilityCall }) => {
      requireCodeCapabilityDeclared(input.call, checked.permissions);
      calls.push(input.call);
      return { data: [] };
    },
  });
  await loaded.workshops.workshop("one").task.setCompleted({ title: "Grüße 👋", idempotencyKey: "one" });
  await loaded.workshops.stockItem("stock").readAll({});
  expect(calls.map((c) => c.capability)).toEqual(["work-shop.task.set-completed", "work-shop.stock_item.read-all"]);
  expect(() => requireCodeCapabilityDeclared({ ...calls[0]!, capability: "work-shop.task.setCompleted" }, checked.permissions)).toThrow(
    "code_capability_undeclared",
  );
  expect(loaded.workshops.workshop("one").task["set-completed"]).toBeUndefined();
});

test("camelCase collisions are hard errors for methods, prefixes, factories and factory/method namespaces", () => {
  for (const [left, right] of [
    ["task.set-completed", "task.set_completed"],
    ["foo-bar.read", "foo_bar.write"],
  ] as const) {
    expect(() =>
      generateCodeSdk(
        [
          {
            ...fixture,
            actions: [
              { ...fixture.actions[0]!, localId: left },
              { ...fixture.actions[0]!, localId: right },
            ],
          },
        ],
        { mode: "personal" },
      ),
    ).toThrow("SDK path collision");
  }
  expect(() =>
    generateCodeSdk(
      [
        {
          ...fixture,
          types: [...fixture.types, { ...fixture.types[1]!, localId: "stock-item" }, { ...fixture.types[1]!, localId: "stock_item" }],
        },
      ],
      { mode: "personal" },
    ),
  ).toThrow("SDK path collision");
  expect(() =>
    generateCodeSdk(
      [
        {
          ...fixture,
          types: [...fixture.types, { ...fixture.types[1]!, localId: "stock-item" }],
          queries: [...fixture.queries, { ...fixture.queries[1]!, target: undefined, localId: "stock_item.list" }],
        },
      ],
      { mode: "personal" },
    ),
  ).toThrow("SDK path collision");
});

test("manifest SDK names are generic, validated, hash-covered and distinct from event IDs", async () => {
  const definitions = defineCapabilities({ protocolVersion: 2, sdkExportName: "files", queries: {} });
  const manifest = compileCapabilityManifest("third-party", definitions);
  expect(manifest.sdkExportName).toBe("files");
  expect(parseCapabilityManifest(manifest, "third-party").sdkExportName).toBe("files");
  expect(manifest.manifestHash).not.toBe(
    compileCapabilityManifest("third-party", { ...definitions, sdkExportName: "documents" }).manifestHash,
  );
  const sdk = generateCodeSdk([{ ...fixture, sdkExportName: "files" }], { mode: "personal" });
  expect(sdk.manifest.events[0]?.type).toBe("work-shop.changed");
  expect((await runtime(sdk)).files.id).toBe("work-shop");
  for (const sdkExportName of [
    "app",
    "db",
    "http",
    "constructor",
    "default",
    "atob",
    "decodeURIComponent",
    "bad-name",
    "a\n",
    'bad";process.exit()',
  ])
    expect(() => generateCodeSdk([{ ...fixture, sdkExportName }], { mode: "personal" })).toThrow();
  expect(() => generateCodeSdk([{ ...fixture, sdkExportName: "files" }, sdkFixture("files")], { mode: "personal" })).toThrow(
    "SDK export name collision",
  );
  expect(() =>
    generateCodeSdk([sdkFixture("work-shop"), { ...sdkFixture("other"), sdkExportName: "work_shop" }], { mode: "personal" }),
  ).toThrow("SDK export name collision");
});

test("fetch exposes binary bytes as bodyBase64 and decodes UTF-8 text and JSON", async () => {
  const loaded = await runtime(generateCodeSdk([], { mode: "personal" }));
  let body = JSON.stringify({ text: "Grüße aus Köln 👋 🌍" });
  loaded.__codeSdk.bind({
    call: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body).toString("base64") }),
  });
  const result = await loaded.http.fetch("https://example.com");
  expect(result.body).toBeUndefined();
  expect(result.bodyBase64).toBe(Buffer.from(body).toString("base64"));
  expect(await result.text()).toBe(body);
  expect(await result.json()).toEqual({ text: "Grüße aus Köln 👋 🌍" });
  body = "";
  expect(await (await loaded.http.fetch("https://example.com")).text()).toBe("");
  body = "not JSON";
  await expect((await loaded.http.fetch("https://example.com")).json()).rejects.toThrow();
});

test("schedules require stable names in declarations, checker and runtime, including one-time schedules", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const loaded = await runtime(sdk);
  for (const when of [{ cron: "0 8 * * *" }, { at: "2030-01-02T08:00:00Z" }]) {
    expect(() => loaded.app.schedule(when, () => {})).toThrow("invalid_schedule_name");
    const checked = analyzeCode({
      sdk,
      entry: "code.ts",
      aiOperations: [],
      files: { "code.ts": `import {app} from "@sdk"; app.schedule(${JSON.stringify(when)},()=>{}); export default app;` },
    });
    expect(checked.diagnostics.map((d) => d.code)).toContain("code_static_schedule");
    expect(sdk.declarations).toContain("timeZone?: string; name: string");
  }
  for (const name of ["second", "first"]) loaded.app.schedule({ cron: "0 8 * * *", name }, () => {});
  expect(loaded.__codeSdk.entries().map((e: { entrypoint: string }) => e.entrypoint)).toEqual(["second", "first"]);
});

test("every query with a declared continuation rejects missing or inconsistent page envelopes", () => {
  for (const cursorKey of ["next", "nextCursor"] as const) {
    const compiled = compileCapabilities(
      "paging",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          list: {
            title: "List",
            description: "Paginated items.",
            openWorld: false,
            input: z.object({ cursor: z.string().optional().describe("Continuation cursor.") }).strict(),
            data: z.object({ items: z.array(z.string()), [cursorKey]: z.string().nullable() }),
            run: () => ({ ok: false, error: { code: "NOT_FOUND", message: "Missing", status: 404 } }),
          },
        },
      }),
    );
    const operation = compiled.queries.get("list")!;
    for (const next of ["second", null]) {
      const data = { items: [], [cursorKey]: next };
      expect(validateCapabilityResult(compiled, operation, { data }).ok).toBe(false);
      expect(validateCapabilityResult(compiled, operation, { data, page: capabilityPage(next) }).ok).toBe(true);
      expect(validateCapabilityResult(compiled, operation, { data, page: capabilityPage(next === null ? "wrong" : null) }).ok).toBe(false);
    }
  }
});

test("a non-paginated after filter does not imply a page envelope", () => {
  const compiled = compileCapabilities(
    "paging",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        count: {
          title: "Count",
          description: "Count items after a date.",
          openWorld: false,
          input: z.object({ after: z.string().optional().describe("Inclusive date filter.") }).strict(),
          data: z.object({ count: z.number() }),
          run: () => ({ ok: true, data: { data: { count: 0 } } }),
        },
      },
    }),
  );
  expect(validateCapabilityResult(compiled, compiled.queries.get("count")!, { data: { count: 0 } }).ok).toBe(true);
});

test("paginated array queries require page even without a domain continuation field", () => {
  const compiled = compileCapabilities(
    "paging",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        list: {
          title: "List",
          description: "Read a page of items.",
          openWorld: false,
          input: z.object({ cursor: z.string().optional().describe("Opaque continuation cursor.") }).strict(),
          data: z.array(z.string()),
          run: () => ({ ok: true, data: { data: [], page: capabilityPage(null) } }),
        },
      },
    }),
  );
  const operation = compiled.queries.get("list")!;
  expect(validateCapabilityResult(compiled, operation, { data: [] }).ok).toBe(false);
  expect(validateCapabilityResult(compiled, operation, { data: [], page: capabilityPage(null) }).ok).toBe(true);
});

test("omitted camelCase methods keep their specific checker diagnostic", () => {
  const sdk = generateCodeSdk(
    [
      {
        ...camelFixture,
        actions: camelFixture.actions.map((op) => (op.localId === "task.set-completed" ? { ...op, code: false as const } : op)),
      },
    ],
    { mode: "personal" },
  );
  const result = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts":
        'import {app, workshops} from "@sdk"; app.schedule({name:"morning",cron:"0 8 * * *"},async()=>{await workshops.workshop("one").task.setCompleted({});});',
    },
  });
  expect(result.diagnostics.map((d) => d.code)).toContain("code_code_false");
});

test("manifest readers preserve syntactically valid export names that generation reserves", () => {
  const manifest = compileCapabilityManifest("third-party", defineCapabilities({ protocolVersion: 2, sdkExportName: "atob", queries: {} }));
  expect(parseCapabilityManifest(manifest, "third-party").sdkExportName).toBe("atob");
  expect(() => generateCodeSdk([manifest], { mode: "personal" })).toThrow();
  expect(generateCodeSdk([sdkFixture("atob")], { mode: "personal" }).manifest.apps[0]?.exportName).toBe("_atob");
});

test("the checker accepts decoded HTTP result methods and retains only fetch origin evidence", () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const checked = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts": `import {app,http} from "@sdk"; app.schedule({name:"fetch",cron:"0 8 * * *"},async()=>{
      const response = await http.fetch("https://example.com/status");
      await response.text(); await response.json();
      const {json} = response; await json();
    });`,
    },
  });
  expect(checked.diagnostics).toEqual([]);
  expect(checked.internet).toEqual(["https://example.com"]);
  expect(checked.permissions).toEqual([]);
});
