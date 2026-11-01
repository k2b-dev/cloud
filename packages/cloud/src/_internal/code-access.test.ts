import { expect, test } from "bun:test";
import { z } from "zod";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CapabilityManifestSchema, CloudResourceReaderViewSchema } from "../contracts/capabilities";
import type { CodeAccessAdapter } from "../contracts/code-access";
import { codeAccessMessages } from "../shared/code-access-messages";
import { compileCapabilities, invokeCompiledCapability, resolveCapabilityManifestPresentation } from "./capabilities";
import { codeAccessOperationsAllowed, validateCodeAccess } from "./code-access";

const adapter: CodeAccessAdapter = {
  manages: () => true,
  grant: () => ({ granted: true, level: "write" }),
  revoke: () => true,
  list: () => [],
};
const reader = {
  title: "Read item",
  description: "Read the authorized item.",
  input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
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
  expect(compiled.presentation?.translations.de?.actions?.["code.access.set"]?.title).toBe("Code-Zugriff gewähren");
  expect(
    compileCapabilities("inventory", { ...definitions, presentation: { baseLocale: "EN", translations: {} } }).presentation?.baseLocale,
  ).toBe("en");
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
    expect(() => compileCapabilities("inventory", { protocolVersion: 2, queries: { "code.access.list": reader } })).toThrow(
      /reserved Code access namespace/,
    );
    expect(() => validateCodeAccess({ ...definitions, code: { access: { app: access } } })).toThrow("all be supplied");
  }
});

test("generated inputs have complete German presentation for every adapter and preserve app overrides", () => {
  const copy = codeAccessMessages("de");
  for (const baseLocale of ["en", "de"]) {
    const compiled = compileCapabilities("inventory", { ...definitions, presentation: { baseLocale, translations: {} } });
    const manifest = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de-DE");
    expect(manifest.actions.find((op) => op.localId === "code.access.set")?.inputSchema).toMatchObject({
      properties: {
        proof: { description: copy.setInput.proof },
        target: {
          description: copy.setInput.target,
          properties: { type: { description: copy.setInput["target.type"] }, id: { description: copy.setInput["target.id"] } },
        },
        operations: { description: copy.setInput.operations },
        dryRun: { description: copy.setInput.dryRun },
      },
    });
    expect(manifest.queries.find((op) => op.localId === "code.access.list")?.inputSchema).toMatchObject({
      properties: { principal: { description: copy.listInput.principal } },
    });
    expect(manifest.actions.find((op) => op.localId === "code.access.rm")?.inputSchema).toMatchObject({
      properties: { grantId: { description: copy.rmInput.grantId } },
    });
    const english = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "en");
    expect(english.actions.find((op) => op.localId === "code.access.set")?.inputSchema).toMatchObject({
      properties: { proof: { description: codeAccessMessages("en").setInput.proof } },
    });
  }
  const compiled = compileCapabilities("inventory", {
    ...definitions,
    presentation: {
      baseLocale: "en",
      translations: { de: { actions: { "code.access.set": { title: "Zugriff einrichten", input: { proof: "Aktivierungsnachweis." } } } } },
    },
  });
  expect(compiled.presentation?.translations.de?.actions?.["code.access.set"]).toMatchObject({
    title: "Zugriff einrichten",
    input: { ...copy.setInput, proof: "Aktivierungsnachweis." },
  });
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

test("target operations belong to the app and their declared target or refs", () => {
  const manifest: CapabilityDefinitions = { ...definitions, queries: { "item.read": { ...reader, target: "item" } } };
  const target = { type: "inventory.item", id: "1" };
  expect(codeAccessOperationsAllowed("inventory", manifest, target, ["inventory.item.read"])).toBe(true);
  for (const operation of ["foreign.item.read", "inventory.missing", "inventory.code.access.rm"]) {
    expect(codeAccessOperationsAllowed("inventory", manifest, target, [operation])).toBe(false);
  }
  expect(codeAccessOperationsAllowed("inventory", manifest, { type: "inventory.other", id: "1" }, ["inventory.item.read"])).toBe(false);
});

test("targetless Queries rely on adapter grants; explicit Query targets still match", () => {
  const source: CapabilityDefinitions = { ...definitions, queries: { "item.search": reader } };
  expect(codeAccessOperationsAllowed("inventory", source, { type: "inventory.item", id: "1" }, ["inventory.item.search"])).toBe(true);
  const blocked: CapabilityDefinitions = {
    ...definitions,
    actions: {
      blocked: {
        ...reader,
        code: false,
        destructive: false,
        idempotency: "none",
      },
    },
  };
  expect(codeAccessOperationsAllowed("inventory", blocked, { type: "app", id: "inventory" }, ["inventory.blocked"])).toBe(false);
});
