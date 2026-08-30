import { describe, expect, test } from "bun:test";
import { compileCapabilities, resolveCapabilityManifestPresentation } from "../packages/cloud/src/_internal/capabilities";
import type { CapabilityDefinitions, CapabilityPresentationTranslation } from "../packages/cloud/src/contracts/capabilities";
import { contactsCapabilities } from "../packages/contacts/src/capabilities";
import { aiCapabilities } from "../packages/core/src/capabilities";
import { filesCapabilities } from "../packages/files/src/capabilities";
import { gridsCapabilities } from "../packages/grids/src/capabilities";
import { mailCapabilities } from "../packages/mail/src/capabilities";
import { notebooksCapabilities } from "../packages/notebooks/src/capabilities";
import { pulseCapabilities } from "../packages/pulse/src/capabilities";
import { spacesCapabilities } from "../packages/spaces/src/capabilities";
import { venueCapabilities } from "../packages/venue/src/capabilities";
import { weatherCapabilities } from "../packages/weather/src/capabilities";

const builtIns: ReadonlyArray<[string, CapabilityDefinitions]> = [
  ["contacts", contactsCapabilities],
  ["core", aiCapabilities],
  ["files", filesCapabilities],
  ["grids", gridsCapabilities],
  ["mail", mailCapabilities],
  ["notebooks", notebooksCapabilities],
  ["pulse", pulseCapabilities],
  ["spaces", spacesCapabilities],
  ["venue", venueCapabilities],
  ["weather", weatherCapabilities],
];

const schemaFieldPaths = (schema: unknown, prefix = "", output: string[] = []): string[] => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return output;
  const value = schema as Record<string, unknown>;
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    for (const [field, definition] of Object.entries(value.properties)) {
      const path = prefix ? `${prefix}.${field}` : field;
      output.push(path);
      schemaFieldPaths(definition, path, output);
    }
  }
  if (value.items) schemaFieldPaths(value.items, `${prefix}[]`, output);
  return output;
};

const missingPresentation = (appId: string, definitions: CapabilityDefinitions): string[] => {
  const compiled = compileCapabilities(appId, definitions);
  const de = compiled.presentation?.translations.de as CapabilityPresentationTranslation | undefined;
  if (!de) return [`${appId}: de`];
  const missing: string[] = [];
  for (const type of compiled.manifest.types) {
    if (!de.types?.[type.localId]?.title) missing.push(`${appId}.types.${type.localId}.title`);
    if (!de.types?.[type.localId]?.description) missing.push(`${appId}.types.${type.localId}.description`);
  }
  for (const [kind, operations] of [
    ["queries", compiled.manifest.queries],
    ["actions", compiled.manifest.actions],
  ] as const) {
    for (const operation of operations) {
      const copy = de[kind]?.[operation.localId];
      if (!copy?.title) missing.push(`${appId}.${kind}.${operation.localId}.title`);
      if (!copy?.description) missing.push(`${appId}.${kind}.${operation.localId}.description`);
      for (const path of schemaFieldPaths(operation.inputSchema)) {
        if (!copy?.input?.[path]) missing.push(`${appId}.${kind}.${operation.localId}.input.${path}`);
      }
      if ("universalSearch" in operation && operation.universalSearch) {
        for (const tag of operation.universalSearch.tags) {
          if (!copy?.searchTags?.[tag.tag]?.title) missing.push(`${appId}.${kind}.${operation.localId}.searchTags.${tag.tag}.title`);
          if (!copy?.searchTags?.[tag.tag]?.description)
            missing.push(`${appId}.${kind}.${operation.localId}.searchTags.${tag.tag}.description`);
        }
      }
    }
  }
  return missing;
};

describe("built-in Capability presentation", () => {
  test("ships complete German registry and input-schema presentation", () => {
    expect(builtIns.flatMap(([appId, definitions]) => missingPresentation(appId, definitions))).toEqual([]);
  });

  test("resolves declared German contact field descriptions through language ancestors", () => {
    const compiled = compileCapabilities("contacts", contactsCapabilities);
    const localized = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de-CH");
    const action = localized.actions.find((entry) => entry.localId === "contact.create");
    const properties = action?.inputSchema.properties as Record<string, { description?: string }> | undefined;

    expect(properties?.salutation?.description).toBe("Bevorzugte Anrede.");
    expect(properties?.pronouns?.description).toBe("Bevorzugte Pronomen.");
    expect(properties?.preferredLanguage?.description).toBe("Bevorzugter Sprachcode.");
  });
});
