import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import { evaluateWorkflowTriggerInputs } from "@k2b/cloud/workflows/runtime";
import type { FrozenMailWorkflowSource } from "../service/workflow-data";
import { bindMailWorkflow } from "./binder";
import { buildMailWorkflowCatalog } from "./catalog";
import { mailWorkflows } from "./module";
import { planMailWorkflowTryItem, workflowReferencedTextFields } from "./try";

const header = `inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "\${{ trigger.message }}"
      conversation: "\${{ trigger.conversation }}"
steps:
`;
const sourceFor = (length: number, bulk = false): FrozenMailWorkflowSource => ({
  message: {
    id: "Messg1",
    conversationId: "Convo1",
    subject: "Offer",
    body: "Hello",
    bodyText: "Hello",
    bodyHtml: "",
    textLength: length,
    bodyAvailable: true,
    attachmentsAvailable: true,
    sender: [{ role: "from", name: "Mara", email: "mara@example.test" }],
    fromAddress: "mara@example.test",
    fromDomain: "example.test",
    recipients: [],
    attachments: [],
    hasAttachments: false,
    attachmentCount: 0,
    isBulk: bulk,
    folderId: "Foldr1",
    flags: [],
    keywords: [],
    direction: "inbound",
    internalDate: "2026-10-20T12:00:00.000Z",
    receivedAt: "2026-10-20T12:00:00.000Z",
    sentAt: null,
  },
  conversation: {
    id: "Convo1",
    subject: "Offer",
    summary: null,
    summaryRevision: 1,
    messageCount: 1,
    assigneeUserIds: [],
    workStatus: "needs_action",
    revision: 1,
    latestMessageAt: "2026-10-20T12:00:00.000Z",
  },
});
const compile = async (steps: string) => {
  const compiled = await compileWorkflow(header + steps, mailWorkflows);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const bound = await bindMailWorkflow(
    compiled.ir,
    buildMailWorkflowCatalog({ folders: [], assignableUsers: [], localTags: [{ id: "Tag001", name: "Long" }] }),
  );
  if (!bound.ok) throw new Error(JSON.stringify(bound.diagnostics));
  return bound.plan;
};
const preview = async (steps: string, length = 642, bulk = false, unavailableTextFields: string[] = []) => {
  const plan = await compile(steps);
  const source = sourceFor(length, bulk);
  return planMailWorkflowTryItem({
    plan,
    source,
    inputs: evaluateWorkflowTriggerInputs(JSON.parse(JSON.stringify(source)), plan.triggers[0]!.with, "2026-10-20T12:00:00.000Z"),
    targets: { labels: new Map(), problems: new Map() },
    occurredAt: "2026-10-20T12:00:00.000Z",
    unavailableTextFields,
  });
};
const example = `  - if:
      all:
        - not: { equals: ["\${{ inputs.message.isBulk }}", true] }
        - any:
            - greaterThan: ["\${{ inputs.message.textLength }}", 150]
            - greaterThan: ["\${{ inputs.conversation.messageCount }}", 3]
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`;
describe("Mail workflow preview", () => {
  test("distinguishes match, explicit exclusion, and unmet conditions with ordered facts", async () => {
    const match = await preview(example);
    expect(match.outcome).toBe("match");
    expect(match.effects).toEqual([{ kind: "addLocalTag", ai: false, params: { tag: "Long" }, dependsOnAi: false }]);
    expect(match.facts).toEqual([
      { path: "message.isBulk", value: false },
      { path: "message.textLength", value: 642 },
      { path: "conversation.messageCount", value: 1 },
    ]);
    expect(await preview(example, 642, true)).toMatchObject({ outcome: "skipped", reason: { code: "excluded", field: "message.isBulk" } });
    expect(await preview(example, 20)).toMatchObject({ outcome: "none", reason: null, effects: [], aiCalls: { min: 0, max: 0 } });
  });
  test("never predicts an AI category and counts an optional extraction once", async () => {
    const item = await preview(`  - aiClassify:
      input: "\${{ inputs.message.subject }}"
      prompt: Classify
      choices: [Complaint, Other]
      saveAs: category
  - if:
      equals: ["\${{ category }}", Complaint]
    then:
      - aiExtractData:
          input: "\${{ inputs.message.subject }}"
          prompt: Extract
          fields: [{ name: topic, type: text, description: Topic }]
          saveAs: details
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
    else:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`);
    expect(item.stoppedAtAi).toBe(true);
    expect(item.aiCalls).toEqual({ min: 1, max: 2 });
    expect(item.effects.map((effect) => [effect.kind, effect.dependsOnAi])).toEqual([
      ["aiClassify", false],
      ["aiExtractData", true],
      ["addLocalTag", true],
      ["addLocalTag", true],
    ]);
  });
  test("exists on AI output remains unknown, as do values copied from AI", async () => {
    const item = await preview(`  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - setVariable: { name: alias, value: "\${{ generated }}" }
  - if:
      exists: alias
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
    else:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`);
    expect(item.effects).toHaveLength(3);
    expect(item.effects.slice(1).every((effect) => effect.dependsOnAi)).toBe(true);
  });
  test("a subject-only condition requires no body", async () => {
    const plan = await compile(`  - if: { contains: ["\${{ inputs.message.subject }}", Offer] }
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`);
    expect([...workflowReferencedTextFields(plan)]).toEqual([]);
    expect([...workflowReferencedTextFields(await compile(example))]).toEqual(["bodyText"]);
  });
});

