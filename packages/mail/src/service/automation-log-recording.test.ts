import { expect, test } from "bun:test";
import { sql } from "bun";
import { projectAutomationAudit } from "./automation-log-recording";

test("a secondary conversation receives only its effects, without another conversation's AI evidence", async () => {
  const outcome = (conversationId?: string) => ({
    step_key: conversationId ?? "unscoped",
    source_path: [],
    action: "addComment",
    kind: "action",
    state: "completed",
    outcome: null,
    effect_output: { applied: true, ...(conversationId ? { conversationId } : {}) },
  });
  const audit = await projectAutomationAudit(sql, {
    steps: [],
    outcomes: [outcome("source"), outcome("secondary"), outcome()],
    conversationId: "secondary",
    evidenceConversationId: "source",
    ai: [{ kind: "extract_data", request: {}, output: { privateSourceData: "source-only content" }, status: "succeeded" }],
  });
  expect(audit.effects).toEqual([{ kind: "comment" }]);
  expect(audit.reasons).toEqual([]);
  expect(audit.fixedRows).toEqual([]);
});

test("an executed non-AI condition is recorded alongside its comparison", async () => {
  const audit = await projectAutomationAudit(sql, {
    steps: [
      { kind: "if", sourcePath: ["steps", 0], condition: { operator: "contains", operands: ["invoice", "inv"] }, then: [], else: [] },
    ],
    outcomes: [
      {
        step_key: "if",
        source_path: ["steps", 0],
        action: null,
        kind: "if",
        state: "completed",
        outcome: { mode: "execute", outcome: { control: { branches: ["then"] } } },
        effect_output: null,
      },
    ],
    conversationId: "source",
    evidenceConversationId: "source",
    ai: [],
  });
  expect(audit.reasons).toContainEqual(expect.objectContaining({ kind: "comparison", met: true }));
  expect(audit.reasons).toContainEqual(expect.objectContaining({ kind: "condition" }));
});
