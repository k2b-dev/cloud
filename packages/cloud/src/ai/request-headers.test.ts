import { describe, expect, test } from "bun:test";
import type { sql } from "bun";
import { AiRequestHeadersSchema, patchAiRequestHeaders } from "../shared/ai-request-options";
import { splitAiProfileCredentials } from "./credentials";
import {
  getAiRequestHeaders,
  listAiRequestHeaderNames,
  planAiProfileRequestHeaders,
  setAiRequestHeaders,
  storeAiRequestHeaderPlan,
} from "./request-headers";
import { parseAiModelProfiles } from "./settings";

const profiles = (provider = "vllm") =>
  parseAiModelProfiles(JSON.stringify([{ id: "model", label: "Model", provider, model: "model" }])).profiles;

describe("write-only request headers", () => {
  test("splits submitted patches out of the stored profiles, preserves non-secret settings", () => {
    const patch = { "X-Token": "never-return-this", "X-Old": null };
    const split = splitAiProfileCredentials(
      JSON.stringify([
        { id: " model ", requestHeaders: patch, requestHeaderNames: ["X-Token"], reasoningEffort: "low", extraBody: { custom: true } },
      ]),
    );
    expect(split?.requestHeaders).toEqual([{ profileId: "model", patch }]);
    expect(JSON.parse(split!.profilesJson)).toEqual([{ id: "model", reasoningEffort: "low", extraBody: { custom: true } }]);
    expect(splitAiProfileCredentials('[{"id":"model"}]')?.requestHeaders).toEqual([]);
  });

  test("patches case-insensitively, removes nulls, keeps omitted names and canonicalizes Authorization", () => {
    expect(
      patchAiRequestHeaders(
        { "X-Token": "old", "X-Keep": "keep", "X-Remove": "remove" },
        { "x-token": "new", "X-Remove": null, authorization: "secret" },
      ),
    ).toEqual({ "x-token": "new", "X-Keep": "keep", Authorization: "secret" });
    expect(patchAiRequestHeaders({ "X-Token": "secret" }, {})).toEqual({ "X-Token": "secret" });
  });

  test("rejects reserved names, invalid tokens/values, duplicates and limits without echoing values", () => {
    for (const headers of [
      { "Content-Type": "secret" },
      { HOST: "secret" },
      { "content-length": "1" },
      { Connection: "secret" },
      { "Transfer-Encoding": "secret" },
      { "bad name": "secret" },
      { ["a".repeat(129)]: "secret" },
      { "X-Key": "secret", "x-key": "secret" },
      { "X-Key": "secret\r\ninjected" },
      { "X-Key": "secret\0" },
      { "X-Key": "private-token\u{1F600}" },
      { "X-Key": "tok\u200Bsecret" },
      { "X-Key": "caf☃-secret" },
      { "X-Key": "secret\u0001" },
      { "X-Key": "secreté" },
      { "X-Key": "x".repeat(4097) },
      { "X-Key": 123 },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "secret"])),
      [],
      null,
    ]) {
      const parsed = AiRequestHeadersSchema.safeParse(headers);
      expect(parsed.success).toBeFalse();
      if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).not.toContain("secret");
    }
    expect(
      AiRequestHeadersSchema.safeParse({ Authorization: "Bearer custom", "X-Tab": "custom\tvalue", "X-Empty": "", "X-Delete": null })
        .success,
    ).toBeTrue();
  });

  test("plans omission, deletion and provider changes like credentials, rejects unsupported submissions", () => {
    const currentProfiles = profiles();
    const input = { currentProfiles, nextProfiles: currentProfiles, existingNames: { model: ["X-Secret"] }, submitted: [] };
    expect(planAiProfileRequestHeaders(input)).toEqual({ keepHeaderProfileIds: ["model"], patches: [] });
    expect(planAiProfileRequestHeaders({ ...input, nextProfiles: [] }).keepHeaderProfileIds).toEqual([]);
    expect(planAiProfileRequestHeaders({ ...input, nextProfiles: profiles("ollama") }).keepHeaderProfileIds).toEqual([]);
    expect(
      planAiProfileRequestHeaders({
        ...input,
        nextProfiles: profiles("ollama"),
        submitted: [{ profileId: "model", patch: { "X-Secret": "secret" } }],
      }).error,
    ).toContain("only supported");
    expect(planAiProfileRequestHeaders({ ...input, submitted: [{ profileId: "model", patch: { "x-secret": null } }] }).patches).toEqual([
      { profileId: "model", patch: { "x-secret": null } },
    ]);
  });

  test("enforces the total header limit after merging with stored names", () => {
    const input = {
      currentProfiles: profiles(),
      nextProfiles: profiles(),
      existingNames: { model: Array.from({ length: 32 }, (_, i) => `X-${i}`) },
      submitted: [{ profileId: "model", patch: { "X-New": "secret" } }],
    };
    expect(planAiProfileRequestHeaders(input).error).toContain("32");
    expect(
      planAiProfileRequestHeaders({ ...input, submitted: [{ profileId: "model", patch: { "X-0": null, "X-New": "secret" } }] }).error,
    ).toBeUndefined();
  });
});

