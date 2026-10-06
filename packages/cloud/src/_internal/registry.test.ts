import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { futureLibrary } from "../../test/future-capability-manifest";
import { defineCapabilities } from "../contracts/capabilities";
import { capabilityHash, compileCapabilities, resolveCapabilityManifestPresentation } from "./capabilities";
import { type AppRegistrySnapshot, requireUsableAppRegistry, resolveLiveCapabilityRegistryEntry } from "./registry";

const compiled = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 2,
    queries: {
      ping: {
        title: "Ping",
        description: "Returns one bounded value.",
        input: z.object({ value: z.string().describe("Value to return.") }).strict(),
        data: z.string(),
        openWorld: false,
        run: async ({ value }) => ok({ data: value }),
      },
    },
  }),
);

const liveApp = {
  id: "demo",
  name: "Demo",
  icon: "box",
  description: "Demo app",
  appearance: { accent: "#0f766e" as const },
  baseUrl: "http://demo:3000/custom/path",
  routes: ["/app/demo"],
  capabilities: { protocolVersion: 2, manifestHash: compiled.manifest.manifestHash },
};

describe("requireUsableAppRegistry", () => {
  test("keeps valid entries when another record is malformed", () => {
    const app = {
      id: "core",
      name: "Core",
      icon: "cloud",
      description: "Core",
      baseUrl: "http://core:3000",
      routes: ["/"],
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      version: "1",
    };
    const snapshot = { apps: [app], issues: [{ key: "apps/broken", version: "2", reason: "invalid" }] } satisfies AppRegistrySnapshot;
    expect(requireUsableAppRegistry(snapshot)).toEqual([app]);
  });

  test("does not replace the last good consumer state with an all-invalid snapshot", () => {
    const snapshot = {
      apps: [],
      issues: [{ key: "apps/core", version: "2", reason: "entry must be an object" }],
    } satisfies AppRegistrySnapshot;
    expect(() => requireUsableAppRegistry(snapshot)).toThrow("no valid entries");
  });
});

describe("resolveLiveCapabilityRegistryEntry", () => {
  test("derives metadata and the fixed endpoint from the matching live app", () => {
    expect(resolveLiveCapabilityRegistryEntry("capabilities/demo", { appId: "demo", manifest: compiled.manifest }, liveApp)).toMatchObject({
      appId: "demo",
      appName: "Demo",
      appIcon: "box",
      appAccent: "#0f766e",
      endpoint: "http://demo:3000/api/_internal/capabilities/v1",
    });
  });

  test("drops an invalid app accent from capability presentation metadata", () => {
    const invalidAppearance = { ...liveApp, appearance: { accent: "not-a-color" as `#${string}` } };
    expect(
      resolveLiveCapabilityRegistryEntry("capabilities/demo", { appId: "demo", manifest: compiled.manifest }, invalidAppearance),
    ).toMatchObject({
      appAccent: undefined,
    });
  });

  test("rejects mismatches, stale summaries, and registry-selected endpoints", () => {
    const record = { appId: "demo", manifest: compiled.manifest };
    expect(resolveLiveCapabilityRegistryEntry("capabilities/other", record, liveApp)).toBeNull();
    expect(resolveLiveCapabilityRegistryEntry("capabilities/demo", record, { ...liveApp, id: "other" })).toBeNull();
    expect(
      resolveLiveCapabilityRegistryEntry("capabilities/demo", record, {
        ...liveApp,
        capabilities: { ...liveApp.capabilities, manifestHash: "0".repeat(64) },
      }),
    ).toBeNull();
    expect(
      resolveLiveCapabilityRegistryEntry("capabilities/demo", { ...record, endpoint: "https://attacker.invalid/steal" }, liveApp),
    ).toBeNull();
  });

  test("reads a manifest registered by a newer release without losing the app's other capabilities", () => {
    const { manifest, presentation } = futureLibrary();
    const libraryApp = {
      ...liveApp,
      id: "library",
      // The newer app announces the hash of what it sent.
      capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash },
    };
    const entry = resolveLiveCapabilityRegistryEntry("capabilities/library", { appId: "library", manifest, presentation }, libraryApp);
    expect(entry).not.toBeNull();
    expect(entry!.manifest.manifestHash).toBe(manifest.manifestHash);
    expect(entry!.manifest).not.toHaveProperty("fileProvider");
    expect(entry!.manifest).not.toHaveProperty("events");
    expect(entry!.manifest.queries.map((query) => query.localId)).toEqual(["book.read"]);
    expect(entry!.manifest.actions.map((action) => action.localId)).toEqual(["book.rename"]);
    expect(entry!.manifest.commands.map((command) => command.localId)).toEqual(["book.open"]);
    // Translations of left-out entries and of newer fields are skipped; the rest still applies.
    expect(entry!.presentation?.translations.de).toEqual({
      types: { book: { title: "Buch" } },
      queries: { "book.read": { title: "Buch lesen" } },
      actions: {},
    });
    const german = resolveCapabilityManifestPresentation(entry!.manifest, entry!.presentation, "de");
    expect(german.queries[0]?.title).toBe("Buch lesen");
  });

  test("checks a newer manifest's hash against what the app sent, including ignored fields", () => {
    const { manifest } = futureLibrary();
    const libraryApp = { ...liveApp, id: "library", capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash } };
    const tampered = { ...manifest, fileProvider: { list: "book.read", read: "book.read" } };
    expect(resolveLiveCapabilityRegistryEntry("capabilities/library", { appId: "library", manifest: tampered }, libraryApp)).toBeNull();

    // Rehashing only what this release understood would never match the app's own summary.
    const understood = resolveLiveCapabilityRegistryEntry("capabilities/library", { appId: "library", manifest }, libraryApp)!.manifest;
    const { manifestHash: _sent, ...understoodBase } = understood;
    expect(capabilityHash(understoodBase)).not.toBe(manifest.manifestHash);
  });
});
