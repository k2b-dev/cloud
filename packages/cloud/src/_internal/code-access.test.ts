import { expect, test } from "bun:test";
import { z } from "zod";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CapabilityManifestSchema, CloudResourceReaderViewSchema } from "../contracts/capabilities";
import type { CodeAccessAdapter } from "../contracts/code-access";
import { compileCapabilities, invokeCompiledCapability } from "./capabilities";
import { validateCodeAccess } from "./code-access";

const adapter: CodeAccessAdapter = {
  manages: () => true,
  grant: () => ({ granted: true, level: "write" }),
  revoke: () => true,
  list: () => [],
};
const reader = {
  title: "Read item",
  description: "Read the authorized item.",
  input: z.object({ id: z.string().min(1).max(512) }).strict(),
  data: z.object({ view: CloudResourceReaderViewSchema }),
  openWorld: false,
  run: async () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "read" as const } } } }),
};
const definitions: CapabilityDefinitions = {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "An item.", reader: "item.read", access: { readable: () => [], ...adapter } } },
  queries: { "item.read": reader },
  code: { owners: ["item"], access: { app: adapter } },
};
test("generates one set/list/rm and advertises target and owner contracts", () => {
  const compiled = compileCapabilities("inventory", definitions);
  expect([...compiled.actions.keys()]).toEqual(["code.access.rm", "code.access.set"]);
  expect([...compiled.queries.keys()]).toEqual(["code.access.list", "item.read", "item.readable"]);
  expect(compiled.manifest.code).toEqual({ access: { app: true, types: ["item"] }, owners: ["item"] });
  expect(CapabilityManifestSchema.parse(compiled.manifest).code).toEqual(compiled.manifest.code);
  expect(compiled.queries.get("item.readable")?.manifest.appOnly).toBe(true);
  expect(compiled.queries.get("code.access.list")?.manifest.appOnly).toBeUndefined();
  for (const entry of compiled.actions.values()) {
    expect(entry.definition.policy).toEqual({ ask: "changes_access" });
    expect(entry.manifest).toMatchObject({ unattended: false, code: false, review: true });
  }
});
test("readable stays independent; four Code functions are all or none", () => {
  const readableOnly = {
    ...definitions,
    code: undefined,
    types: { item: { ...definitions.types!.item!, access: { readable: () => [] } } },
  };
  expect(compileCapabilities("inventory", readableOnly).actions.size).toBe(0);
  for (const missing of ["manages", "grant", "revoke", "list"]) {
    const access = { ...adapter };
    Reflect.deleteProperty(access, missing);
    expect(() => validateCodeAccess({ ...definitions, types: { item: { ...definitions.types!.item!, access } } })).toThrow(
      "all be supplied",
    );
    expect(() => validateCodeAccess({ ...definitions, code: { access: { app: access } } })).toThrow("all be supplied");
  }
});
test("startup refuses access or owners without a declared reader and collisions", () => {
  expect(() => compileCapabilities("inventory", { ...definitions, code: { owners: ["missing"] } })).toThrow(/declared type with a reader/);
  expect(() =>
    compileCapabilities("inventory", { ...definitions, types: { item: { ...definitions.types!.item!, reader: undefined } } }),
  ).toThrow(/reader/);
  expect(() =>
    compileCapabilities("inventory", { ...definitions, types: { item: { ...definitions.types!.item!, reader: "missing" } } }),
  ).toThrow(/existing Query/);
  expect(() =>
    compileCapabilities("inventory", { ...definitions, queries: { ...definitions.queries, "code.access.set": reader } }),
  ).toThrow(/collides/);
  expect(() => validateCodeAccess({ ...definitions, code: { access: { app: { ...adapter, grant: undefined! } } } })).toThrow(
    /must be a function/,
  );
});
test("an app with resources:readers authority cannot call the Code functions", async () => {
  const compiled = compileCapabilities("inventory", definitions);
  const context = {
    actor: { kind: "app" as const, appId: "consumer" },
    user: null,
    accessSubject: { type: "none" as const },
    locale: "en",
    requestId: "request",
    origin: "app" as const,
    signal: new AbortController().signal,
  };
  for (const [kind, localId, input] of [
    ["query", "code.access.list", { principal: "11111111-1111-4111-8111-111111111111" }],
    ["action", "code.access.rm", { grantId: "22222222-2222-4222-8222-222222222222" }],
  ] as const) {
    const op = (kind === "query" ? compiled.queries : compiled.actions).get(localId)!;
    expect(
      await invokeCompiledCapability({ compiled, kind, localId, input, expectedSchemaHash: op.manifest.schemaHash, context }),
    ).toMatchObject({ ok: false, error: { status: 403 } });
  }
});
