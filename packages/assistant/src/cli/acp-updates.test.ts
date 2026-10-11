import { describe, expect, test } from "bun:test";
import type { CloudAiSurveyInput } from "@k2b/cloud/ai";
import {
  type ApprovalAction,
  approvalOptions,
  approvalReviewText,
  boundedRaw,
  localQuestion,
  markdownTable,
  planEntries,
  surveyForm,
  surveyResult,
  textEditorForm,
  textEditorResult,
  toolCall,
  toolKind,
} from "./acp-updates";

const approval: ApprovalAction = {
  type: "approval_request",
  conversationId: "chat",
  turnId: "turn",
  callId: "call",
  name: "mail.send",
  args: { to: "person" },
  allowChat: true,
  allowAlways: true,
};
const survey: CloudAiSurveyInput = {
  title: "Choices",
  description: "Pick",
  submitLabel: "Submit",
  questions: [
    { id: "text", type: "text", label: "Text", placeholder: "Write", required: true },
    { id: "rating", type: "rating", label: "Rating", min: 1, max: 5, required: false },
    {
      id: "single",
      type: "single",
      label: "Single",
      required: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    {
      id: "multi",
      type: "multiple",
      label: "Multiple",
      required: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
};

describe("ACP mappings", () => {
  test("tool kinds follow operations without treating capability deletes as edits", () => {
    for (const [kind, names] of Object.entries({
      read: ["local_read", "read_file", "view_image", "load_skill", "load_local_skill"],
      search: ["local_list", "web_search", "search_mail"],
      fetch: ["web_extract", "fetch_file"],
      edit: ["local_write", "local_download", "write_file"],
      move: ["local_move"],
      execute: ["local_bash", "code_run"],
      think: ["todo_write"],
      other: ["mail.delete", "other"],
    }))
      for (const name of names) expect(String(toolKind(name))).toBe(kind);
  });
  test("tool title, state, raw values and absolute locations", () => {
    const mapped = toolCall(
      {
        id: "b",
        kind: "tool",
        name: "local_move",
        callId: "c",
        status: "awaiting_client",
        args: { path: "x", to: "y", paths: ["z"], moves: [{ from: "a", to: "b" }] },
      },
      "/work",
    );
    expect(mapped).toMatchObject({
      title: "local_move 1 move",
      status: "pending",
      kind: "move",
      locations: [{ path: "/work/x" }, { path: "/work/y" }, { path: "/work/z" }, { path: "/work/a" }, { path: "/work/b" }],
    });
    expect(
      toolCall(
        {
          id: "b",
          kind: "tool",
          name: "mail.delete",
          callId: "c",
          status: "failed",
          result: { error: "Denied" },
          presentation: {
            kind: "capability",
            appId: "mail",
            appName: "Mail",
            appIcon: "mail",
            title: "Delete mail",
            capabilityKind: "action",
          },
        },
        "/work",
      ),
    ).toMatchObject({
      title: "Delete mail",
      status: "failed",
      kind: "other",
      content: [{ type: "content", content: { type: "text", text: "Denied" } }],
    });
    expect(
      toolCall(
        {
          id: "b",
          kind: "tool",
          name: "local_write",
          callId: "c",
          status: "completed",
          args: { path: "notes.md", mode: "append" },
          result: { status: "completed" },
        },
        "/work",
      ),
    ).toMatchObject({ title: "local_write notes.md (append)", status: "completed", rawOutput: { status: "completed" } });
  });
  test("raw JSON bound is inclusive and omitted from updates when exceeded", () => {
    expect(boundedRaw("x".repeat(15998))).toBeDefined();
    expect(boundedRaw("x".repeat(15999))).toBeUndefined();
    const mapped = toolCall(
      { id: "b", kind: "tool", callId: "c", name: "read_file", status: "completed", args: "x".repeat(16000), result: "x".repeat(16000) },
      "/work",
    );
    expect(mapped).not.toHaveProperty("rawInput");
    expect(mapped).not.toHaveProperty("rawOutput");
  });
  test("plan leaves out cancelled items", () => {
    expect(
      planEntries({
        todos: [
          { id: "a", content: "Do", status: "in_progress" },
          { id: "b", content: "Done", status: "completed" },
          { id: "c", content: "Later", status: "pending" },
          { id: "d", content: "Skip", status: "cancelled" },
        ],
      }),
    ).toEqual([
      { content: "Do", priority: "medium", status: "in_progress" },
      { content: "Done", priority: "medium", status: "completed" },
      { content: "Later", priority: "medium", status: "pending" },
    ]);
    expect(planEntries({ broken: true })).toBeUndefined();
  });
  test("Cloud permission choices never include everywhere approval", () => {
    expect(approvalOptions(approval).map((o) => o.optionId)).toEqual(["once", "chat", "reject"]);
    expect(approvalOptions({ ...approval, allowChat: false }).map((o) => o.optionId)).toEqual(["once", "reject"]);
    expect(approvalOptions({ ...approval, website: "https://example.test" }).map((o) => o.optionId)).toEqual(["once", "reject"]);
    expect(approvalOptions({ ...approval, allowChat: false, allowAlways: false })).toEqual([
      { optionId: "cloud", name: "Confirm in Cloud", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
  });
  test("review is safe plain text with details and the web link", () => {
    expect(
      approvalReviewText(
        { ...approval, message: "Fallback", review: { message: "Send?\u001b[31m", details: [{ label: "To", value: "Someone\u0007" }] } },
        "https://cloud.test/chat",
      ),
    ).toBe("Send?\\u001b[31m\nTo: Someone\\u0007\nOpen in Cloud: https://cloud.test/chat");
    expect(approvalReviewText(approval, "link")).toBe("mail.send\nOpen in Cloud: link");
  });
  test("survey fields map to form types and valid answers only", () => {
    expect(surveyForm(survey)).toMatchObject({
      required: ["text"],
      properties: {
        text: { type: "string", title: "Text", description: "Write" },
        rating: { type: "integer", minimum: 1, maximum: 5 },
        single: {
          oneOf: [
            { const: "a", title: "A" },
            { const: "b", title: "B" },
          ],
        },
        multi: {
          type: "array",
          items: {
            anyOf: [
              { const: "a", title: "A" },
              { const: "b", title: "B" },
            ],
          },
        },
      },
    });
    expect(
      surveyResult(survey, { action: "accept", content: { text: "yes", rating: 3, single: "a", multi: ["a", "b"], extra: "ignore" } }),
    ).toEqual({ submitted: true, answers: { text: "yes", rating: 3, single: "a", multi: ["a", "b"] } });
    expect(surveyResult(survey, { action: "accept", content: { text: 42, rating: 6, single: "bad", multi: ["a", "bad"] } })).toEqual({
      submitted: true,
      answers: {},
    });
    for (const response of [undefined, { action: "decline" }, { action: "cancel" }])
      expect(surveyResult(survey, response)).toEqual({ submitted: false, answers: {} });
  });
  test("text editor keeps the input format and explains declines", () => {
    const input = { title: "Draft", content: "original", format: "markdown" as const, submitLabel: "Continue" };
    expect(textEditorForm(input)).toEqual({
      type: "object",
      required: ["content"],
      properties: { content: { type: "string", title: "Text", default: "original" } },
    });
    expect(textEditorResult(input, { action: "accept", content: { content: "edited" } })).toEqual({
      submitted: true,
      content: "edited",
      format: "markdown",
    });
    expect(textEditorResult(input, { action: "decline" })).toEqual({
      submitted: false,
      feedback: "The user rejected the draft. Ask in the chat what to change.",
    });
    expect(textEditorResult(input)).toEqual({
      submitted: false,
      feedback: "This client cannot show drafts. Put the draft in your reply and ask the user there.",
    });
  });
  test("local questions distinguish appending from replacement", () => {
    expect(localQuestion("append").kind).toBe("edit");
    expect(localQuestion("replace").kind).toBe("other");
    expect(localQuestion("bash").kind).toBe("execute");
  });
  test("Markdown tables escape pipes and newlines", () => {
    expect(
      markdownTable(
        [{ a: "A|B\r\nC", b: 2 }],
        [
          { key: "a", label: "Name|value" },
          { key: "b", value: (row) => row.b + 1 },
        ],
      ),
    ).toBe("| Name\\|value | b |\n| --- | --- |\n| A\\|B<br>C | 3 |\n");
  });
});
