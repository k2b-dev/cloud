import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileCapabilities } from "../packages/cloud/src/_internal/capabilities";
import { buildAiCapabilityCatalog, createLoadedAiCapabilityTools } from "../packages/cloud/src/ai/capabilities";
import { prepareAiTools } from "../packages/cloud/src/ai/tools";
import type { CapabilityDefinitions } from "../packages/cloud/src/contracts/capabilities";
import type { CapabilityRegistryEntry } from "../packages/cloud/src/contracts/registry";
import type { RequestActor } from "../packages/cloud/src/server";
import { declarationOf } from "../scripts/checks/capability-presentation";
import { packageIds, workspaceRoot } from "../scripts/workspace";

// Nessi belongs to Cloud in this isolated-linker workspace.
const { toolToSpec }: typeof import("@k2b/nessi") = await import(
  import.meta.resolve("@k2b/nessi", new URL("../packages/cloud/package.json", import.meta.url).href)
);

const actor: RequestActor = {
  kind: "user",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "schema-test",
    provider: "local",
    profile: "user",
    displayName: "Schema Test",
    mail: "schema@example.test",
    givenname: "Schema",
    sn: "Test",
    roles: ["user"],
    accountExpires: null,
    avatarHash: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  },
};

describe("capability provider tool schemas", () => {
  test("every declared app operation serializes to the provider schema subset", async () => {
    const apps: CapabilityRegistryEntry[] = [];
    for (const appId of packageIds(workspaceRoot)) {
      const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
      if (!declaration) continue;
      if (declaration instanceof Error) throw declaration;
      const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
      const definitions = loaded[declaration.exportName];
      if (!definitions) throw new Error(`${declaration.file}: ${declaration.exportName} is not exported.`);
      const compiled = compileCapabilities(appId, definitions);
      apps.push({
        appId,
        appName: appId,
        appIcon: "ti ti-box",
        appAccent: "#0f766e",
        appDescription: appId,
        endpoint: `http://${appId}:3000/api/_internal/capabilities/v1`,
        manifest: compiled.manifest,
      });
    }
    // Discovery must keep finding every app known to declare capabilities; new apps join on their own.
    expect(apps.map((app) => app.appId)).toEqual(
      expect.arrayContaining([
        "accounts",
        "assistant",
        "capabilities",
        "contacts",
        "core",
        "filesv2",
        "grids",
        "mail",
        "notebooks",
        "pulse",
        "spaces",
        "venue",
        "weather",
      ]),
    );

    const catalog = buildAiCapabilityCatalog(apps);
    const prepared = prepareAiTools({
      tools: createLoadedAiCapabilityTools({
        catalog,
        loadedNames: catalog.map((entry) => entry.name),
        actor,
        execute: async () => {
          throw new Error("Schema checks must not execute capabilities.");
        },
      }),
      actor,
    });
    expect(prepared.tools.length).toBe(catalog.length);
    const violations: string[] = [];
    for (const tool of prepared.tools) {
      const name = prepared.canonicalNames.get(tool.def.name);
      if (!name) throw new Error(`Missing capability identity for ${tool.def.name}.`);
      const schema = toolToSpec(tool).inputSchema;
      if (schema.type !== "object") violations.push(`${name}: $ root must have type object`);
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        if (Object.hasOwn(schema, key)) violations.push(`${name}: $.${key} root union is unsupported`);
      }
      const visit = (value: unknown, path: string): void => {
        if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, `${path}[${index}]`));
          return;
        }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          const childPath = `${path}.${key}`;
          if (key === "prefixItems" || key === "additionalItems") {
            violations.push(`${name}: ${childPath} tuple keyword is unsupported`);
          }
          if (key === "items" && (!child || typeof child !== "object" || Array.isArray(child))) {
            violations.push(`${name}: ${childPath} items must be one object schema`);
          }
          visit(child, childPath);
        }
      };
      visit(schema, "$");
    }
    expect(violations).toEqual([]);
  });
});