test("Liquid templates that consume AI stay dependent", async () => {
  const item = await preview(`  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - addComment: { conversation: inputs.conversation, body: "{{ generated }}" }
`);
  expect(item.effects).toHaveLength(2);
  expect(item.effects[1]).toMatchObject({ kind: "addComment", dependsOnAi: true });
  expect(item.problems).toEqual([]);
});

test("missing text after AI remains a visible problem with its own dependency", async () => {
  const item = await preview(
    `  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - if: { equals: ["\${{ inputs.message.bodyText }}", Hello] }
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
  - addComment: { conversation: inputs.conversation, body: "{{ inputs.message.bodyText }}" }
`,
    642,
    false,
    ["bodyText"],
  );
  expect(item.effects.slice(1).every((effect) => !effect.dependsOnAi)).toBe(true);
  expect(item.problems).toContainEqual({ code: "effect_not_allowed", path: ["inputs", "message", "bodyText"] });
  expect(item.problems).toContainEqual({ code: "effect_not_allowed", path: ["steps", 2, "addComment", "body"] });
});

test("exclusive AI branches use their largest call count", async () => {
  const item = await preview(`  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - if: { equals: ["\${{ generated }}", Hello] }
    then:
      - aiGenerateText: { prompt: First, saveAs: first }
      - aiGenerateText: { prompt: Second, saveAs: second }
    else:
      - aiGenerateText: { prompt: Alternative, saveAs: alternative }
`);
  expect(item.aiCalls).toEqual({ min: 1, max: 3 });
});

test("an AI-dependent terminal branch makes later calls optional", async () => {
  const item = await preview(`  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - if: { equals: ["\${{ generated }}", Hello] }
    then:
      - succeed: { message: Done }
  - aiGenerateText: { prompt: Later, saveAs: later }
`);
  expect(item.aiCalls).toEqual({ min: 1, max: 2 });
  expect(item.effects[1]?.dependsOnAi).toBe(true);
});

test("AI that needs unavailable text is possible but never certain", async () => {
  const item = await preview(
    `  - aiGenerateText: { prompt: "\${{ inputs.message.bodyText }}", saveAs: generated }
`,
    642,
    false,
    ["bodyText"],
  );
  expect(item.aiCalls).toEqual({ min: 0, max: 1 });
  expect(item.problems.some((problem) => problem.code === "effect_not_allowed")).toBe(true);
});

test("an unavailable terminal message leaves later effects dependent", async () => {
  const item = await preview(`  - aiGenerateText: { prompt: Hello, saveAs: generated }
  - succeed: { message: "{{ generated }}" }
  - aiGenerateText: { prompt: Later, saveAs: later }
`);
  expect(item.aiCalls).toEqual({ min: 1, max: 2 });
  expect(item.effects[1]?.dependsOnAi).toBe(true);
});

test("unloaded attachment counts remain unknown without scheduling hydration", async () => {
  const plan = await compile(`  - if: { greaterThan: ["\${{ inputs.message.attachmentCount }}", 0] }
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`);
  const source = sourceFor(642);
  source.message.attachmentsAvailable = false;
  const item = await planMailWorkflowTryItem({
    plan,
    source,
    inputs: evaluateWorkflowTriggerInputs(JSON.parse(JSON.stringify(source)), plan.triggers[0]!.with, "2026-10-20T12:00:00.000Z"),
    targets: { labels: new Map(), problems: new Map() },
    occurredAt: "2026-10-20T12:00:00.000Z",
  });
  expect(item.facts).toEqual([{ path: "message.attachmentCount", value: null }]);
  expect(item.problems).toContainEqual({ code: "effect_not_allowed", path: ["inputs", "message", "attachmentCount"] });
  expect(item.effects[0]?.dependsOnAi).toBe(false);
});
