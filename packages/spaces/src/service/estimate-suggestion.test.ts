import { describe, expect, test } from "bun:test";
import { AiQuotaError } from "@k2b/cloud/ai";
import type { AccessSubject } from "@k2b/cloud/server";
import {
  type EstimateSuggestionDependencies,
  type EstimateSuggestionStore,
  estimateInput,
  estimatePrompt,
  isEstimateSuggestionAvailable,
  roundEstimate,
  suggestEstimate,
} from "./estimate-suggestion";

const subject: AccessSubject = { type: "user", userId: "11111111-1111-4111-8111-111111111111" } as AccessSubject;
const source = {
  itemId: "22222222-2222-4222-8222-222222222222",
  title: "Prepare the workshop room",
  description: "Chairs, projector, coffee.",
  checklist: ["Book the room", "Test the projector"],
};

const memoryStore = () => {
  const entries = new Map<string, string>();
  const store: EstimateSuggestionStore = {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => void entries.set(key, value),
  };
  return { entries, store };
};

type Output = { minutes: number | null; confidence: "high" | "low"; reason: string | null };
const runner = (answer: Output | Error) => {
  const calls: Parameters<EstimateSuggestionDependencies["run"]>[0][] = [];
  const run = (async (input: Parameters<EstimateSuggestionDependencies["run"]>[0]) => {
    calls.push(input);
    if (answer instanceof Error) throw answer;
    return { output: answer };
  }) as unknown as EstimateSuggestionDependencies["run"];
  return { calls, run };
};

describe("estimate suggestions", () => {
  test("round to the form's quarter-hour grid, at least one step", () => {
    expect(roundEstimate(1)).toBe(15);
    expect(roundEstimate(52)).toBe(45);
    expect(roundEstimate(53)).toBe(60);
    expect(roundEstimate(90)).toBe(90);
    expect(roundEstimate(2_147_483_647) % 15).toBe(0);
  });

  test("the model reads only the bounded task text, as untrusted data, and answers in the person's language", () => {
    const long = estimateInput({
      ...source,
      description: "x".repeat(10_000),
      checklist: Array.from({ length: 150 }, () => "y".repeat(500)),
    });
    expect(long.description).toHaveLength(4_000);
    expect(long.checklist).toHaveLength(100);
    expect(long.checklist[0]).toHaveLength(200);
    expect(estimatePrompt("de")).toContain("untrusted data");
    expect(estimatePrompt("de")).toContain("German");
    expect(estimatePrompt("en-GB")).toContain("English");
  });

  test("a ready estimate is charged to the person once and then comes from the cache", async () => {
    const { entries, store } = memoryStore();
    const { calls, run } = runner({ minutes: 100, confidence: "low", reason: " Wie viele Räume es sind, ist offen. " });
    const first = await suggestEstimate({ source, subject, locale: "de" }, { store, run });
    expect(first).toEqual({
      state: "ready",
      suggestion: {
        id: expect.stringMatching(/^estimate:/),
        minutes: 105,
        confidence: "low",
        reason: "Wie viele Räume es sind, ist offen.",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      usageSubject: subject,
      appId: "spaces",
      task: "spaces.estimate-suggestion",
      model: { class: "fast" },
    });
    expect(String(calls[0]!.input)).toContain("untrusted_task");
    expect(entries.size).toBe(1);

    expect(await suggestEstimate({ source, subject, locale: "de" }, { store, run })).toEqual(first);
    expect(calls).toHaveLength(1);
    // Another text asks again, with another suggestion id.
    const changed = await suggestEstimate({ source: { ...source, title: "Prepare two rooms" }, subject, locale: "de" }, { store, run });
    expect(calls).toHaveLength(2);
    expect(changed.state === "ready" && first.state === "ready" && changed.suggestion.id !== first.suggestion.id).toBe(true);
  });

  test("a certain estimate carries no reason; too little text is no suggestion and is cached too", async () => {
    const certain = runner({ minutes: 30, confidence: "high", reason: "ignored" });
    expect(await suggestEstimate({ source, subject, locale: "en" }, { store: memoryStore().store, run: certain.run })).toMatchObject({
      state: "ready",
      suggestion: { minutes: 30, confidence: "high", reason: null },
    });

    const { store } = memoryStore();
    const none = runner({ minutes: null, confidence: "low", reason: null });
    expect(await suggestEstimate({ source, subject, locale: "en" }, { store, run: none.run })).toEqual({ state: "none" });
    expect(await suggestEstimate({ source, subject, locale: "en" }, { store, run: none.run })).toEqual({ state: "none" });
    expect(none.calls).toHaveLength(1);
  });

  test("failures say why and are never cached; a cache outage only costs another call", async () => {
    const { entries, store } = memoryStore();
    const quota = runner(new AiQuotaError("quota_exhausted", "used up"));
    expect(await suggestEstimate({ source, subject, locale: "de" }, { store, run: quota.run })).toEqual({
      state: "failed",
      reason: "allowance",
    });
    const settings = runner(Object.assign(new Error("no model"), { aiError: { code: "model_not_allowed" } }));
    expect(await suggestEstimate({ source, subject, locale: "de" }, { store, run: settings.run })).toEqual({
      state: "failed",
      reason: "unavailable",
    });
    const broken = runner(new Error("provider down"));
    expect(await suggestEstimate({ source, subject, locale: "de" }, { store, run: broken.run })).toEqual({
      state: "failed",
      reason: "error",
    });
    expect(entries.size).toBe(0);

    const down: EstimateSuggestionStore = {
      get: async () => {
        throw new Error("valkey down");
      },
      set: async () => {
        throw new Error("valkey down");
      },
    };
    const ok = runner({ minutes: 60, confidence: "high", reason: null });
    expect(await suggestEstimate({ source, subject, locale: "de" }, { store: down, run: ok.run })).toMatchObject({ state: "ready" });
  });

  test("an aborted request stops without an answer", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = runner(new Error("aborted"));
    await expect(
      suggestEstimate({ source, subject, locale: "de", signal: controller.signal }, { store: memoryStore().store, run: aborted.run }),
    ).rejects.toThrow("aborted");
  });

  test("the field is offered only to people who may use the assistant's fast model", async () => {
    const allowed = { selectModel: async () => ({ class: "fast" as const }), resolveModel: async () => ({}) };
    expect(await isEstimateSuggestionAvailable(subject, allowed as never)).toBe(true);
    const denied = {
      selectModel: async () => {
        throw new Error("not allowed");
      },
      resolveModel: async () => ({}),
    };
    expect(await isEstimateSuggestionAvailable(subject, denied as never)).toBe(false);
  });
});
