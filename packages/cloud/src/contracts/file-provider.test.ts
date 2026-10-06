import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { capabilityHash, compileCapabilities, resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import previousFilesManifest from "../_internal/fixtures/filesv2-manifest-cloud-v0.29.0.json";
import { resolveLiveCapabilityRegistryEntry } from "../_internal/registry";
import { compileCapabilityManifest } from "../capabilities/testing";
import {
  type CapabilityActionDefinition,
  type CapabilityDefinitions,
  type CapabilityInvocationResult,
  type CapabilityManifest,
  type CapabilityQueryDefinition,
  defineCapabilities,
} from "./capabilities";
import { capabilityContractIssues } from "./capability-compatibility";
import {
  FileProviderEntrySchema,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
  FileProviderSaveDataSchema,
  FileProviderSaveInputSchema,
  fileProvider,
  fileProviderIssues,
} from "./file-provider";

const run = (): CapabilityInvocationResult<never> => ({
  ok: false,
  error: { code: "INTERNAL", message: "Not invoked in this test.", status: 500 },
});
const readStream = { direction: "read" as const, maxBytes: 1024, read: async () => new Response("") };
const writeStream = {
  direction: "write" as const,
  maxBytes: 1024,
  write: async () => ({ data: {} }),
  status: async () => ({ state: "open" as const }),
  abort: async () => undefined,
};

const list: CapabilityQueryDefinition = {
  title: "List",
  description: "List one folder.",
  input: FileProviderListInputSchema,
  data: FileProviderListDataSchema,
  openWorld: false,
  run,
};
const read: CapabilityQueryDefinition = {
  title: "Read",
  description: "Read one file.",
  input: FileProviderReadInputSchema,
  data: z.object({ id: z.string() }).strict(),
  openWorld: false,
  stream: readStream,
  run,
};
const save: CapabilityActionDefinition = {
  title: "Save",
  description: "Create one file.",
  input: FileProviderSaveInputSchema,
  data: FileProviderSaveDataSchema,
  destructive: false,
  openWorld: false,
  idempotency: "required",
  stream: writeStream,
  run,
};

const provider = (overrides: Partial<CapabilityDefinitions> = {}): CapabilityDefinitions =>
  defineCapabilities({
    protocolVersion: 2,
    queries: { "folder.list": list, "file.read": read },
    actions: { "file.save": save },
    fileProvider: { list: "folder.list", read: "file.read", save: "file.save" },
    ...overrides,
  });

const operation = (manifest: CapabilityManifest, localId: string) => {
  const query = manifest.queries.find((entry) => entry.localId === localId);
  if (query) return { kind: "query" as const, operation: query };
  const action = manifest.actions.find((entry) => entry.localId === localId);
  if (action) return { kind: "action" as const, operation: action };
  throw new Error(`Missing ${localId}`);
};

describe("file-provider contract", () => {
  test("a provider that reuses the contract schemas compiles into its manifest", () => {
    const manifest = compileCapabilityManifest("drive", provider());
    expect(manifest.fileProvider).toEqual({ list: "folder.list", read: "file.read", save: "file.save" });
    expect(fileProviderIssues(manifest)).toEqual([]);
    const readOnly = compileCapabilityManifest("drive", provider({ fileProvider: { list: "folder.list", read: "file.read" } }));
    expect(readOnly.fileProvider).toEqual({ list: "folder.list", read: "file.read" });
  });

  test("a manifest without a provider has no fileProvider field and keeps its hash", () => {
    const definitions = provider({ fileProvider: undefined });
    const { fileProvider: _absent, ...withoutProvider } = definitions;
    const manifest = compileCapabilityManifest("drive", withoutProvider);
    expect("fileProvider" in manifest).toBe(false);
    expect(compileCapabilityManifest("drive", definitions)).toEqual(manifest);
    const { manifestHash, ...base } = manifest;
    expect(manifestHash).toBe(capabilityHash(base));
  });

  test("the checker compares the stream direction the contract names", () => {
    const manifest = compileCapabilityManifest("drive", provider());
    const listOperation = operation(manifest, "folder.list");
    const readOperation = operation(manifest, "file.read");
    const saveOperation = operation(manifest, "file.save");
    const streamIssues = (contract: Parameters<typeof capabilityContractIssues>[0], candidate: ReturnType<typeof operation>) =>
      capabilityContractIssues(contract, candidate).filter((issue) => issue.code === "stream");

    // No stream named: streaming candidates stay incompatible, as for the contact directory.
    expect(streamIssues({ ...fileProvider.read, stream: undefined }, readOperation)).toEqual([
      { code: "stream", path: "$", message: "Streaming capabilities are not supported" },
    ]);
    expect(streamIssues({ ...fileProvider.list }, listOperation)).toEqual([]);
    // A named direction must be declared, and only that one.
    expect(streamIssues(fileProvider.read, readOperation)).toEqual([]);
    expect(streamIssues(fileProvider.read, listOperation)).toEqual([{ code: "stream", path: "$", message: "Expected a read stream" }]);
    expect(streamIssues(fileProvider.save, saveOperation)).toEqual([]);
    expect(streamIssues({ ...fileProvider.save, stream: "read" }, saveOperation)).toEqual([
      { code: "stream", path: "$", message: "Expected a read stream" },
    ]);
    const { stream: _stream, ...plainSave } = save;
    const unstreamed = compileCapabilityManifest("drive", provider({ actions: { "file.save": plainSave }, fileProvider: undefined }));
    expect(streamIssues(fileProvider.save, operation(unstreamed, "file.save"))).toEqual([
      { code: "stream", path: "$", message: "Expected a write stream" },
    ]);
  });

  test("app start fails for a declaration the contract does not accept", () => {
    expect(() => compileCapabilities("drive", provider({ fileProvider: { list: "folder.missing", read: "file.read" } }))).toThrow(
      "list (folder.missing) $: No Query or Action named folder.missing",
    );
    expect(() => compileCapabilities("drive", provider({ fileProvider: { list: "file.save", read: "file.read" } }))).toThrow(
      "list (file.save) $: Expected a Query",
    );
    const { stream: _stream, ...plainRead } = read;
    expect(() => compileCapabilities("drive", provider({ queries: { "folder.list": list, "file.read": plainRead } }))).toThrow(
      "read (file.read) $: Expected a read stream",
    );
    const openList = { ...list, data: FileProviderListDataSchema.extend({ items: z.array(FileProviderEntrySchema) }) };
    expect(() => compileCapabilities("drive", provider({ queries: { "folder.list": openList, "file.read": read } }))).toThrow(
      "list (folder.list) $.items: must contain at most 100 items",
    );
    const { stream: _write, ...plainSave } = save;
    expect(() => compileCapabilities("drive", provider({ actions: { "file.save": { ...plainSave, idempotency: "none" } } }))).toThrow(
      "save (file.save) $: The Action must require an idempotency key",
    );
  });

  test("bounds entries, tags, and file names", () => {
    const entry = { kind: "file", id: "f1", name: "a.txt", size: 1, tags: [{ label: "Draft", tone: "info" }] };
    expect(FileProviderEntrySchema.safeParse(entry).success).toBe(true);
    expect(FileProviderEntrySchema.safeParse({ ...entry, tags: Array(4).fill({ label: "x" }) }).success).toBe(false);
    expect(FileProviderEntrySchema.safeParse({ ...entry, tags: [{ label: "x".repeat(41) }] }).success).toBe(false);
    expect(FileProviderListDataSchema.safeParse({ writable: true, items: Array(101).fill(entry), next: null }).success).toBe(false);
    const name = (value: string) => FileProviderSaveInputSchema.safeParse({ parent: "p", name: value, mediaType: "text/plain", size: 1 });
    expect(name("Report (2).pdf").success).toBe(true);
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "x".repeat(256)]) expect(name(invalid).success).toBe(false);
  });
});

