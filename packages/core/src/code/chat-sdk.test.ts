import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityDefinitions, CapabilityManifest } from "@k2b/cloud/contracts";
import { declarationOf } from "../../../../scripts/checks/capability-presentation";
import { packageIds } from "../../../../scripts/workspace";
import { resolveAiToolResultMaxChars } from "../../../cloud/src/ai/tool-result-budget";
import { CODE_CHAT_SDK_APPS, CodeChatSdkDataSchema, CodeChatSdkInputSchema, codeChatSdkView } from "./chat-sdk";

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
const size = (value: unknown) => JSON.stringify(value).length;
/** A 128k-token chat model; nessi counts about four characters per token, Cloud gives one result half of the context. */
const budget = resolveAiToolResultMaxChars({ contextWindow: 128_000, configuredMaxChars: 2_000_000 });

test("the complete SDK does not fit one chat tool result, which is why the chat reads it in two steps", () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  expect(manifests.length).toBeGreaterThan(5);
  expect(sdk.declarations.length + sdk.runtime.length + size(sdk.manifest)).toBeGreaterThan(budget);
});

test("the index names every app export, method and automation event with its policy and one line", () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const index = CodeChatSdkDataSchema.parse(codeChatSdkView(manifests, { mode: "personal" }));
  if (index.kind !== "index") throw new Error("expected the index");
  expect(index.apps.map((app) => app.export)).toEqual(sdk.manifest.apps.map((app) => app.exportName));
  expect(index.apps.flatMap((app) => app.methods)).toHaveLength(sdk.manifest.operations.length);
  expect(index.events.map((event) => event.type)).toEqual(sdk.manifest.events.map((event) => event.type));
  for (const method of index.apps.flatMap((app) => app.methods)) {
    expect(method.description.length).toBeGreaterThan(0);
    expect(method.description.length).toBeLessThanOrEqual(160);
    expect(method.description).not.toContain("\n");
    if (method.kind === "query") expect(method.policy).toBe("read");
  }
  // A targeted method is called on its handle; the path shows the factory with its id.
  expect(index.apps.flatMap((app) => app.methods).some((method) => /^\w+\.[\w.]+\(id\)\.\w/.test(method.path))).toBe(true);
});

test(`the index plus the declarations of any ${CODE_CHAT_SDK_APPS} apps fit the tool result budget of a 128k model`, () => {
  const index = codeChatSdkView(manifests, { mode: "personal" });
  const declarations = manifests
    .map((manifest) => size(codeChatSdkView(manifests, { mode: "personal" }, [manifest.appId])))
    .sort((a, b) => b - a);
  const shared = size(codeChatSdkView(manifests, { mode: "personal" }, []));
  // Each further app adds its own declarations on top of the shared ones.
  const largest = shared + declarations.slice(0, CODE_CHAT_SDK_APPS).reduce((sum, value) => sum + value - shared, 0);
  expect(size(index) + largest).toBeLessThanOrEqual(budget);
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
  expect(CodeChatSdkInputSchema.safeParse({ codeId: crypto.randomUUID(), apps: ["a", "b", "c"] }).success).toBe(false);
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
