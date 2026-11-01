import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capabilityCallDigest, normalizeCapabilityCall } from "../capabilities/calls";
import type { CodeHttp } from "./authoring-types";
import { generateCodeSdk } from "./generator";
import { schemaTypes } from "./schema-types";
import { sdkFixture } from "./sdk.test-fixture";
import { type CodeSdkBridge, type CodeSdkInvocation, type CodeSdkOptions, codeSdkPhaseDiagnostic } from "./types";

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
  work_shop: { workshop(id: string): TestHandle; item(id: string): object; app(): { catalog: { list(input: object): Promise<unknown> } } };
  owner: TestHandle;
  app: {
    schedule(cron: string, fn: () => void | Promise<void>, options?: { name: string }): unknown;
    get(path: string, fn: () => Response): unknown;
  };
  __codeSdk: {
    bind(bridge: CodeSdkBridge): void;
    entries(): Array<{ kind: string; entrypoint: string; cron: string }>;
    diagnostics(): Array<{ message: string }>;
    run(entrypoint: string): Promise<unknown>;
  };
};
async function runtime(mode: CodeSdkOptions = options): Promise<TestModule> {
  const sdk = generateCodeSdk([fixture], mode);
  const dir = await temporaryDirectory("cloud-code-c15-runtime-");
  const file = join(dir, "sdk.mjs");
  await writeFile(file, sdk.runtime);
  return import(file);
}

function callableFixture() {
  return {
    ...fixture,
    types: [...fixture.types, { ...fixture.types[0]!, localId: "app" }],
    actions: fixture.actions.map((op) =>
      op.localId === "item.create"
        ? { ...op, localId: "branch", target: undefined }
        : op.localId === "item.move"
          ? { ...op, localId: "branch.child", target: undefined }
          : op,
    ),
  };
}

