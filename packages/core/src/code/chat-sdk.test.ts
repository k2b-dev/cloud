import { beforeAll, expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityDefinitions, CapabilityManifest } from "@k2b/cloud/contracts";
import { declarationOf } from "../../../../scripts/checks/capability-presentation";
import { packageIds } from "../../../../scripts/workspace";
import * as authoringCheck from "./authoring-check";
import {
  CODE_CHAT_SDK_APPS,
  CodeChatSdkDataSchema,
  CodeChatSdkInputSchema,
  codeChatSdkIndex,
  codeChatSdkView,
  readCodeChatSdk,
} from "./chat-sdk";
import { testIdentity } from "./files/test-identity";

// The real catalog: every workspace app that declares capabilities, as Core lists them for the chat.
const workspaceRoot = resolve(import.meta.dir, "../../../..");
const manifests: CapabilityManifest[] = [];
for (const appId of packageIds(workspaceRoot)) {
  const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
  if (!declaration) continue;
  if (declaration instanceof Error) throw declaration;
  const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
  manifests.push(compileCapabilityManifest(appId, loaded[declaration.exportName]!));
}
// UTF-8 bytes also conservatively bound the tool transport's character allowance.
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/**
 * The tool result budget of a 128k-token chat model: Cloud gives one result at most two characters per context token,
 * about half the context at nessi's four characters per token (resolveAiToolResultMaxChars in @k2b/cloud).
 */
const budget = 128_000 * 2;
const declarationSizes: { appId: string; size: number }[] = [];
// Each real app is an independent bounded fixture; keep expensive catalog generation out of the combined assertion.
for (const manifest of manifests)
  beforeAll(() => {
    declarationSizes.push({ appId: manifest.appId, size: size(codeChatSdkView([manifest], { mode: "personal" }, [manifest.appId])) });
  });
test("Spaces task and event list references name the app-level paginated Queries", () => {
  const index = codeChatSdkView(manifests, { mode: "personal" });
  if (index.kind !== "index") throw new Error("expected index");
  const paths = index.apps.find((app) => app.appId === "spaces")!.methods.map((method) => method.path);
  for (const kind of ["task", "event"]) {
    expect(paths).toContain(`spaces.${kind}.list`);
    expect(paths).not.toContain(`spaces.space(id).${kind}.list`);
  }
  const view = codeChatSdkView(manifests, { mode: "personal" }, ["spaces"]);
  if (view.kind !== "declarations") throw new Error("expected declarations");
  expect(view.declarations).toContain("Spaces_Task_ListInput");
  expect(view.declarations).toContain("spaceId");
  expect(view.declarations).toContain("nextCursor");
});

test("the complete SDK does not fit one chat tool result, which is why the chat reads it in two steps", () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  expect(manifests.length).toBeGreaterThan(5);
  expect(sdk.declarations.length + sdk.runtime.length + size(sdk.manifest)).toBeGreaterThan(budget);
});

test("the index names every app export, method and automation event with its policy and one line", () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const index = codeChatSdkIndex(manifests, { mode: "personal" });
  expect(CodeChatSdkDataSchema.safeParse(index).success).toBe(true);
  if (index.kind !== "index") throw new Error("expected the index");
  expect(index.apps.map((app) => app.export)).toEqual(sdk.manifest.apps.map((app) => app.exportName));
  expect(index.apps.flatMap((app) => app.methods)).toHaveLength(sdk.manifest.operations.length);
  expect(index.events.map((event) => event.type)).toEqual(sdk.manifest.events.map((event) => event.type));
  for (const method of index.apps.flatMap((app) => app.methods)) {
    expect(method.description.length).toBeGreaterThan(0);
    expect(method.description.length).toBeLessThanOrEqual(160);
    expect(method.description).not.toContain("\n");
  }
  // A targeted method is called on its handle; the path shows the factory with its id.
  expect(index.apps.flatMap((app) => app.methods).some((method) => /^\w+\.[\w.]+\(id\)\.\w/.test(method.path))).toBe(true);
});

test("the compact index keeps every call and event detail except descriptions, which remain available on demand", async () => {
  const described = codeChatSdkIndex(manifests, { mode: "personal" });
  const index = CodeChatSdkDataSchema.parse(codeChatSdkView(manifests, { mode: "personal" }));
  expect(index).toEqual({
    ...described,
    apps: described.apps.map((app) => ({
      ...app,
      methods: app.methods.map(({ description: _description, ...method }) => method),
    })),
    events: described.events.map(({ description: _description, ...event }) => event),
  });
  const load = spyOn(authoringCheck, "loadCodeSdkCatalog").mockResolvedValue({ manifests, options: { mode: "personal" } });
  try {
    const input = { codeId: "c_1234" };
    const context = { authority: { ...testIdentity("u1"), scopes: [] } };
    expect(await readCodeChatSdk(CodeChatSdkInputSchema.parse(input), context)).toEqual(index);
    expect(await readCodeChatSdk(CodeChatSdkInputSchema.parse({ ...input, descriptions: true }), context)).toEqual(described);
    expect(await readCodeChatSdk(CodeChatSdkInputSchema.parse({ ...input, descriptions: false }), context)).toEqual(index);
  } finally {
    load.mockRestore();
  }
  for (const event of described.events) {
    expect(event.description.length).toBeGreaterThan(0);
    expect(event.description.length).toBeLessThanOrEqual(160);
    expect(event.description).not.toContain("\n");
  }
});

