import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { capabilityCallDigest, normalizeCapabilityCall } from "../capabilities/calls";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CodeHttp } from "./authoring-types";
import { fileImportManifest } from "./file-ref.test-fixture";
import { generateCodeSdk } from "./generator";
import { schemaTypes } from "./schema-types";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkBridge, CodeSdkInvocation, CodeSdkOptions } from "./types";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of temporaryDirectories) {
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  }
});

const options: CodeSdkOptions = { mode: "resource", owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } } };
const fixture = sdkFixture();
const generated = () => generateCodeSdk([fixture], options);

type TestHandle = {
  type: string;
  id: string;
  item: { create(input: unknown): Promise<unknown>; move(input: unknown): Promise<unknown> };
};
type TestModule = {
  secrets: Readonly<Record<string, string>>;
  http: CodeHttp;
  work_shop: { workshop(id: string): TestHandle; item(id: string): object; catalog: { list(input: object): Promise<unknown> } };
  owner: TestHandle;
  app: {
    schedule(when: { cron: string; name?: string; title?: string }, fn: () => void | Promise<void>): unknown;
    on(event: string, fn: (input: unknown) => void | Promise<void>): unknown;
    on(place: TestHandle, event: string, fn: (input: unknown) => void | Promise<void>): unknown;
    get(path: string, fn: () => Response): unknown;
  };
  __codeSdk: {
    bind(bridge: CodeSdkBridge): void;
    entries(): Array<{ kind: string; entrypoint: string; cron: string; title?: string }>;
    diagnostics(): Array<{ message: string }>;
    run(entrypoint: string, input?: unknown): Promise<unknown>;
  };
};
async function runtime(mode: CodeSdkOptions = options, manifest = fixture): Promise<TestModule> {
  const sdk = generateCodeSdk([manifest], mode);
  const dir = await temporaryDirectory("cloud-code-c15-runtime-");
  const file = join(dir, "sdk.mjs");
  await writeFile(file, sdk.runtime);
  return import(file);
}

function callableFixture() {
  return {
    ...fixture,
    types: [...fixture.types, { ...fixture.types[0]!, localId: "branch" }],
    actions: fixture.actions.map((op) =>
      op.localId === "item.create"
        ? { ...op, localId: "branch.create", target: undefined }
        : op.localId === "item.move"
          ? { ...op, localId: "branch.create.child", target: undefined }
          : op,
    ),
  };
}