describe("Code SDK generation", () => {
  test("snapshots a complete SDK generated from a third-party capability contract", () => {
    const sdk = generated();
    expect(sdk.declarations).toMatchSnapshot("declarations");
    expect(sdk.runtime).toMatchSnapshot("runtime");
    expect(sdk.manifest).toMatchSnapshot("manifest");
    expect(sdk.runtime).not.toContain("inputSchema");
    expect(sdk.runtime).not.toContain("dataSchema");
  });
  test("supports callable namespaces and overloaded app factories", async () => {
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
    expect(loaded.work_shop.app().type).toBe("cloud.app");
    expect(loaded.work_shop.app("resource-app").type).toBe("work-shop.app");
    await loaded.work_shop.app().branch({ title: "x", idempotencyKey: "key" });
    await loaded.work_shop.app().branch.child({ itemId: "i", destination: loaded.work_shop.workshop("one") });
    expect(calls.map((value) => value.call.capability)).toEqual(["work-shop.branch", "work-shop.branch.child"]);
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
    for (const app of sdk.manifest.apps) expect(loaded[app.exportName].app().id).toBe(app.appId);
    loaded.__codeSdk.bind({
      async call() {
        return { moved: true };
      },
    });
    const source = loaded._undefined.workshop("source");
    await expect(source.item.move({ itemId: "item", destination: loaded._undefined.workshop("destination") })).resolves.toEqual({
      moved: true,
    });
    loaded.app.schedule("0 8 * * 1", () => {});
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
    expect(generated().manifest.appMethods.get).toBe(2);
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
      { capability: "work-shop.stock.export", reason: "stream" },
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
        calls.push(invocation);
        return { id: "created" };
      },
    });
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
    await sdk.work_shop.app().catalog.list({});
    expect(calls[3]?.call.target).toBeNull();
    expect(source).not.toHaveProperty("catalog");
    expect(sdk.work_shop.item("item")).not.toHaveProperty("stock");
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
  test("registers schedules without executing them and refuses Phase 2/3 APIs", async () => {
    const sdk = await runtime();
    let calls = 0;
    sdk.app.schedule("0 8 * * 1", async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(sdk.__codeSdk.entries()).toEqual([{ kind: "schedule", entrypoint: "schedule:0", cron: "0 8 * * 1" }]);
    await sdk.__codeSdk.run("schedule:0");
    expect(calls).toBe(1);
    sdk.app.schedule("0 9 * * 1", () => {}, { name: "weekly-review" });
    expect(sdk.__codeSdk.entries()[1]?.entrypoint).toBe("weekly-review");
    await sdk.__codeSdk.run("weekly-review");
    expect(() => sdk.app.schedule("0 9 * * 1", () => {}, { name: "weekly-review" })).toThrow("duplicate_schedule_name");
    expect(() => sdk.app.schedule("0 9 * * 1", () => {}, { name: "bad name" })).toThrow("invalid_schedule_name");
    await expect(sdk.__codeSdk.run("missing")).rejects.toThrow("missing_entrypoint");
    expect(() => sdk.app.get("/", () => new Response("ok"))).toThrow("kommt in Phase 2");
    expect(sdk.__codeSdk.diagnostics()).toMatchObject([{ message: "app.get kommt in Phase 2" }]);
    expect(codeSdkPhaseDiagnostic("on")?.message).toBe("app.on kommt in Phase 3");
    expect(codeSdkPhaseDiagnostic("schedule")).toBeNull();
    expect(codeSdkPhaseDiagnostic("typo")).toBeNull();
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

test("generated SDKs compile with tsgo and reject missing keys, dynamic resource IDs and wrong handle methods", async () => {
  const dir = await temporaryDirectory("cloud-code-c15-types-");
  const resource = generated();
  const personal = generateCodeSdk([fixture], { mode: "personal" });
  const once = generateCodeSdk([fixture], { mode: "code_run" });
  await Promise.all([
    writeFile(join(dir, "resource.d.ts"), resource.declarations),
    writeFile(join(dir, "personal.d.ts"), personal.declarations),
    writeFile(join(dir, "once.d.ts"), once.declarations),
    writeFile(join(dir, "callable.d.ts"), generateCodeSdk([callableFixture()], { mode: "personal" }).declarations),
    writeFile(
      join(dir, "reserved.d.ts"),
      generateCodeSdk([sdkFixture("eval"), sdkFixture("arguments"), sdkFixture("manifest")], { mode: "personal" }).declarations,
    ),
    writeFile(join(dir, "ids.ts"), 'export const workshop = "imported-shop";\n'),
    writeFile(
      join(dir, "valid.ts"),
      `import { app, work_shop, owner } from "@sdk";
import { work_shop as personal } from "./personal";
import { work_shop as once } from "./once";
import { workshop } from "./ids";
import { work_shop as callable } from "./callable";
import { _eval, _arguments, manifest } from "./reserved";
_eval.app(); _arguments.app(); manifest.app();
callable.app("resource");
callable.app().branch({ title: "x", idempotencyKey: "key" });
callable.app().branch.child({ itemId: "i", destination: callable.workshop("one") });
const ids = ["one", "two"] as const;
const target = work_shop.workshop(ids[0]);
work_shop.workshop(workshop);
work_shop.workshop(ids[Math.floor(0)]!);
target.item.create({ title: "Hi", idempotencyKey: "fixed", details: { kind: "count", count: 2 } });
target.item.move({ itemId: "i", destination: owner });
work_shop.item("item").item.inspect({});
// @ts-expect-error idempotency:none forbids a key
work_shop.item("item").item.inspect({ idempotencyKey: "forbidden" });
const literal: "owner-shop" = owner.id;
async function typedResult() {
  const result = await target.stock.list({});
  const state: "ready" | "empty" = result.rows[0]!.state;
  const next: string | null = result.next;
  // @ts-expect-error result state is not an arbitrary number
  const invalid: number = result.rows[0]!.state;
}
declare const dynamic: string;
personal.workshop(dynamic);
once.workshop(dynamic);
app.schedule("0 8 * * 1", async () => { await owner.item.create({ title: "Hi", idempotencyKey: "fixed" }); });
app.on("work-shop.changed", async event => { const title: string = event.title; });
app.get("/", c => c.json({ groups: c.user.groups }));
app.post("/", c => c.text(c.req.param("id")));
app.put("/", c => c.html("ok"));
app.delete("/", c => c.redirect("/"));
app.all("/", c => c.text("ok"));
app.nav(user => [{ title: user.id, path: "/" }]);
app.webhook("/hook", async c => c.json({ verified: await c.verify("secret") }));
app.fetch(new Request("https://example.invalid"));
// @ts-expect-error required idempotency key
owner.item.create({ title: "missing key" });
// @ts-expect-error dynamic resource handle ID
work_shop.workshop(dynamic);
// @ts-expect-error dynamic template ID
work_shop.workshop(\`shop-\${dynamic}\`);
declare const branded: string & { readonly brand: unique symbol };
// @ts-expect-error branded dynamic string
work_shop.workshop(branded);
declare const condition: boolean;
// @ts-expect-error mixed literal and branded dynamic union
work_shop.workshop(condition ? "fixed" : branded);
// @ts-expect-error mixed literal and dynamic template union
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
// @ts-expect-error streams are not offered
owner.stock.export({});
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
  await sdk.http.fetch("https://api.example/v1", { headers: { authorization: "Bearer " + sdk.secrets.API } });
  expect(calls).toEqual([
    { operation: "http.fetch", input: { method: "GET", url: "https://api.example/v1", headers: { authorization: "Bearer [secret:API]" } } },
  ]);
  expect(() => sdk.secrets["bad name"]).toThrow("code_sdk_invalid_secret_name");
});