describe("file providers in Core", () => {
  const liveApp = (manifestHash: string) => ({
    id: "drive",
    name: "Drive",
    icon: "ti ti-folders",
    description: "Drive",
    baseUrl: "http://drive:3000",
    routes: ["/app/drive"],
    capabilities: { protocolVersion: 2, manifestHash },
  });
  let errors: ReturnType<typeof spyOn> | undefined;
  afterEach(() => errors?.mockRestore());

  test("a manifest compiled by the previous release is read with an identical hash", () => {
    const manifest = previousFilesManifest as CapabilityManifest;
    const entry = resolveLiveCapabilityRegistryEntry(
      "capabilities/filesv2",
      { appId: "filesv2", manifest: structuredClone(manifest) },
      { ...liveApp(manifest.manifestHash), id: "filesv2" },
    );
    expect(entry?.manifest).toEqual(manifest);
    expect("fileProvider" in (entry?.manifest ?? {})).toBe(false);
  });

  test("an invalid declaration is ignored and logged once while the other capabilities stay available", () => {
    errors = spyOn(console, "error").mockImplementation(() => undefined);
    const valid = compileCapabilityManifest("drive", provider());
    // An app built against a different contract: its manifest hash is intact, its provider is not.
    const invalid = structuredClone(valid);
    invalid.fileProvider = { list: "file.save", read: "file.read" };
    const { manifestHash: _hash, ...base } = invalid;
    invalid.manifestHash = capabilityHash(base);
    const resolve = () =>
      resolveLiveCapabilityRegistryEntry("capabilities/drive", { appId: "drive", manifest: invalid }, liveApp(invalid.manifestHash));

    const entry = resolve();
    expect(entry?.manifest.fileProvider).toBeUndefined();
    expect(entry?.manifest.manifestHash).toBe(invalid.manifestHash);
    expect(entry?.manifest.queries.map((query) => query.localId)).toEqual(["file.read", "folder.list"]);
    resolve();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("Ignored a file provider");

    expect(
      resolveLiveCapabilityRegistryEntry("capabilities/drive", { appId: "drive", manifest: valid }, liveApp(valid.manifestHash))?.manifest
        .fileProvider,
    ).toEqual(valid.fileProvider);
  });

  test("localized manifests keep the declaration", () => {
    const compiled = compileCapabilities(
      "drive",
      provider({ presentation: { baseLocale: "en", translations: { de: { queries: { "folder.list": { title: "Ordner lesen" } } } } } }),
    );
    const localized = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de");
    expect(localized.queries.find((query) => query.localId === "folder.list")?.title).toBe("Ordner lesen");
    expect(localized.fileProvider).toEqual(compiled.manifest.fileProvider);
  });
});