describe("Code SDK generation", () => {
  test("Mail content paths distinguish inline text from original attachment FileRefs without aliases", () => {
    const sdk = generateCodeSdk([compileCapabilityManifest("mail", mailCapabilities)], { mode: "personal" });
    const names = ["mail.message.content.read", "mail.attachment.text.read", "mail.attachment.content.read"];
    const operations = sdk.manifest.operations.filter((operation) => names.includes(operation.capability));
    expect(operations).toHaveLength(3);
    expect(sdk.manifest.operations.map((operation) => operation.localId)).not.toContain("message.read-content");
    expect(sdk.manifest.operations.map((operation) => operation.localId)).not.toContain("attachment.read-content");
    expect(sdk.declarations).not.toContain("read_content");
    expect(
      operations.map(({ capability, methodPath, dataSchema, stream }) => ({
        capability,
        methodPath,
        dataSchema,
        stream,
      })),
    ).toMatchSnapshot("Mail content operations");
  });
  test("snapshots a complete SDK generated from a third-party capability contract", () => {
    const sdk = generated();
    expect(sdk.declarations).toMatchSnapshot("declarations");
    expect(sdk.runtime).toMatchSnapshot("runtime");
    expect(sdk.manifest).toMatchSnapshot("manifest");
    expect(sdk.manifest.apps[0]?.manifestHash).toBe(fixture.manifestHash);
    expect(sdk.runtime).not.toContain("inputSchema");
    expect(sdk.runtime).not.toContain("dataSchema");
  });
  test("rejects invalid manifest names before SDK generation", () => {
    for (const value of ["bad*/name", "bad\nname", "bad\n", "bad\r\n", 'bad"; process.exit()', "bad`name", "bad${name}"]) {
      expect(() => generateCodeSdk([{ ...fixture, appId: value }], { mode: "personal" })).toThrow();
      for (const kind of ["types", "queries", "actions"] as const) {
        const invalid = { ...fixture, [kind]: fixture[kind].map((entry, i) => (i === 0 ? { ...entry, localId: value } : entry)) };
        expect(() => generateCodeSdk([invalid], { mode: "personal" })).toThrow();
      }
      for (const field of ["localId", "subject", "place"] as const) {
        const invalid = { ...fixture, events: fixture.events?.map((entry, i) => (i === 0 ? { ...entry, [field]: value } : entry)) };
        expect(() => generateCodeSdk([invalid], { mode: "personal" })).toThrow();
      }
      for (const field of ["target", "refs"] as const) {
        const invalid = {
          ...fixture,
          queries: fixture.queries.map((entry, i) =>
            i === 0 ? { ...entry, [field]: field === "target" ? value : { source: value } } : entry,
          ),
        };
        expect(() => generateCodeSdk([invalid], { mode: "personal" })).toThrow();
      }
    }
  });
  test("derives export names from app IDs rather than additional manifest fields", () => {
    const manifest = { ...fixture, exportName: 'bad*/\n"; process.exit()' };
    expect(generateCodeSdk([manifest], options)).toEqual(generated());
  });
  test("supports direct app methods beside a callable resource namespace", async () => {
    const sdk = generateCodeSdk([callableFixture()], { mode: "personal" });
    const dir = await temporaryDirectory("cloud-code-c15-callable-");
    const file = join(dir, "sdk.mjs");
    await writeFile(file, sdk.runtime);
    const loaded = await import(file);
    const calls: CodeSdkInvocation[] = [];
    loaded.__codeSdk.bind({
      async call(_operation: string, invocation: CodeSdkInvocation) {
        calls.push(invocation);
      },
    });
    expect(loaded.work_shop.type).toBe("cloud.app");
    expect(loaded.work_shop.branch("resource-branch").type).toBe("work-shop.branch");
    expect(loaded.work_shop.app).toBeUndefined();
    await loaded.work_shop.branch.create({ title: "x", idempotencyKey: "key" });
    await loaded.work_shop.branch.create.child({ itemId: "i", destination: loaded.work_shop.workshop("one") });
    expect(calls.map((value) => value.call.capability)).toEqual(["work-shop.branch.create", "work-shop.branch.create.child"]);
  });
  test("rejects app method/factory and identity conflicts", () => {
    for (const localId of ["workshop", "id", "id.read", "type", "type.read"]) {
      const conflicting = { ...fixture, queries: fixture.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId } : op)) };
      expect(() => generateCodeSdk([conflicting], { mode: "personal" })).toThrow("SDK path collision");
    }
    for (const localId of ["id", "type", "id.child", "type.child"]) {
      const conflicting = { ...fixture, types: [...fixture.types, { ...fixture.types[0]!, localId }] };
      expect(() => generateCodeSdk([conflicting], { mode: "personal" })).toThrow("SDK path collision");
    }
  });
  test("rejects duplicate target methods after prefix removal", () => {
    const operation = fixture.actions[0]!;
    const conflicting = {
      ...fixture,
      actions: [
        { ...operation, target: "workshop", localId: "workshop.move" },
        { ...operation, target: "workshop", localId: "move" },
      ],
    };
    expect(() => generateCodeSdk([conflicting], { mode: "personal" })).toThrow("SDK path collision");
  });
  test("retains typed app factories beside direct app methods", async () => {
    const appFactory = { ...fixture, types: [...fixture.types, { ...fixture.types[0]!, localId: "app" }] };
    const sdk = generateCodeSdk([appFactory], { mode: "personal" });
    expect(sdk.declarations).toContain('readonly "app": (<const Id');
    const dir = await temporaryDirectory("cloud-code-c15-app-factory-");
    const file = join(dir, "sdk.mjs");
    await writeFile(file, sdk.runtime);
    const loaded = await import(file);
    loaded.__codeSdk.bind({
      async call() {
        return { data: [] };
      },
    });
    expect(loaded.work_shop.app("App001")).toMatchObject({ type: "work-shop.app", id: "App001" });
    expect(() => loaded.work_shop.app()).toThrow();
    await expect(loaded.work_shop.catalog.list({})).resolves.toEqual({ data: [] });
  });
  test("isolates every runtime internal from application exports", async () => {
    const names = [
      "undefined",
      "manifest",
      "node",
      "handle",
      "handles",
      "bridge",
      "schedules",
      "diagnostics",
      "namespaces",
      "coordinate",
      "unavailable",
      "eval",
      "arguments",
      "ai",
      "db",
      "secrets",
      "http",
      "sheet",
    ];
    const sdk = generateCodeSdk(
      names.map((name) => sdkFixture(name)),
      { mode: "personal" },
    );
    const dir = await temporaryDirectory("cloud-code-c15-names-");
    const file = join(dir, "sdk.mjs");
    await writeFile(file, sdk.runtime);
    const loaded = await import(file);
    for (const app of sdk.manifest.apps) expect(loaded[app.exportName].id).toBe(app.appId);
    loaded.__codeSdk.bind({
      async call() {
        return { moved: true };
      },
    });
    const source = loaded._undefined.workshop("source");
    await expect(source.item.move({ itemId: "item", destination: loaded._undefined.workshop("destination") })).resolves.toEqual({
      moved: true,
    });
    loaded.app.schedule({ cron: "0 8 * * 1" }, () => {});
    expect(loaded.__codeSdk.entries()).toHaveLength(1);
  });
  test("is deterministic across catalog and contract map ordering", () => {
    const a = sdkFixture("alpha");
    const reverse = {
      ...fixture,
      types: [...fixture.types].reverse(),
      queries: [...fixture.queries].reverse(),
      actions: [...fixture.actions].reverse(),
    };
    expect(generateCodeSdk([a, reverse], options)).toEqual(generateCodeSdk([fixture, a], options));
  });
  test("returned phase metadata cannot mutate later SDK generations", () => {
    const sdk = generated();
    Reflect.set(sdk.manifest.appMethods, "get", 3);
    expect(generated().manifest.appMethods.get).toBe(1);
  });
  test("offers only operations for the fixed target type and hides forbidden entries", () => {
    const { manifest, declarations } = generated();
    expect(manifest.handles).toContainEqual({
      appId: "work-shop",
      exportName: "work_shop",
      type: "work-shop.workshop",
      factoryPath: ["workshop"],
    });
    expect(manifest.operations.find((op) => op.localId === "item.move")).toMatchObject({
      target: "work-shop.workshop",
      refs: { destination: "work-shop.workshop" },
    });
    expect(manifest.omitted).toEqual([
      { capability: "work-shop.workshop.readable", reason: "app_only" },
      { capability: "work-shop.outside.change", reason: "code_false" },
    ]);
    expect(declarations).not.toContain('"outside"');
    expect(manifest.events.map((event) => event.type)).toEqual(["work-shop.changed"]);
  });
  test("rejects duplicate apps, invalid inputs, invalid options and unknown owners", () => {
    expect(() => generateCodeSdk([fixture, fixture], options)).toThrow("Duplicate");
    expect(() => generateCodeSdk([fixture], { mode: "resource", owner: { kind: "app", appId: "missing" } })).toThrow("owner app");
    expect(() =>
      generateCodeSdk([fixture], { mode: "resource", owner: { kind: "resource", ref: { type: "missing.type", id: "id" } } }),
    ).toThrow("owner type");
    expect(() =>
      generateCodeSdk(
        [
          {
            ...fixture,
            actions: fixture.actions.map((op) =>
              op.localId === "item.create"
                ? {
                    ...op,
                    inputSchema: { type: "object", additionalProperties: false, properties: { idempotencyKey: { type: "string" } } },
                  }
                : op,
            ),
          },
        ],
        options,
      ),
    ).toThrow("reserved SDK input");
  });
  test("rejects unvalidated union inputs and mode/owner combinations", () => {
    expect(() =>
      generateCodeSdk(
        [{ ...fixture, actions: fixture.actions.map((op) => ({ ...op, inputSchema: { oneOf: [{ type: "object" }] } })) }],
        options,
      ),
    ).toThrow("closed object");
    for (const invalid of [{ mode: "resource" }, { mode: "code_run", owner: options.owner }, { mode: "unknown" }]) {
      // @ts-expect-error exercises untyped generator clients
      expect(() => generateCodeSdk([fixture], invalid)).toThrow("Invalid SDK options");
    }
  });
  test("exports an app owner handle and maps keyword app IDs to valid module exports", () => {
    const sdk = generateCodeSdk([sdkFixture("default")], { mode: "resource", owner: { kind: "app", appId: "default" } });
    expect(sdk.manifest.apps[0]?.exportName).toBe("_default");
    expect(sdk.declarations).toContain('export declare const owner: Handle0<"default">');
  });
});

