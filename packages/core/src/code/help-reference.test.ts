import { afterEach, expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityDefinitions, CapabilityManifest } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import * as logging from "@k2b/cloud/services/logging";
import { declarationOf } from "../../../../scripts/checks/capability-presentation";
import { packageIds } from "../../../../scripts/workspace";
import * as catalog from "./authoring-check";
import { codeChatSdkView } from "./chat-sdk";
import { canAuthorCode, codeHelpReference, loadCodeHelpReference } from "./help-reference";
import * as policy from "./policy";
import { CODE_POLICY_ROWS, type CodePolicyRow, type CodePolicyValue } from "./policy-contracts";

// The real catalog: every workspace app that declares capabilities, as Core lists them for code_sdk.
const workspaceRoot = resolve(import.meta.dir, "../../../..");
const manifests: CapabilityManifest[] = [];
for (const appId of packageIds(workspaceRoot)) {
  const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
  if (!declaration) continue;
  if (declaration instanceof Error) throw declaration;
  const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
  manifests.push(compileCapabilityManifest(appId, loaded[declaration.exportName]!));
}
const value = (row: CodePolicyRow): CodePolicyValue =>
  row.startsWith("ask_") ? "never" : row === "read" ? "automatic" : row === "ai" ? "never" : "admin";
const rows = CODE_POLICY_ROWS.map((row) => ({ row, value: value(row) }));

const person = (profile: "user" | "guest", overrides: Partial<RequestAuthority> = {}) =>
  ({
    actor: { kind: "user", user: { id: "u1", uid: "u1", roles: ["user"], profile } },
    accessSubject: { type: "user", userId: "u1" },
    credentialKind: "session",
    scopes: [],
    ...overrides,
  }) as never;
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("each app's reference lists exactly the methods and events of the code_sdk index, with the reader's policy", () => {
  const index = codeChatSdkView(manifests, { mode: "personal" });
  if (index.kind !== "index") throw new Error("expected the index");
  expect(index.apps.length).toBeGreaterThan(5);
  for (const app of index.apps) {
    const reference = codeHelpReference(app.appId, manifests, rows);
    expect(reference.export).toBe(app.export);
    expect(reference.operations).toEqual(app.methods.map((method) => ({ ...method, policy: value(method.policy) })));
    expect(reference.events).toEqual(index.events.filter((event) => event.type.startsWith(`${app.appId}.`)));
  }
  expect(codeHelpReference("nope", manifests, rows)).toEqual({ export: null, operations: [], events: [] });
});

test("a new manifest operation appears in the reference without a hand edit", () => {
  const weather = manifests.find((manifest) => manifest.appId === "weather");
  const query = weather?.queries[0];
  if (!weather || !query) throw new Error("weather declares a query");
  const before = codeHelpReference("weather", manifests, rows);
  const added: CapabilityManifest = {
    ...weather,
    queries: [...weather.queries, { ...query, localId: "outlook", description: "Show the outlook for a place. More detail." }],
  };
  const after = codeHelpReference("weather", [added], rows);
  expect(after.operations).toHaveLength(before.operations.length + 1);
  expect(after.operations).toContainEqual({
    path: "weather.outlook",
    kind: "query",
    policy: "automatic",
    description: "Show the outlook for a place.",
  });
});

test("only signed-in members with a writing credential can author Code; guests cannot", () => {
  expect(canAuthorCode({ authority: person("user") })).toBe(true);
  expect(canAuthorCode({ authority: person("guest") })).toBe(false);
  expect(canAuthorCode({ authority: person("user", { credentialKind: "oauth", scopes: ["read"] } as never) })).toBe(false);
  expect(
    canAuthorCode({ authority: person("user", { accessSubject: { type: "service_account", serviceAccountId: "s1" } } as never) }),
  ).toBe(false);
});

test("the loader reads nothing for a guest, reads no policy for an app without Code, and reports a failed read", async () => {
  const load = spyOn(catalog, "loadCodeSdkManifests").mockResolvedValue(manifests);
  const effective = spyOn(policy, "effectiveCodePolicy").mockResolvedValue({
    revision: 1,
    rows: rows.map((row) => ({ ...row, source: "default", groupIds: [] })),
  });
  spies.push(load, effective);
  expect(await loadCodeHelpReference("weather", { authority: person("guest") })).toBeNull();
  expect(load).not.toHaveBeenCalled();

  expect(await loadCodeHelpReference("no-code-app", { authority: person("user") })).toEqual({ export: null, operations: [], events: [] });
  expect(effective).not.toHaveBeenCalled();

  const weather = await loadCodeHelpReference("weather", { authority: person("user"), locale: "de" });
  expect(weather).toEqual(codeHelpReference("weather", manifests, rows));
  expect(load).toHaveBeenLastCalledWith({ authority: person("user"), locale: "de" });

  // The warning stays in the test; it must not try to write to Postgres.
  const warnings: unknown[] = [];
  const log = spyOn(logging, "logger").mockReturnValue({
    debug() {},
    info() {},
    error() {},
    warn: (...args: unknown[]) => warnings.push(args),
  });
  spies.push(log);
  load.mockRejectedValueOnce(new Error("catalog down"));
  expect(await loadCodeHelpReference("weather", { authority: person("user") })).toBe("failed");
  expect(warnings).toEqual([["Code help reference unavailable", { appId: "weather", error: "catalog down" }]]);
});
