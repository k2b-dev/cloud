import { expect, test } from "bun:test";
import { AiModelInputSchema, AiQuotaConfigSchema, aiModelSupportsSlot, aiQuotaHref, aiReplacementProblem } from "@k2b/cloud/shared";
import { aiFixtureCatalog } from "./AiArea.fixture-data";
import { aiSettingsRedirectHref } from "./area";
import { AiAdminConflict, asAiConflict } from "./client";
import { conflictingFields, mergeDrafts } from "./merge-drafts";
import { aiAreaMessages } from "./messages";
import { proposeAiModelIds } from "./model-ids";
import { aiProviderFailureText } from "./presentation";
import { AiProviderDetailSchema, AiQuotaAdminConfigSchema } from "./read-shapes";

test("the visible default keeps mine; explicit choices and independent remote edits merge", () => {
  const base = { label: "Original", hours: 168, grants: [] };
  const mine = { ...base, label: "My label" };
  const theirs = { ...base, label: "Their label", hours: 24 };
  expect(conflictingFields(base, mine, theirs, ["label", "hours", "grants"])).toEqual(["label"]);
  expect(mergeDrafts(base, mine, theirs, ["label", "hours", "grants"], {})).toEqual({ ...mine, hours: 24 });
  expect(mergeDrafts(base, mine, theirs, ["label", "hours", "grants"], { label: "theirs" })).toEqual(theirs);
});

test("variant override switches merge together with their values", () => {
  const base = { ownPrice: false, input: null as number | null, output: null as number | null, ownOut: false, max: null as number | null };
  const mine = { ownPrice: true, input: 2, output: 3, ownOut: true, max: 4000 };
  expect(mergeDrafts(base, mine, base, ["ownPrice", "input", "output", "ownOut", "max"], {})).toEqual(mine);
});

test("conflict parsers accept provider and budget read snapshots, reject malformed snapshots without throwing", () => {
  const { providers, models } = aiFixtureCatalog();
  const provider = { ...providers[0]!, models };
  const config = {
    enabled: true,
    revision: 4,
    rules: [{ scope: "*", hours: 168, anchor: "2026-10-26T00:00:00.000Z", grants: [], peopleAtLimit: 2 }],
  };
  expect(AiProviderDetailSchema.parse(provider).models).toEqual(models);
  expect(AiQuotaConfigSchema.safeParse(config).success).toBe(false);
  expect(asAiConflict(new AiAdminConflict(config, null, ""), AiQuotaAdminConfigSchema)?.current).toEqual(config);
  expect(asAiConflict(new AiAdminConflict({ invalid: true }, null, ""), AiQuotaAdminConfigSchema)).toBeNull();
});

test("model ids reserve global and batch collisions and preserve correctable explicit ids", () => {
  const models = ["vendor/a", "other/a", "vendor-a"];
  const ids = proposeAiModelIds("demo", models, ["demo-vendor-a"], {});
  expect(new Set(Object.values(ids)).size).toBe(3);
  expect(Object.values(ids)).not.toContain("demo-vendor-a");
  for (const id of Object.values(ids)) expect(AiModelInputSchema.shape.id.safeParse(id).success).toBe(true);
  expect(proposeAiModelIds("demo", models, [], { "vendor/a": "corrected" })["vendor/a"]).toBe("corrected");
  const named = proposeAiModelIds("demo", ["constructor", "__proto__", "toString"], [], {});
  expect(Object.values(named).every((id) => typeof id === "string")).toBe(true);
  expect(Object.keys(named)).toHaveLength(3);
  const long = proposeAiModelIds("demo", ["a".repeat(130), "a".repeat(131)], [], {});
  expect(new Set(Object.values(long)).size).toBe(2);
  for (const id of Object.values(long)) expect(id.length).toBeLessThanOrEqual(120);
});

test("deletion requires enabled models, every original capability, kind and private boundary, plus slot support", () => {
  const { providers, models } = aiFixtureCatalog();
  const source = providers[0]!;
  const model = { ...models[0]!, capabilities: ["tools", "vision"] as ("tools" | "vision")[] };
  expect(aiReplacementProblem(source, source, model, model)).toBeNull();
  expect(aiReplacementProblem(source, source, model, { ...model, capabilities: ["vision"] })).toBe("incompatible_model");
  expect(aiReplacementProblem(source, source, model, { ...model, kind: "transcription" })).toBe("incompatible_model");
  expect(aiReplacementProblem(source, { ...source, enabled: false }, model, model)).toBe("incompatible_model");
  expect(aiReplacementProblem(source, source, model, { ...model, enabled: false })).toBe("incompatible_model");
  expect(aiReplacementProblem({ ...source, dataBoundary: "private" }, { ...source, dataBoundary: "hosted" }, model, model)).toBe(
    "private_boundary",
  );
  expect(aiModelSupportsSlot("audio", model)).toBe(false);
  expect(aiModelSupportsSlot("vision", { ...model, capabilities: ["tools"] })).toBe(false);
});

test("people budget navigation stays in the canonical area across filters, pagination and reset", () => {
  for (const patch of [{}, { page: 2, search: "A & B" }, { view: "users" as const, status: "exhausted" as const }]) {
    const url = new URL(aiQuotaHref(patch), "https://example.test");
    expect(url.pathname).toBe("/admin/ai");
    expect(url.searchParams.get("sec")).toBe("budgets");
    expect(url.searchParams.get("rule")).toBe("people");
  }
  expect(aiQuotaHref({ view: "rules" })).not.toContain("rule=people");
});

test("provider failures use localized known statuses and codes", () => {
  for (const language of ["de", "en"]) {
    const t = aiAreaMessages.resolve([language]).t;
    expect(aiProviderFailureText(t, "unreachable", null)).toBe(t.testFailNet);
    expect(aiProviderFailureText(t, "error", "429")).toBe(t.providerRateLimited);
    expect(aiProviderFailureText(t, "error", "401")).toBe(t.testFailKey);
    expect(aiProviderFailureText(t, "error", "503")).toBe(t.providerRequestFailed);
  }
});

test("old quota links map users and rules to their corresponding area view", () => {
  const queries: Record<string, string>[] = [{}, { view: "users" }, { view: "users", page: "2", search: "Demo" }];
  for (const query of queries) {
    const url = new URL(aiSettingsRedirectHref("ai-quotas", query)!, "https://example.test");
    expect(url.searchParams.get("rule")).toBe("people");
    expect(url.searchParams.get("tab")).toBeNull();
  }
  expect(aiSettingsRedirectHref("ai-quotas", { view: "rules" })).not.toContain("rule=people");
});
