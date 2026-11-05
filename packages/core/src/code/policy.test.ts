import { describe, expect, test } from "bun:test";
import { CAPABILITY_ASK_REASONS, CapabilityActionCallReviewSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { coreCapabilityMessages } from "../capability-messages";
import {
  CodePolicyDefinitionSchema,
  CodePolicyManifestSchema,
  type CodePolicyValue,
  codePolicyContracts,
  codePolicyPreset,
  codePolicyRow,
  normalizeCodePolicy,
  StoredCodePolicyDefinitionSchema,
} from "./policy-contracts";
import { type CodePolicyGroups, effective } from "./policy-effective";

const owner = { kind: "person" as const, userId: "person" };
const groups: CodePolicyGroups["groups"] = [
  { id: "parent", provider: "local" },
  { id: "child", provider: "local" },
  { id: "peer", provider: "local" },
  { id: "ipa1", provider: "ipa" },
  { id: "ipa2", provider: "ipa" },
];
type Case = {
  name: string;
  rules: [string, CodePolicyValue][];
  edges?: [string, string][];
  fallback?: CodePolicyValue;
  want: CodePolicyValue;
  resource?: boolean;
};
const cases: Case[] = [
  { name: "no group rule inherits default", rules: [], want: "admin" },
  {
    name: "subgroup overrides parent",
    rules: [
      ["parent", "admin"],
      ["child", "automatic"],
    ],
    edges: [["child", "parent"]],
    want: "automatic",
  },
  {
    name: "unrelated groups are peers regardless of depth",
    rules: [
      ["parent", "automatic"],
      ["peer", "admin"],
    ],
    edges: [["child", "parent"]],
    want: "admin",
  },
  {
    name: "local and IPA providers have equal rank",
    rules: [
      ["child", "automatic"],
      ["ipa1", "admin"],
    ],
    want: "admin",
  },
  {
    name: "cross-provider ancestry cannot override",
    rules: [
      ["child", "automatic"],
      ["ipa1", "admin"],
    ],
    edges: [["child", "ipa1"]],
    want: "admin",
  },
  {
    name: "IPA groups remain peers even with an edge",
    rules: [
      ["ipa1", "automatic"],
      ["ipa2", "admin"],
    ],
    edges: [["ipa1", "ipa2"]],
    want: "admin",
  },
  {
    name: "cycle is equal rank",
    rules: [
      ["parent", "admin"],
      ["child", "automatic"],
    ],
    edges: [
      ["child", "parent"],
      ["parent", "child"],
    ],
    want: "admin",
  },
  {
    name: "never in an ancestor vetoes a subgroup",
    rules: [
      ["parent", "never"],
      ["child", "automatic"],
    ],
    edges: [["child", "parent"]],
    want: "never",
  },
  { name: "default never vetoes every group", rules: [["child", "automatic"]], fallback: "never", want: "never" },
  {
    name: "unrelated group never wins",
    rules: [
      ["child", "automatic"],
      ["peer", "never"],
    ],
    want: "never",
  },
  { name: "a nonmember rule has no effect", rules: [["foreign", "never"]], want: "admin" },
  { name: "resource ignores group loosening", rules: [["child", "automatic"]], resource: true, want: "admin" },
  {
    name: "resource uses default rather than group admin",
    rules: [["child", "admin"]],
    fallback: "automatic",
    resource: true,
    want: "automatic",
  },
  { name: "resource retains author veto", rules: [["child", "never"]], fallback: "automatic", resource: true, want: "never" },
];
describe("Code policy group resolution", () => {
  for (const item of cases)
    test(item.name, () => {
      const policy = codePolicyPreset("admin");
      policy.preset = "custom";
      policy.rules = policy.rules.map((rule) => (rule.row === "silent_shared" ? { ...rule, value: item.fallback ?? "admin" } : rule));
      policy.rules.push(...item.rules.map(([groupId, value]) => ({ groupId, row: "silent_shared" as const, value })));
      const membership = { groups, ancestors: (item.edges ?? []).map(([groupId, ancestorId]) => ({ groupId, ancestorId })) };
      expect(
        effective(
          "silent_shared",
          item.resource ? { kind: "resource", ref: { type: "example.owner", id: "x" } } : owner,
          policy,
          membership,
        ).value,
      ).toBe(item.want);
      if (item.resource) expect(effective("silent_shared", { kind: "app", appId: "example" }, policy, membership).value).toBe(item.want);
      expect(effective("silent_shared", owner, policy, { groups: [...groups].reverse(), ancestors: membership.ancestors })).toEqual(
        effective("silent_shared", owner, policy, membership),
      );
    });
  test("presets and replacement validation", () => {
    for (const preset of ["off", "admin", "open"] as const)
      expect(CodePolicyDefinitionSchema.safeParse(codePolicyPreset(preset)).success).toBe(true);
    const policy = codePolicyPreset("admin");
    expect(CodePolicyDefinitionSchema.safeParse({ ...policy, rules: policy.rules.slice(1) }).success).toBe(false);
    expect(CodePolicyDefinitionSchema.safeParse({ ...policy, rules: [...policy.rules, policy.rules[0]] }).success).toBe(false);
    expect(CodePolicyDefinitionSchema.safeParse({ ...policy, preset: "open" }).success).toBe(false);
    expect(codePolicyPreset("off").rules.every((rule) => rule.value === "never")).toBe(true);
    expect(codePolicyPreset("open").rules.every((rule) => rule.value === (rule.row.startsWith("ask_") ? "never" : "automatic"))).toBe(true);
  });
  test("stored historical presets stay readable, missing defaults deny, and checked rows are unique", () => {
    const historical = codePolicyPreset("open");
    historical.rules = historical.rules.filter((rule) => rule.row !== "read");
    expect(StoredCodePolicyDefinitionSchema.safeParse(historical).success).toBe(true);
    expect(CodePolicyDefinitionSchema.safeParse(historical).success).toBe(false);
    expect(effective("read", owner, historical, { groups: [], ancestors: [] }).value).toBe("never");
    expect(CodePolicyManifestSchema.safeParse({ policyRows: ["read", "read"] }).success).toBe(false);
  });
  test("classifies every public call category and defaults missing Action policy conservatively", () => {
    expect(codePolicyRow("query")).toBe("read");
    expect(codePolicyRow("ai")).toBe("ai");
    expect(codePolicyRow("internet")).toBe("internet");
    expect(codePolicyRow("action")).toBe("ask_app_asks");
    for (const silent of ["you", "draft", "shared"] as const) expect(codePolicyRow("action", { silent })).toBe(`silent_${silent}`);
    for (const ask of CAPABILITY_ASK_REASONS) expect(codePolicyRow("action", { ask })).toBe(`ask_${ask}`);
  });
});

test("policy review catalog supplies valid complete-review sentences and localized classifications", () => {
  for (const requested of ["en", "de", "fr"]) {
    const { t, locale } = coreCapabilityMessages(requested);
    expect(
      CapabilityActionCallReviewSchema.safeParse({
        locale,
        slots: {},
        sentence: {
          action: t.codePolicyReview({ revision: 2, count: 3 }),
          running: t.codePolicyRunning,
          done: t.codePolicyDone,
          confirm: t.codePolicyConfirm,
          decline: t.codePolicyDecline,
        },
      }).success,
    ).toBe(true);
    expect(t.codePolicyRow({ row: "read" })).toBe(locale === "de" ? "Lesen" : "Read");
    expect(t.codePolicyValue({ value: "admin" })).toBe(locale === "de" ? "Admin gibt frei" : "Admin approval");
  }
});

test("the admin preset requires approval for internet versions of every owner", () => {
  const definition = codePolicyPreset("admin");
  const membership: CodePolicyGroups = { groups: [], ancestors: [] };
  for (const candidate of [owner, { kind: "resource" as const, ref: { type: "example.item", id: "owner" } }])
    expect(effective("internet", candidate, definition, membership).value).toBe("admin");
});

test("F9 B classifies each actual call; an all-admin table also covers reads", () => {
  const defaults = codePolicyPreset("admin");
  for (const rule of defaults.rules)
    expect(rule.value).toBe(
      rule.row.startsWith("ask_") ? "never" : ["read", "silent_you", "silent_draft"].includes(rule.row) ? "automatic" : "admin",
    );
  expect(codePolicyRow("action")).toBe("ask_app_asks");
  const allAdmin = { ...defaults, preset: "custom" as const, rules: defaults.rules.map((rule) => ({ ...rule, value: "admin" as const })) };
  for (const candidate of [
    owner,
    { kind: "resource" as const, ref: { type: "example.owner", id: "x" } },
    { kind: "app" as const, appId: "example" },
  ])
    for (const rule of allAdmin.rules)
      expect(effective(rule.row, candidate, allAdmin, { groups: [], ancestors: [] }).value).toBe(
        rule.row.startsWith("ask_") ? "never" : "admin",
      );
});

test("every asking row normalizes stored defaults and group overrides to never", () => {
  for (const value of ["automatic", "admin", "never"] as const) {
    const policy = codePolicyPreset("open");
    const historical = {
      ...policy,
      rules: policy.rules.flatMap((rule) => [
        { ...rule, value: rule.row.startsWith("ask_") ? value : rule.value },
        { ...rule, groupId: "11111111-1111-4111-8111-111111111111", value },
      ]),
    };
    const normalized = normalizeCodePolicy(StoredCodePolicyDefinitionSchema.parse(historical));
    expect(normalized.rules.filter((rule) => rule.row.startsWith("ask_")).every((rule) => rule.value === "never")).toBe(true);
    for (const rule of normalized.rules.filter((rule) => rule.row.startsWith("ask_")))
      expect(effective(rule.row, owner, historical, { groups: [], ancestors: [] }).value).toBe("never");
  }
});

test("policy transport contracts compile to capability JSON Schema", () => {
  for (const contract of Object.values(codePolicyContracts)) {
    expect(() => z.toJSONSchema(contract.input, { io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(contract.data)).not.toThrow();
  }
});

test("operators can recognize and recover the asking-action migration pause", async () => {
  const docs = await Bun.file(new URL("../../../../docs-site/docs/en/operations/code-activation.md", import.meta.url)).text();
  expect(docs).toContain("visibly pauses active versions");
  expect(docs).toContain("group overrides to **Never**");
  expect(docs).toContain("Replace asking Actions with silent Actions");
  expect(docs).toContain("activate the replacement version");
});
