import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import type { MailAutomationStep } from "../contracts";
import { bindMailWorkflow } from "../workflows/binder";
import { buildMailWorkflowCatalog } from "../workflows/catalog";
import { mailWorkflows } from "../workflows/module";
import { buildIncomingAutomationWorkflowSource, incomingAutomationBudget, incomingAutomationHasAi } from "./incoming-automation-definition";

const classifyId = "00000000-0000-4000-8000-000000000001";
describe("incoming automation workflow compiler", () => {
  test("compiles normal output references and conditions deterministically", async () => {
    const textId = "00000000-0000-4000-8000-000000000017";
    const steps: MailAutomationStep[] = [
      {
        id: "00000000-0000-4000-8000-000000000010",
        kind: "mail_action",
        action: { kind: "add_local_tag", tagId: "00000000-0000-4000-8000-000000000014" },
      },
      {
        id: classifyId,
        kind: "ai_classify",
        instructions: "Choose the best category",
        choices: [
          { name: "Important", description: "Needs attention" },
          { name: "Routine", description: "Routine mail" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        kind: "if",
        condition: { sourceStepId: classifyId, operator: "equals", value: "Important" },
        then: [
          { id: "00000000-0000-4000-8000-000000000012", kind: "mail_action", action: { kind: "set_status", status: "needs_action" } },
          { id: textId, kind: "ai_generate_text", instructions: "Draft a concise reply", maxOutputChars: 2_000 },
          {
            id: "00000000-0000-4000-8000-000000000018",
            kind: "create_reply_draft",
            body: { kind: "step_output", sourceStepId: textId },
            senderIdentityId: "00000000-0000-4000-8000-000000000019",
          },
          { id: "00000000-0000-4000-8000-000000000020", kind: "add_comment", body: { kind: "step_output", sourceStepId: textId } },
          { id: "00000000-0000-4000-8000-000000000021", kind: "set_summary", body: { kind: "step_output", sourceStepId: textId } },
        ],
        else: [{ id: "00000000-0000-4000-8000-000000000013", kind: "mail_action", action: { kind: "add_keyword", keyword: "routine" } }],
      },
    ];
    const input = { scope: { mode: "all" as const }, steps };
    const source = buildIncomingAutomationWorkflowSource(input);
    expect(source).toBe(buildIncomingAutomationWorkflowSource(input));
    expect(source).toContain("aiClassify:");
    expect(source).toContain("equals:\n");
    expect(source).toContain("setConversationStatus:");
    expect(source).toContain("addKeyword:");
    expect(source).toContain("createReplyDraft:");
    expect(source).toContain("addComment:");
    expect(source).toContain("setConversationSummary:");
    expect(source).toContain("existingSummary: ${{ inputs.conversation.summary }}");
    expect(source).toContain("{{ step_00000000000040008000000000000017 }}");
    expect(source).toContain("format: plain");
    expect(incomingAutomationHasAi(steps)).toBe(true);
    expect(incomingAutomationBudget(steps)).toMatchObject({ maxTargets: 4, maxDrafts: 1, maxCollaborationChanges: 4, maxAiCalls: 2 });
    expect((await compileWorkflow(source, mailWorkflows)).ok).toBe(true);
  });

  test("compiles match conditions and multiple consumers of one text output", async () => {
    const textId = "00000000-0000-4000-8000-000000000020";
    const source = buildIncomingAutomationWorkflowSource({
      scope: {
        mode: "matching",
        conditions: { mode: "all", items: [{ field: "sender_domain", operator: "is", value: "example.com" }] },
      },
      steps: [
        { id: textId, kind: "ai_generate_text", instructions: "Summarize this message", maxOutputChars: 2_000 },
        {
          id: "00000000-0000-4000-8000-000000000021",
          kind: "create_reply_draft",
          body: { kind: "step_output", sourceStepId: textId },
          senderIdentityId: "00000000-0000-4000-8000-000000000022",
        },
        { id: "00000000-0000-4000-8000-000000000023", kind: "add_comment", body: { kind: "step_output", sourceStepId: textId } },
        { id: "00000000-0000-4000-8000-000000000027", kind: "set_summary", body: { kind: "step_output", sourceStepId: textId } },
      ],
    });
    expect(source).toContain("inputs.message.fromDomain");
    expect(source).toContain("aiGenerateText:");
    expect(source).toContain("createReplyDraft:");
    expect(source).toContain("addComment:");
    expect(source).toContain("setConversationSummary:");
    expect(source.match(/{{ step_00000000000040008000000000000020 }}/g)).toHaveLength(3);
    expect((await compileWorkflow(source, mailWorkflows)).ok).toBe(true);
  });

  test("compiles custom reply and comment text without AI", async () => {
    const source = buildIncomingAutomationWorkflowSource({
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000024",
          kind: "create_reply_draft",
          body: { kind: "custom", value: "Thanks for your message." },
          senderIdentityId: "00000000-0000-4000-8000-000000000025",
        },
        {
          id: "00000000-0000-4000-8000-000000000026",
          kind: "add_comment",
          body: { kind: "custom", value: "Review in the next support shift." },
        },
        {
          id: "00000000-0000-4000-8000-000000000027",
          kind: "set_summary",
          body: { kind: "custom", value: "Waiting for support review." },
        },
      ],
    });
    expect(source).toContain("body: Thanks for your message.");
    expect(source).toContain("body: Review in the next support shift.");
    expect(source).toContain("summary: Waiting for support review.");
    expect(source).toContain("format: markdown");
    expect(source).not.toContain("aiGenerateText:");
    const compiled = await compileWorkflow(source, mailWorkflows);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bound = await bindMailWorkflow(
      compiled.ir,
      buildMailWorkflowCatalog({
        folders: [],
        assignableUsers: [],
        senderIdentities: [{ id: "00000000-0000-4000-8000-000000000025", name: "Support" }],
        localTags: [],
      }),
    );
    expect(bound.ok).toBe(true);
  });

  test("compiles strict event extraction into retry-safe Spaces creation", async () => {
    const extractId = "00000000-0000-4000-8000-000000000040";
    const steps: MailAutomationStep[] = [
      {
        id: extractId,
        kind: "ai_extract_event",
        instructions: "Use only explicit event details.",
        timeZone: "Europe/Berlin",
      },
      {
        id: "00000000-0000-4000-8000-000000000041",
        kind: "create_space_event",
        spaceId: "Space1",
        columnId: "Col001",
        event: { kind: "step_output", sourceStepId: extractId },
      },
      { id: "00000000-0000-4000-8000-000000000042", kind: "link_space_item", itemId: "Item01" },
    ];
    const source = buildIncomingAutomationWorkflowSource({ scope: { mode: "all" }, steps });
    expect(source).toContain("aiExtractData:");
    expect(source).toContain("Europe/Berlin");
    expect(source).toContain("createSpaceEvent:");
    expect(source).toContain("event: ${{ step_00000000000040008000000000000040 }}");
    expect(source).toContain("linkSpaceItem:");
    expect(incomingAutomationBudget(steps)).toMatchObject({ maxAiCalls: 1, maxCollaborationChanges: 2 });
    expect(await compileWorkflow(source, mailWorkflows)).toMatchObject({ ok: true });
  });

  test("compiles multi-classification as ordinary sequential conditions", async () => {
    const source = buildIncomingAutomationWorkflowSource({
      scope: { mode: "all" },
      steps: [
        {
          id: classifyId,
          kind: "ai_classify_many",
          instructions: "Choose matching categories",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine mail" },
          ],
          maxChoices: 2,
        },
        {
          id: "00000000-0000-4000-8000-000000000030",
          kind: "if",
          condition: { sourceStepId: classifyId, operator: "includes", value: "Important" },
          then: [
            { id: "00000000-0000-4000-8000-000000000031", kind: "mail_action", action: { kind: "set_status", status: "needs_action" } },
          ],
          else: [],
        },
        {
          id: "00000000-0000-4000-8000-000000000032",
          kind: "if",
          condition: { sourceStepId: classifyId, operator: "includes", value: "Routine" },
          then: [
            {
              id: "00000000-0000-4000-8000-000000000033",
              kind: "mail_action",
              action: { kind: "add_local_tag", tagId: "00000000-0000-4000-8000-000000000034" },
            },
          ],
          else: [],
        },
      ],
    });
    expect(source).toContain("aiClassifyMany:");
    expect(source.match(/includes:/g)).toHaveLength(2);
    expect((await compileWorkflow(source, mailWorkflows)).ok).toBe(true);
  });

  test("binds provider mutations in mutually exclusive if branches", async () => {
    const source = buildIncomingAutomationWorkflowSource({
      scope: { mode: "all" },
      steps: [
        {
          id: classifyId,
          kind: "ai_classify",
          instructions: "Choose one category",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine mail" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000040",
          kind: "if",
          condition: { sourceStepId: classifyId, operator: "equals", value: "Important" },
          then: [{ id: "00000000-0000-4000-8000-000000000041", kind: "mail_action", action: { kind: "junk" } }],
          else: [{ id: "00000000-0000-4000-8000-000000000042", kind: "mail_action", action: { kind: "trash" } }],
        },
      ],
    });
    const compiled = await compileWorkflow(source, mailWorkflows);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bound = await bindMailWorkflow(
      compiled.ir,
      buildMailWorkflowCatalog({
        folders: [
          { id: "00000000-0000-4000-8000-000000000043", name: "Junk", role: "junk" },
          { id: "00000000-0000-4000-8000-000000000044", name: "Trash", role: "trash" },
        ],
        assignableUsers: [],
        senderIdentities: [],
        localTags: [],
      }),
    );
    expect(bound.ok).toBe(true);
  });
});