test("header planning accepts profile IDs that coincide with object prototype names", () => {
  const profile = { ...profiles()[0]!, id: "constructor" };
  expect(
    planAiProfileRequestHeaders({
      currentProfiles: [profile],
      nextProfiles: [profile],
      existingNames: {},
      submitted: [{ profileId: profile.id, patch: { "X-Key": "secret" } }],
    }).error,
  ).toBeUndefined();
});

test("header store encrypts values, preserves omitted patches and prunes deleted profiles without a database", async () => {
  const previousSecret = process.env.APP_SECRET;
  process.env.APP_SECRET = "test-only-request-header-encryption";
  const rows = new Map<string, string>();
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("INSERT")) {
      rows.set(String(values[0]), String(values[1]));
      return [];
    }
    if (query.includes("DELETE")) {
      if (query.includes("profile_id =")) rows.delete(String(values[0]));
      else if (query.includes("ALL")) {
        const keep: string[] = JSON.parse(`[${String(values[0]).slice(1, -1)}]`);
        for (const id of rows.keys()) if (!keep.includes(id)) rows.delete(id);
      } else rows.clear();
      return [];
    }
    if (query.includes("WHERE")) return rows.has(String(values[0])) ? [{ secret: rows.get(String(values[0])) }] : [];
    return [...rows].map(([profile_id, secret]) => ({ profile_id, secret }));
  }) as unknown as typeof sql;
  try {
    await setAiRequestHeaders("model", { "X-Secret": "actual-encrypted-test-value" }, db);
    const stored = rows.get("model")!;
    expect(stored).not.toContain("actual-encrypted-test-value");
    expect(await getAiRequestHeaders("model", db)).toEqual({ "X-Secret": "actual-encrypted-test-value" });
    expect(await listAiRequestHeaderNames(db)).toEqual({ model: ["X-Secret"] });
    const plan = planAiProfileRequestHeaders({
      currentProfiles: profiles(),
      nextProfiles: profiles(),
      existingNames: { model: ["X-Secret"] },
      submitted: [],
    });
    await storeAiRequestHeaderPlan(plan, db);
    expect(rows.get("model")).toBe(stored);
    const patch = planAiProfileRequestHeaders({
      currentProfiles: profiles(),
      nextProfiles: profiles(),
      existingNames: { model: ["X-Secret"] },
      submitted: [{ profileId: "model", patch: { "x-secret": "replacement", "X-Added": "added" } }],
    });
    await storeAiRequestHeaderPlan(patch, db);
    expect(await getAiRequestHeaders("model", db)).toEqual({ "x-secret": "replacement", "X-Added": "added" });
    await storeAiRequestHeaderPlan({ keepHeaderProfileIds: [], patches: [] }, db);
    expect(rows.size).toBe(0);
  } finally {
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  }
});
