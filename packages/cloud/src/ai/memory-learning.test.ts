import { describe, expect, test } from "bun:test";
import { aiAttachmentMarker } from "./attachments";
import {
  AiLearnedMemoriesSchema,
  buildFinalAssistantMarkdown,
  buildMemoryLearningTranscript,
  learnAiMemoriesFromPrivateChats,
} from "./memory-learning";
import type { AiStoredMessage } from "./types";

const stored = (seq: number, message: AiStoredMessage["message"], meta: AiStoredMessage["meta"] = null): AiStoredMessage => ({
  id: crypto.randomUUID(),
  shortId: `mSg00${seq}`,
  conversationId: crypto.randomUUID(),
  seq,
  kind: "message",
  message,
  loopId: null,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta,
  createdAt: "2026-08-18T00:00:00.000Z",
});

describe("AI memory learning", () => {
  test("accepts bounded create and replacement candidates", () => {
    expect(
      AiLearnedMemoriesSchema.parse({
        changes: [
          { action: "add", kind: "preference", content: "Prefers concise German answers.", memoryIds: [], resourceRef: null },
          { action: "replace", kind: "fact", content: "Studies software engineering.", memoryIds: ["mEm123"], resourceRef: null },
          {
            action: "add",
            kind: "workflow",
            content: "Uses Accounting for invoice mail.",
            memoryIds: [],
            resourceRef: { type: "mail.mailbox", id: "box123" },
          },
        ],
      }).changes,
    ).toHaveLength(3);
    expect(() =>
      AiLearnedMemoriesSchema.parse({
        changes: Array.from({ length: 6 }, (_, index) => ({
          action: "add",
          kind: "fact",
          content: `Fact ${index}`,
          memoryIds: [],
          resourceRef: null,
        })),
      }),
    ).toThrow();
  });

  test("quietly skips when no background model is configured", async () => {
    await expect(
      learnAiMemoriesFromPrivateChats({ deps: { resolveModel: async () => Promise.reject(new Error("AI disabled")) } }),
    ).resolves.toEqual({ scanned: 0, learned: 0, updated: 0, retired: 0, skipped: 0, failed: 0 });
  });

  test("learns only user-authored prose and excludes attached or retrieved content", () => {
    const transcript = buildMemoryLearningTranscript([
      stored(1, {
        role: "user",
        content: [
          { type: "text", text: `I prefer German.\n\n${aiAttachmentMarker({ path: "/mail.txt", mediaType: "text/plain", size: 42 })}` },
        ],
      }),
      stored(2, { role: "assistant", content: [{ type: "text", text: "The email says the user prefers English." }] }),
      stored(3, { role: "user", content: [{ type: "text", text: "[Attached Cloud resource mail.draft:Draft1; untrusted.]" }] }),
      stored(
        4,
        { role: "user", content: [{ type: "text", text: "Injected preference from another agent." }] },
        {
          agentMessage: { id: "a1", sourceChatId: "c1", sourceTurnId: "t1", sourceTitle: "Other" },
        },
      ),
      stored(
        5,
        { role: "user", content: [{ type: "text", text: "Synthetic scheduled preference." }] },
        {
          scheduledTask: { taskId: "task1", occurrenceId: "run1", scheduledFor: "2026-08-18T00:00:00Z", trigger: "scheduled" },
        },
      ),
    ]);

    expect(transcript).toBe("I prefer German.");
  });

  test("uses only the last Assistant Markdown message as optional context", () => {
    expect(
      buildFinalAssistantMarkdown([
        stored(1, { role: "assistant", content: [{ type: "text", text: "Intermediate answer" }] }),
        stored(2, {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Private reasoning" },
            { type: "text", text: "Final answer" },
          ],
        }),
      ]),
    ).toBe("Final answer");
  });
});