test(`the index plus the declarations of any ${CODE_CHAT_SDK_APPS} apps fit the tool result budget of a 128k model`, () => {
  const index = codeChatSdkView(manifests, { mode: "personal" });
  // Rank each app with its own catalog rather than regenerating the complete catalog for every app.
  const declarations = [...declarationSizes].sort((a, b) => b.size - a.size);
  const largestApps = declarations.slice(0, CODE_CHAT_SDK_APPS);
  const shared = size(codeChatSdkView(manifests, { mode: "personal" }, []));
  // Each further app adds its own declarations on top of the shared ones.
  const largest = shared + largestApps.reduce((sum, value) => sum + value.size - shared, 0);
  console.log("SDK parts", { index: size(index), shared, largestApps });
  console.log("SDK tool result budget", size(index) + largest, "/", budget);
  expect(size(index) + largest).toBeLessThanOrEqual(budget);
  expect(size(index) + largest).toBeLessThanOrEqual(budget * 0.9);
  const combined = codeChatSdkView(
    manifests,
    { mode: "personal" },
    largestApps.map((app) => app.appId),
  );
  console.log("SDK combined tool result budget", size(index) + size(combined), "/", budget);
  expect(size(index) + size(combined)).toBeLessThanOrEqual(budget);
  expect(size(index) + size(combined)).toBeLessThanOrEqual(budget * 0.9);
});

test("declarations cover the requested apps, the shared app, page and event types, and accept export names", () => {
  const mail = manifests.find((manifest) => manifest.appId === "mail");
  if (!mail) throw new Error("mail declares capabilities");
  const view = codeChatSdkView(manifests, { mode: "personal" }, ["mail"]);
  if (view.kind !== "declarations") throw new Error("expected declarations");
  expect(view.apps).toEqual(["mail"]);
  expect(view.declarations).toContain("export declare const mail:");
  expect(view.declarations).toContain("export declare const app: CodeApp;");
  expect(view.declarations).toContain("export type CodeEvents");
  expect(view.declarations).not.toContain("export declare const spaces:");
  const hyphenated = manifests.find((manifest) => manifest.appId.includes("-"));
  if (hyphenated) {
    const byExport = codeChatSdkView(manifests, { mode: "personal" }, [hyphenated.appId.replaceAll("-", "_")]);
    expect(byExport.kind === "declarations" && byExport.apps).toEqual([hyphenated.appId]);
  }
  expect(() => codeChatSdkView(manifests, { mode: "personal" }, ["nope"])).toThrow("Unknown app nope");
  expect(CodeChatSdkInputSchema.safeParse({ codeId: "c_1234", apps: ["a", "b", "c"] }).success).toBe(false);
});

test("a resource Code's declarations always carry its owner's app, so the owner export has a type", () => {
  const spaces = manifests.find((manifest) => manifest.appId === "spaces");
  const type = spaces?.types[0];
  if (!spaces || !type) throw new Error("spaces declares a resource type");
  const view = codeChatSdkView(
    manifests,
    { mode: "resource", owner: { kind: "resource", ref: { type: `spaces.${type.localId}`, id: "s1" } } },
    ["mail"],
  );
  if (view.kind !== "declarations") throw new Error("expected declarations");
  expect(view.apps).toEqual(["mail", "spaces"]);
  expect(view.declarations).toContain("export declare const owner:");
});

test("the SDK index classifies inference queries as AI and keeps non-inference queries read", () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const index = codeChatSdkView(manifests, { mode: "personal" });
  if (index.kind !== "index") throw new Error("expected the index");
  const core = index.apps.find((app) => app.appId === "core")!;
  const operations = sdk.manifest.operations.filter((operation) => operation.appId === "core");
  const policy = (capability: string) => {
    const position = operations.findIndex((operation) => operation.capability === `core.${capability}`);
    expect(position).toBeGreaterThanOrEqual(0);
    return core.methods[position]?.policy;
  };
  for (const capability of ["ai.generate", "ai.decide"]) expect(policy(capability)).toBe("ai");
  expect(policy("ai.chat.send")).toBe("ai_chat_you");
  for (const capability of ["ai.chat.read", "code.list"]) expect(policy(capability)).toBe("read");
  for (const capability of ["ai.chat.search", "ai.chats.search", "ai.chat.resources"]) expect(policy(capability)).toBe("read");
});

test("declaration selection resolves custom and reserved export names without generating unselected apps", () => {
  const custom = compileCapabilityManifest("example", { protocolVersion: 2, sdkExportName: "installed", queries: {}, actions: {} });
  const reserved = compileCapabilityManifest("atob", { protocolVersion: 2, queries: {}, actions: {} });
  for (const [name, appId] of [
    ["installed", "example"],
    ["_atob", "atob"],
  ] as const) {
    const result = codeChatSdkView([custom, reserved], { mode: "personal" }, [name]);
    expect(result.kind === "declarations" && result.apps).toEqual([appId]);
    expect(result.kind === "declarations" && result.declarations).toContain(`export declare const ${name}:`);
  }
});
