import { expect, test } from "bun:test";
import { z } from "zod";
import {
  capabilityHash,
  compileCapabilities,
  parseCapabilityManifest,
  resolveCapabilityManifestPresentation,
} from "../_internal/capabilities";
import { resolveLiveCapabilityRegistryEntry } from "../_internal/registry";
import { compileCapabilityManifest } from "../capabilities/testing";
import { type CapabilityDefinitions, CapabilityManifestSchema } from "./capabilities";

const definitions = (pages?: readonly string[]): CapabilityDefinitions => ({
  protocolVersion: 2,
  types: { item: { title: "Item", description: "An item.", reader: "read", ...(pages ? { pages } : {}) } },
  queries: {
    read: {
      title: "Read",
      description: "Read one item.",
      openWorld: false,
      input: z.object({ id: z.string().describe("Item ID.") }).strict(),
      data: z.object({}).strict(),
      run: async () => ({ ok: true, data: { data: {} } }),
    },
  },
});
const compile = (pages?: readonly string[]) => compileCapabilityManifest("demo", definitions(pages), ["/app/demo"]);

test("pages compile at the top level, keeping Type entries strict and unchanged", () => {
  const old = compile();
  const current = compile(["/app/demo/:id"]);
  expect(old).not.toHaveProperty("resourcePages");
  expect(current.resourcePages).toEqual([{ type: "item", path: "/app/demo/:id" }]);
  expect(current.types).toEqual(old.types);
  const { resourcePages: _pages, manifestHash: _hash, ...base } = current;
  expect(capabilityHash(base)).toBe(old.manifestHash);
  expect(compile([])).toEqual(old);
  expect(parseCapabilityManifest(current, "demo")).toEqual(current);
});

test("compile rejects foreign prefixes, invalid patterns, excessive pages and missing readers", () => {
  expect(() => compile(["/app/other/:id"])).toThrow("Only app <id>");
  expect(() => compile(["/app/demo/:other"])).toThrow("exactly one :id");
  expect(() => compile(Array(9).fill("/app/demo/:id"))).toThrow("at most 8");
  const declaration = definitions(["/app/demo/:id"]);
  expect(() =>
    compileCapabilities("demo", { ...declaration, types: { item: { title: "Item", description: "Item", pages: ["/app/demo/:id"] } } }, [
      "/app/demo",
    ]),
  ).toThrow("pages require a reader");
});

test("old-style readers ignore pages without losing Types or readers; new readers accept old manifests", () => {
  const current = compile(["/app/demo/:id"]);
  const { resourcePages: _pages, ...oldView } = current;
  const oldSchema = CapabilityManifestSchema.out.omit({ resourcePages: true });
  expect(oldSchema.parse(current)).toEqual(oldView);
  expect(CapabilityManifestSchema.parse(compile())).toEqual(compile());
});

test("unreadable pages are omitted without losing known Types, and reader dependencies follow releases", () => {
  const manifest = compile(["/app/demo/:id"]);
  const newer = {
    ...manifest,
    resourcePages: [
      ...manifest.resourcePages!,
      { type: "item", path: "/app/demo/:id", future: true },
      { type: "missing", path: "/app/demo/:id" },
      { type: "item", path: "/app/demo/no-capture" },
    ],
  };
  expect(CapabilityManifestSchema.parse(newer).resourcePages).toEqual(manifest.resourcePages);
  expect(CapabilityManifestSchema.parse({ ...manifest, queries: [] }).resourcePages).toEqual([]);
  expect(CapabilityManifestSchema.parse({ ...manifest, resourcePages: "future format" }).types).toEqual(manifest.types);
  expect(CapabilityManifestSchema.parse({ ...manifest, types: [{ ...manifest.types[0], unknown: true }] }).resourcePages).toEqual([]);
});

test("locale overlays retain page declarations", () => {
  const manifest = compile(["/app/demo/:id"]);
  const localized = resolveCapabilityManifestPresentation(
    manifest,
    { baseLocale: "en", translations: { de: { types: { item: { title: "Element" } } } } },
    "de",
  );
  expect(localized.resourcePages).toEqual(manifest.resourcePages);
  expect(localized.types[0]?.title).toBe("Element");
});

test("the live registry omits another app's page claims while preserving the Type and manifest identity", () => {
  const compiled = compile(["/app/demo/:id"]);
  const { manifestHash: _hash, ...base } = {
    ...compiled,
    resourcePages: [...compiled.resourcePages!, { type: "item", path: "/app/foreign/:id" }],
  };
  const manifest = { ...base, manifestHash: capabilityHash(base) };
  const entry = resolveLiveCapabilityRegistryEntry(
    "capabilities/demo",
    { appId: "demo", manifest },
    {
      id: "demo",
      name: "Demo",
      description: "Demo",
      icon: "ti ti-box",
      baseUrl: "http://demo",
      routes: ["/app/demo"],
      capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash },
    },
  );
  expect(entry?.manifest.resourcePages).toEqual(compiled.resourcePages);
  expect(entry?.manifest.types).toEqual(compiled.types);
  expect(entry?.manifest.manifestHash).toBe(manifest.manifestHash);
});

test("manifest reading bounds total pages and each Type's pages", () => {
  const manifest = compile(["/app/demo/:id"]);
  const page = manifest.resourcePages![0]!;
  expect(CapabilityManifestSchema.parse({ ...manifest, resourcePages: Array(1601).fill(page) }).resourcePages).toEqual([]);
  expect(CapabilityManifestSchema.parse({ ...manifest, resourcePages: Array(9).fill(page) }).resourcePages).toHaveLength(8);
});

test("compile rejects a foreign namespace even with a declared ancestor route", () => {
  expect(() => compileCapabilityManifest("demo", definitions(["/app/foreign/:id"]), ["/"])).toThrow("Only app <id>");
});