describe("generated runtime through the canonical call seam", () => {
  test("lifts idempotency metadata and ref handles into a normalized call without changing arguments", async () => {
    const sdk = await runtime();
    const calls: CodeSdkInvocation[] = [];
    sdk.__codeSdk.bind({
      async call(operation, invocation) {
        if (!("call" in invocation)) throw new Error("Expected a capability call");
        expect(operation).toBe(invocation.call.capability);
        // workerd RPC rejects null-prototype objects even when structuredClone accepts them.
        expect(Object.getPrototypeOf(invocation.call.refs)).toBe(Object.prototype);
        expect(structuredClone(invocation)).toEqual(invocation);
        calls.push(invocation);
        return { id: "created" };
      },
    });
    expect(() => Reflect.apply(sdk.work_shop.workshop, undefined, ["one", "two"])).toThrow("code_sdk_invalid_id");
    const source = sdk.work_shop.workshop("source");
    const destination = sdk.work_shop.workshop("destination");
    const input = { title: "Hello", idempotencyKey: " invoice:fixed " };
    expect(await source.item.create(input)).toEqual({ id: "created" });
    expect(input).toEqual({ title: "Hello", idempotencyKey: " invoice:fixed " });
    expect(calls[0]).toEqual({
      call: {
        capability: "work-shop.item.create",
        target: { type: "work-shop.workshop", id: "source" },
        refs: {},
        input: { title: "Hello" },
      },
      metadata: { idempotencyKey: "invoice:fixed" },
    });
    await source.item.move({ itemId: "item-1", destination });
    const expected = normalizeCapabilityCall("work-shop", fixture.actions.find((op) => op.localId === "item.move")!, {
      target: { type: "work-shop.workshop", id: "source" },
      refs: { destination: { type: "work-shop.workshop", id: "destination" } },
      input: { itemId: "item-1" },
    });
    expect(calls[1]?.call).toEqual(expected);
    expect(capabilityCallDigest(calls[1]!.call)).toBe(capabilityCallDigest(expected));
    await sdk.owner.item.create({ title: "Owned", idempotencyKey: "owned:fixed" });
    expect(calls[2]?.call.target?.id).toBe("owner-shop");
    await sdk.work_shop.catalog.list({});
    expect(calls[3]?.call.target).toBeNull();
    expect(source).not.toHaveProperty("catalog");
    expect(sdk.work_shop.item("item")).not.toHaveProperty("stock");
  });
  test("preserves literal ref-field names through SDK generation and canonical calls", async () => {
    const fields = ["parent-id", "ziel ordner", '*/\n"; process.exit(); ` ${value}'];
    const manifest = {
      ...fixture,
      actions: fixture.actions.map((op) =>
        op.localId === "item.move" ? { ...op, refs: Object.fromEntries(fields.map((field) => [field, "workshop"])) } : op,
      ),
    };
    const sdk = await runtime(options, manifest);
    const calls: CodeSdkInvocation[] = [];
    sdk.__codeSdk.bind({
      async call(_operation, invocation) {
        if (!("call" in invocation)) throw new Error("Expected a capability call");
        calls.push(invocation);
        return { moved: true };
      },
    });
    const destination = sdk.work_shop.workshop("destination");
    const input = { itemId: "item", ...Object.fromEntries(fields.map((field) => [field, destination])) };
    expect(await sdk.owner.item.move(input)).toEqual({ moved: true });
    const expected = normalizeCapabilityCall("work-shop", manifest.actions.find((op) => op.localId === "item.move")!, {
      target: options.owner?.kind === "resource" ? options.owner.ref : null,
      refs: Object.fromEntries(fields.map((field) => [field, { type: "work-shop.workshop", id: "destination" }])),
      input: { itemId: "item" },
    });
    expect(calls[0]?.call).toEqual(expected);
    expect(Object.keys(input)).toEqual(["itemId", ...fields]);
  });
  test("fails visibly on missing keys, forged/wrong refs, absent bridge and downstream refusals", async () => {
    const sdk = await runtime();
    await expect(sdk.owner.item.create({ title: "test", idempotencyKey: "key" })).rejects.toThrow("bridge_unbound");
    sdk.__codeSdk.bind({
      async call() {
        throw new Error("permission_denied");
      },
    });
    await expect(sdk.owner.item.create({ title: "test" })).rejects.toThrow("idempotency_required");
    await expect(sdk.owner.item.move({ itemId: "item", destination: sdk.owner, idempotencyKey: "not-allowed" })).rejects.toThrow(
      "idempotency_not_allowed",
    );
    for (const destination of ["id", { type: "work-shop.workshop", id: "id" }, sdk.work_shop.item("item")]) {
      await expect(sdk.owner.item.move({ itemId: "item", destination })).rejects.toThrow("invalid_handle");
    }
    await expect(sdk.owner.item.create({ title: "test", idempotencyKey: "key" })).rejects.toThrow("permission_denied");
    for (const key of ["rechnung:Müller", "x".repeat(201), "white space", "\t"]) {
      await expect(sdk.owner.item.create({ title: "test", idempotencyKey: key })).rejects.toThrow(/idempotency/);
    }
    expect(() => sdk.work_shop.workshop("")).toThrow("invalid_id");
    expect(() => sdk.__codeSdk.bind({ async call() {} })).toThrow("invalid_bridge");
  });
  test("registers schedules without executing them", async () => {
    const sdk = await runtime();
    let calls = 0;
    sdk.app.schedule({ cron: "0 8 * * 1" }, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(sdk.__codeSdk.entries()).toEqual([{ kind: "schedule", entrypoint: "schedule:0", cron: "0 8 * * 1" }]);
    await sdk.__codeSdk.run("schedule:0");
    expect(calls).toBe(1);
    sdk.app.schedule({ cron: "0 9 * * 1", name: "weekly-review", title: "  Weekly review  " }, () => {});
    expect(sdk.__codeSdk.entries()[1]).toEqual({
      kind: "schedule",
      entrypoint: "weekly-review",
      cron: "0 9 * * 1",
      title: "Weekly review",
    });
    await sdk.__codeSdk.run("weekly-review");
    expect(() => sdk.app.schedule({ cron: "0 9 * * 1", name: "weekly-review" }, () => {})).toThrow("duplicate_schedule_name");
    expect(() => sdk.app.schedule({ cron: "0 9 * * 1", name: "bad name" }, () => {})).toThrow("invalid_schedule_name");
    expect(() => sdk.app.schedule({ cron: "0 9 * * 1", name: "invalid-title", title: "<b>Bad</b>" }, () => {})).toThrow(
      "invalid_schedule_title",
    );
    await expect(sdk.__codeSdk.run("missing")).rejects.toThrow("missing_entrypoint");
    sdk.app.get("/", () => new Response("ok"));
    expect(sdk.__codeSdk.diagnostics()).toEqual([]);
  });
  test("code_run has no app or owner and accepts arbitrary runtime IDs", async () => {
    const sdk = await runtime({ mode: "code_run" });
    expect(sdk).not.toHaveProperty("app");
    expect(sdk).not.toHaveProperty("owner");
    expect(sdk.work_shop.workshop(["arbitrary-id"].join("")).id).toBe("arbitrary-id");
  });
});

test("schema projection preserves recursive refs, tuples, literals and maps", () => {
  const root = {
    type: "object",
    properties: {
      next: { $ref: "#" },
      point: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }], minItems: 1, items: false },
    },
    additionalProperties: false,
  };
  const result = schemaTypes(root, "Node");
  expect(result.type).toContain("NodeRef0");
  expect(result.declarations[0]).toContain("number");
  const input = schemaTypes(root, "RecursiveInput", [{ name: "idempotencyKey", type: "string", required: true }]);
  expect(input.type).toContain("idempotencyKey");
  expect(input.declarations.join("\n")).not.toContain("idempotencyKey");
  expect(schemaTypes({ type: "object", additionalProperties: { type: "number" } }, "Map").type).toContain("[key: string]: (number)");
  expect(
    schemaTypes({ type: "object", patternProperties: { "^x-": { type: "number" } }, additionalProperties: false }, "Pattern").type,
  ).toContain("[key: string]: (number)");
  expect(() => schemaTypes({ $ref: "https://example.invalid" }, "External")).toThrow("only local");
  expect(() => schemaTypes({ $ref: "#/$defs/missing" }, "Missing")).toThrow("unresolved");
});