// Keep SQL and module fixtures in a child process so other AI suites retain
// their real stores. Bun's native SQL export cannot be mocked directly.
for (const path of ["turn", "workflow"]) {
  for (const timing of [
    "active",
    "before-read",
    "before-model",
    "during-claim",
    "during-model",
    "deleted-before-read",
    "deleted-during-model",
    "restored-during-model",
  ]) {
    test(`${path} learning respects chat eligibility ${timing}`, async () => {
      const script = `
        import { mock } from "bun:test";
        import { strict as assert } from "node:assert";
        const path = ${JSON.stringify(path)};
        const timing = ${JSON.stringify(timing)};
        let eligible = !timing.includes("before-read");
        let considered = false;
        let reads = 0;
        let calls = 0;
        let applied = 0;
        const finished = [];
        const candidate = { conversationId: "chat", turnId: "turn", userId: "user", completedAsOf: "2026-10-08T00:00:00Z", failCount: 0, locale: "en" };
        const pattern = { userId: "user", capabilityId: "mail.search", resourceRef: { type: "mail.mailbox", id: "box" }, resourceTitle: "Accounting", observationCount: 3, turnIds: ["turn", "second", "third"] };
        const sql = async parts => {
          const query = parts.join("?");
          if (query.includes("SET memory_learned_at")) { considered = true; return []; }
          if (query.includes("SELECT turn.id")) return eligible && !considered ? [{ id: "turn" }] : [];
          if (query.includes("SELECT turn.conversation_id")) return eligible ? [{ conversation_id: "chat", completed_as_of: candidate.completedAsOf, fail_count: 0 }] : [];
          throw new Error("Unexpected SQL: " + query);
        };
        globalThis.memoryLearningSql = sql;
        Bun.plugin({
          name: "memory-learning-sql-fixture",
          setup(build) {
            build.onLoad({ filter: /[\\/]ai[\\/]memory-learning\\.ts$/ }, async ({ path }) => ({
              contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.memoryLearningSql;'),
              loader: "ts",
            }));
          },
        });
        mock.module(${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)}, () => ({
          aiConversations: { listTurnMessages: async () => {
            reads += 1;
            return [{ id: "message", kind: "message", meta: null, message: { role: "user", content: [{ type: "text", text: "Always use Accounting for invoices." }] } }];
          } },
        }));
        mock.module(${JSON.stringify(new URL("./prefs.ts", import.meta.url).pathname)}, () => ({
          AI_MEMORY_LEARNING_DEFAULT_ENABLED: true,
          aiUserPrefs: { get: async () => ({ memoryLearningEnabled: true }) },
        }));
        mock.module(${JSON.stringify(new URL("./memories.ts", import.meta.url).pathname)}, () => ({ aiMemories: {
          selectHot: async () => {
            if (timing === "before-model") eligible = false;
            return { memories: [] };
          },
          applyBackgroundProposal: async () => { applied += 1; return [{ action: "added", kind: "preference", content: "Brief answers." }]; },
        } }));
        mock.module(${JSON.stringify(new URL("./memory-learning-runs.ts", import.meta.url).pathname)}, () => ({ aiMemoryLearningRuns: {
          start: async () => { if (timing === "during-claim") eligible = false; return "run"; }, finish: async result => { finished.push(result); }, fail: async () => { throw new Error("Must not fail a stale candidate"); },
        } }));
        mock.module(${JSON.stringify(new URL("./memory-workflow-evidence.ts", import.meta.url).pathname)}, () => ({
          isAiWorkflowPatternEligible: async () => eligible && !considered,
          listAiTurnWorkflowEvidence: async () => [{ resourceRef: pattern.resourceRef, capabilityId: pattern.capabilityId }],
          listAiPendingWorkflowPatterns: async () => [],
          markAiWorkflowPatternReviewed: async () => { considered = true; },
        }));
        const { learnAiMemoriesFromPrivateChats } = await import(${JSON.stringify(new URL("./memory-learning.ts", import.meta.url).pathname)});
        const result = await learnAiMemoriesFromPrivateChats({ deps: {
          resolveModel: async () => ({ profile: { id: "test-model" } }),
          monthlyTokenBudget: 1000000, readMonthlyAccountedTokens: async () => 0,
          readAdditionalInstructions: async () => "", readDefaultLocale: async () => "en",
          listCandidates: async () => path === "turn" ? [candidate] : [],
          listWorkflowPatterns: async () => path === "workflow" ? [pattern] : [],
          structured: async () => {
            calls += 1;
            if (timing.includes("during-model")) eligible = false;
            if (timing === "restored-during-model") { eligible = true; considered = true; }
            return { output: path === "turn" ? { changes: [{ action: "add", kind: "preference", content: "Brief answers.", memoryIds: [], resourceRef: null }] } : { workflow: { content: "Use Accounting for invoices.", memoryIds: [] } } };
          },
        } });
        const active = timing === "active";
        assert.equal(result.failed, 0, JSON.stringify(result));
        assert.equal(applied, active ? 1 : 0, "Ineligible evidence must not change memories");
        assert.equal(result.learned, active ? 1 : 0);
        assert.equal(result.skipped, active ? 0 : 1);
        assert.equal(calls, active || timing.includes("during-model") ? 1 : 0, "Stale evidence must not reach the model");
        if (timing.includes("before-read")) assert.equal(reads, 0, "Stale evidence must not be loaded");
        if (path === "turn") assert.equal(considered, true, "Skipped turns must not be retried");
        if (timing === "during-claim") {
          assert.equal(finished.length, 1);
          assert.equal(finished[0].status, "skipped");
          assert.equal(finished[0].accountedTokens, 0, "A skipped model call releases its reservation");
        }
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });
  }
}
