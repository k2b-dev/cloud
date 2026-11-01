import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityDefinitions, CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import { mandatePolicyAllows } from "@k2b/cloud/services/mandates";
import { z } from "zod";
import { buildCodeActivationPlan } from "./activation-plan";
import type { Code } from "./contracts";

const operation = {
  title: "Change",
  description: "Fixture.",
  openWorld: false,
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  run: () => ({ ok: true as const, data: { data: {} } }),
};
const action = {
  ...operation,
  review: () => ({
    ok: true as const,
    data: {
      locale: "en",
      slots: {},
      sentence: { action: "Change fixture", running: "Changing fixture", done: "Changed fixture", confirm: "Confirm", decline: "Cancel" },
    },
  }),
};
const definitions = {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "Fixture item.", reader: "item.read" } },
  queries: { "item.read": { ...operation, input: z.object({ id: z.string().describe("Item ID.") }).strict() } },
  actions: { "item.change": { ...action, target: "item", destructive: false, idempotency: "none", policy: { silent: "shared" } } },
} satisfies CapabilityDefinitions;
const catalog = compileCapabilityManifest("example", definitions);
const code: Code = {
  id: "c_unit",
  title: "Test",
  owner: { kind: "resource", ref: { type: "example.item", id: "owner" } },
  serviceAccountId: "11111111-1111-4111-8111-111111111111",
  state: "draft",
  activeVersionId: null,
  pauseReason: null,
  pauseRows: [],
  pausePolicyRevision: null,
  createdBy: null,
  createdAt: "2026-10-31T12:00:00.000Z",
};
const permission = (operation: string, id: string | null) => ({
  operation,
  target: { type: "example.item", id },
  file: "code.ts",
  line: 1,
});
const manifest = (permissions: CodeCheckedVersionManifest["permissions"]): CodeCheckedVersionManifest => ({
  version: 1,
  entry: "code.ts",
  entrypoints: [],
  policyRows: ["silent_shared"],
  permissions,
  ai: false,
  hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
});
test("resource mandate binds an action to its exact target and groups duplicate source rows", () => {
  const plan = buildCodeActivationPlan(
    code,
    manifest([permission("example.item.change", "A"), permission("example.item.change", "A"), permission("example.item.read", "B")]),
    new Map([["example", catalog]]),
  );
  expect(plan.targets).toEqual([
    { target: { type: "example.item", id: "A" }, operations: ["example.item.change"] },
    { target: { type: "example.item", id: "B" }, operations: ["example.item.read"] },
  ]);
  const allows = (id: string) =>
    mandatePolicyAllows(plan.policy, {
      appId: "example",
      operation: "capability.action.run:item.change",
      actionApproval: "none",
      codeAccount: true,
      codeVersion: true,
      capabilityPolicy: { silent: "shared" },
      call: { capability: "example.item.change", target: { type: "example.item", id }, refs: {}, input: {} },
    });
  expect(allows("A")).toBe(true);
  expect(allows("B")).toBe(false);
});
test("personal Code uses operation authority and current personal rights, including dynamic targets", () => {
  const personal = { ...code, owner: { kind: "person" as const, userId: "11111111-1111-4111-8111-111111111111" }, serviceAccountId: null };
  const plan = buildCodeActivationPlan(personal, manifest([permission("example.item.change", null)]), new Map([["example", catalog]]));
  expect(plan.targets).toEqual([]);
  expect(plan.policy.grants).toBeUndefined();
  expect(
    mandatePolicyAllows(plan.policy, {
      appId: "example",
      operation: "capability.action.run:item.change",
      actionApproval: "none",
      codeVersion: true,
      capabilityPolicy: { silent: "shared" },
      call: { capability: "example.item.change", target: { type: "example.item", id: "runtime-id" }, refs: {}, input: {} },
    }),
  ).toBe(true);
});
test("resource Code rejects dynamic targets and unavailable operations before any effects", () => {
  expect(() => buildCodeActivationPlan(code, manifest([permission("example.item.change", null)]), new Map([["example", catalog]]))).toThrow(
    "literal targets",
  );
  expect(() => buildCodeActivationPlan(code, manifest([permission("example.missing", "A")]), new Map([["example", catalog]]))).toThrow(
    "unavailable",
  );
});

test("code:false cannot be activated by resource or personal Code", () => {
  const restricted = { ...catalog, actions: catalog.actions.map((action) => ({ ...action, code: false as const })) };
  for (const candidate of [
    code,
    { ...code, owner: { kind: "person" as const, userId: "11111111-1111-4111-8111-111111111111" }, serviceAccountId: null },
  ]) {
    expect(() =>
      buildCodeActivationPlan(candidate, manifest([permission("example.item.change", "A")]), new Map([["example", restricted]])),
    ).toThrow("unavailable");
  }
});