test("generated SDKs compile with tsgo and accept dynamic resource IDs and reject missing keys and wrong handle methods", async () => {
  const dir = await temporaryDirectory("cloud-code-c15-types-");
  const resource = generated();
  const personal = generateCodeSdk([fixture], { mode: "personal" });
  const once = generateCodeSdk([fixture], { mode: "code_run" });
  const literal = '*/\n"; process.exit(); ` ${value}';
  const literalSdk = generateCodeSdk(
    [
      {
        ...fixture,
        queries: fixture.queries.map((op) => ({
          ...op,
          refs: { [literal]: "workshop" },
          dataSchema: {
            type: "object",
            properties: { [literal]: { const: literal } },
            required: [literal],
            additionalProperties: false,
          },
        })),
      },
    ],
    options,
  );
  await Promise.all([
    writeFile(join(dir, "literals.d.ts"), literalSdk.declarations),
    writeFile(join(dir, "resource.d.ts"), resource.declarations),
    writeFile(join(dir, "personal.d.ts"), personal.declarations),
    writeFile(join(dir, "once.d.ts"), once.declarations),
    writeFile(
      join(dir, "app-factory.d.ts"),
      generateCodeSdk([{ ...fixture, types: [...fixture.types, { ...fixture.types[0]!, localId: "app" }] }], { mode: "personal" })
        .declarations,
    ),
    writeFile(join(dir, "callable.d.ts"), generateCodeSdk([callableFixture()], { mode: "personal" }).declarations),
    writeFile(
      join(dir, "reserved.d.ts"),
      generateCodeSdk([sdkFixture("eval"), sdkFixture("arguments"), sdkFixture("manifest")], { mode: "personal" }).declarations,
    ),
    writeFile(join(dir, "ids.ts"), 'export const workshop = "imported-shop";\n'),
    writeFile(
      join(dir, "valid.ts"),
      `import { app, work_shop, owner, Chart, type CodeChartDescription, type CodePageTree } from "@sdk";
// @ts-expect-error Button is the only button component
import { Action } from "@sdk";
import { work_shop as personal } from "./personal";
import { work_shop as once } from "./once";
import { workshop } from "./ids";
import { work_shop as callable } from "./callable";
import { work_shop as appFactory } from "./app-factory";
const appHandle = appFactory.app("App001");
const appType: "work-shop.app" = appHandle.type;
const appId: "App001" = appHandle.id;
appFactory.catalog.list({});
// @ts-expect-error only the typed app(id) factory exists
appFactory.app();
import { _eval, _arguments, manifest } from "./reserved";
import { work_shop as literals } from "./literals";
literals.catalog.list({ [${JSON.stringify(literal)}]: literals.workshop("destination") });
_eval.catalog.list({}); _arguments.catalog.list({}); manifest.catalog.list({});
callable.branch("resource");
callable.branch.create({ title: "x", idempotencyKey: "key" });
callable.branch.create.child({ itemId: "i", destination: callable.workshop("one") });
const grid: CodeChartDescription = { kind: "heatmap", title: "Grid", data: [{ x: "A", y: "B", value: 1 }] };
const calendar: CodeChartDescription = { kind: "heatmap", title: "Calendar", layout: "calendar", data: [["2026-11-07", 1]], scale: "sequential" };
const grouped: CodeChartDescription = { kind: "bar", title: "Orders", x: ["A"], series: [{ label: "Shop", data: [10] }], layout: "grouped" };
Chart.Bar({ title: "Compared orders", x: ["A"], series: [{ label: "Shop", data: [10] }], compare: { label: "Before", data: [8] } });
Chart.Line({ title: "Forecast", series: [{ data: [{ x: 1, y: 10 }, { x: 2, y: null }] }], forecast: { from: 2 }, marker: { at: 2, label: "Today" } });
const forecastPage: CodePageTree = { kind: "Page", version: 1, title: "Forecast", children: [{ kind: "Chart", description: { kind: "line", title: "Gaps", series: [{ data: [{ x: 1, y: null }, { x: 2, y: 10 }] }], zero: true } }] };
const dots: CodeChartDescription = { kind: "bar", title: "Counts", marks: "dots", layout: "nested", total: 100, dots: 20, x: ["A"], series: [{ label: "Opened", data: [80] }, { label: "Clicked", data: [30] }] };
Chart.Bar({ title: dots.title, marks: "dots", layout: "nested", total: 100, dots: 20, x: ["A"], series: [{ label: "Opened", data: [80] }, { label: "Clicked", data: [30] }] });
// @ts-expect-error dot matrices are a bar option, not a new portable kind
const invalidDots: CodeChartDescription = { kind: "dots", title: "Invalid" };
const flow: CodeChartDescription = { kind: "sankey", title: "Flow", nodes: [{ id: "in", label: "In", tone: "in" }, { id: "out", label: "Out" }], links: [{ source: "in", target: "out", value: 42 }] };
Chart.Sankey({ title: "Flow", nodes: flow.nodes, links: flow.links, legend: [{ tone: "in", label: "Incoming" }] });
// @ts-expect-error Sankey node tones stay within the portable chart contract
Chart.Sankey({ title: "Flow", nodes: [{ id: "in", label: "In", tone: "purple" }], links: [] });
// @ts-expect-error chart builders expose chart props, not the transport description prop
Chart.Bar({ title: "Orders", data: [{ label: "A", value: 1 }], description: { kind: "bar" } });
// @ts-expect-error omitting kind from builder props must preserve the named series type
Chart.Line({ title: "Orders", series: "none" });
// @ts-expect-error an unrecognized heatmap layout is forbidden
const invalidChart: CodeChartDescription = { kind: "heatmap", title: "Invalid", layout: "other", data: [{ x: "A", y: "B", value: 1 }] };
const ids = ["one", "two"] as const;
const target = work_shop.workshop(ids[0]);
work_shop.workshop(workshop);
work_shop.workshop(ids[Math.floor(0)]!);
target.item.create({ title: "Hi", idempotencyKey: "fixed", details: { kind: "count", count: 2 } });
target.item.move({ itemId: "i", destination: owner });
work_shop.item("item").inspect({});
// @ts-expect-error idempotency:none forbids a key
work_shop.item("item").inspect({ idempotencyKey: "forbidden" });
const literal: "owner-shop" = owner.id;
async function typedResult() {
  const result = await target.stock.list({});
  const state: "ready" | "empty" = result.data.rows[0]!.state;
  if (result.page?.hasMore) {
    const cursor: string = result.page.nextCursor;
    await target.stock.list({ cursor });
  }
  // @ts-expect-error a final page has no cursor
  if (result.page && !result.page.hasMore) result.page.nextCursor;
  // @ts-expect-error pagination is outside domain data
  result.data.page;
  // @ts-expect-error result state is not an arbitrary number
  const invalid: number = result.data.rows[0]!.state;
}
declare const dynamic: string;
personal.workshop(dynamic);
once.workshop(dynamic);
app.schedule({ cron: "0 8 * * 1" }, async () => { await owner.item.create({ title: "Hi", idempotencyKey: "fixed" }); });
app.on("work-shop.changed", async event => { const title: string = event.data.title; });
app.get("/", c => {
  if (c.user) {
    const kind: "user" | "guest" = c.user.kind;
    // @ts-expect-error identity provider internals are not exposed
    c.user.provider;
    // @ts-expect-error ambiguous groups was removed
    c.user.groups;
    const username: string = c.user.username;
    const groupIds: string[] = c.user.groupIds;
    const groupNames: string[] = c.user.groupNames;
    const name: string = c.user.name;
    // @ts-expect-error no credentials in visitor identity
    c.user.token;
  }
  return c.json({ groupIds: c.user?.groupIds });
});
app.post("/", c => c.text(c.req.param("id")));
app.put("/", c => c.text("ok"));
app.delete("/", c => c.redirect("/"));
app.all("/", c => c.text("ok"));
// @ts-expect-error removed app member
app.nav(() => []);
// @ts-expect-error removed app member
app.webhook("/hook", () => new Response());
// @ts-expect-error removed app member
app.fetch(new Request("https://example.invalid"));
// @ts-expect-error required idempotency key
owner.item.create({ title: "missing key" });
work_shop.workshop(dynamic);
work_shop.workshop(\`shop-\${dynamic}\`);
declare const branded: string & { readonly brand: unique symbol };
work_shop.workshop(branded);
declare const condition: boolean;
work_shop.workshop(condition ? "fixed" : branded);
work_shop.workshop(condition ? "fixed" : (\`x\${dynamic}\` as const));
work_shop.workshop(condition ? "first" : "second");
for (const id of ids) work_shop.workshop(id);
// @ts-expect-error wrong handle type
work_shop.item("item").item.create({ title: "Hi", idempotencyKey: "fixed" });
// @ts-expect-error plain ID instead of ref handle
owner.item.move({ itemId: "i", destination: "one" });
// @ts-expect-error fabricated structural ref has no handle brand
owner.item.move({ itemId: "i", destination: { type: "work-shop.workshop", id: "one" } });
// @ts-expect-error code:false is not offered
owner.outside.change({});
const file = await owner.stock.export({});
const size: number = file.size;
// @ts-expect-error FileRef has no bytes
file.arrayBuffer();
// @ts-expect-error FileRef has no URL
file.url;
// @ts-expect-error app-wide operation is not on resource handle
owner.catalog.list({});
// @ts-expect-error code_run has no app
import { app as noApp } from "./once";
// @ts-expect-error invalid discriminated input
owner.item.create({ title: "Hi", idempotencyKey: "fixed", details: { kind: "count", text: "bad" } });
`,
    ),
    writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          paths: { "@sdk": ["./resource.d.ts"] },
          types: [],
          skipLibCheck: false,
        },
        files: ["valid.ts"],
      }),
    ),
  ]);
  const compiler = resolve(import.meta.dir, "../../../../node_modules/.bin/tsc");
  const proc = Bun.spawn([compiler, "--checkers", "1", "--project", join(dir, "tsconfig.json"), "--pretty", "false"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("stream SDK inputs use branded FileRefs and pass only references through cloud.call", async () => {
  const sdk = generateCodeSdk([fixture, fileImportManifest()], options);
  const dir = await temporaryDirectory("cloud-code-files-");
  await writeFile(join(dir, "sdk.mjs"), sdk.runtime);
  const loaded = await import(join(dir, "sdk.mjs"));
  const calls: CodeSdkInvocation[] = [];
  const file = { id: "opaque-reference", name: "invoice.pdf", mediaType: "application/pdf", size: 5_000_000 };
  loaded.__codeSdk.bind({
    call: async (_operation: string, input: CodeSdkInvocation) => {
      calls.push(input);
      return input.call.capability.endsWith("stock.export") ? file : { imported: true };
    },
  });
  const ref = await loaded.owner.stock.export({});
  expect(await loaded.imports.import({ file: ref, idempotencyKey: "invoice-1" })).toEqual({ imported: true });
  expect(calls[1]).toMatchObject({ call: { input: { file } }, metadata: { idempotencyKey: "invoice-1" } });
  expect(JSON.stringify(calls).length).toBeLessThan(1024);
  await writeFile(join(dir, "sdk.d.ts"), sdk.declarations);
  await writeFile(
    join(dir, "types.ts"),
    `import { owner, imports, type FileRef } from "./sdk";
const file: FileRef = await owner.stock.export({});
const result = await imports.import({ file, idempotencyKey: "invoice-1" });
const imported: boolean = result.imported;
// @ts-expect-error metadata alone cannot manufacture a FileRef
imports.import({ file: { id: "forged", mediaType: "application/pdf", size: 1 }, idempotencyKey: "k" });
// @ts-expect-error a file input cannot be omitted
imports.import({ idempotencyKey: "k" });
// @ts-expect-error the FileRef has no download URL
file.url;
// @ts-expect-error the FileRef has no body
file.body;
`,
  );
  const proc = Bun.spawn(
    [
      resolve(import.meta.dir, "../../../../node_modules/.bin/tsc"),
      "--checkers",
      "1",
      "--ignoreConfig",
      "--strict",
      "--noEmit",
      "--target",
      "esnext",
      "--module",
      "preserve",
      join(dir, "types.ts"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("SDK secrets contain only placeholders and HTTP dispatches those placeholders unchanged", async () => {
  const sdk = await runtime();
  const calls: unknown[] = [];
  sdk.__codeSdk.bind({
    async call(operation, input) {
      calls.push({ operation, input });
      return { status: 200, headers: {}, body: "" };
    },
  });
  expect(sdk.secrets.API).toBe("[secret:API]");
  expect(String(sdk.secrets.constructor)).toBe("[secret:constructor]");
  sdk.http.allow(["https://api.example"]);
  await sdk.http.fetch("https://api.example/v1", { headers: { authorization: "Bearer " + sdk.secrets.API } });
  expect(calls).toEqual([
    { operation: "http.fetch", input: { method: "GET", url: "https://api.example/v1", headers: { authorization: "Bearer [secret:API]" } } },
  ]);
  expect(() => sdk.secrets["bad name"]).toThrow("code_sdk_invalid_secret_name");
});

test("resource app.on registers one checked event and passes its reference envelope", async () => {
  const manifest = sdkFixture();
  manifest.events![0]!.place = "workshop";
  const sdk = await runtime(options, manifest);
  const seen: unknown[] = [];
  sdk.app.on("work-shop.changed", (input) => {
    seen.push(input);
  });
  expect(seen).toEqual([]);
  const input = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "work-shop.changed",
    version: 1,
    source: "work-shop",
    time: "2026-01-01T00:00:00Z",
    subject: { type: "work-shop.workshop", id: "owner-shop" },
    place: { type: "work-shop.workshop", id: "owner-shop" },
    data: { title: "fixture" },
  };
  await sdk.__codeSdk.run("event:work-shop.changed@1", input);
  expect(seen).toEqual([input]);
  await expect(sdk.__codeSdk.run("event:work-shop.changed@1", { ...input, place: { ...input.place, id: "other" } })).rejects.toThrow(
    "code_event_input",
  );
  expect(() => sdk.app.on("work-shop.changed", () => {})).toThrow("code_duplicate_on");
});

test("foreign app.on registrations reject duplicate pairs and keep distinct places", async () => {
  const manifest = sdkFixture();
  manifest.events![0]!.place = "workshop";
  const sdk = await runtime({ mode: "personal" }, manifest);
  sdk.app.on(sdk.work_shop.workshop("one"), "work-shop.changed", () => {});
  sdk.app.on(sdk.work_shop.workshop("two"), "work-shop.changed", () => {});
  expect(sdk.__codeSdk.entries().map((entry) => entry.entrypoint)).toEqual([
    "event:work-shop.changed@1:place:0",
    "event:work-shop.changed@1:place:1",
  ]);
  expect(() => sdk.app.on(sdk.work_shop.workshop("one"), "work-shop.changed", () => {})).toThrow("code_duplicate_on");
});
