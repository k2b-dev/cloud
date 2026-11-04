import { describe, expect, test } from "bun:test";
import type { CloudAiSurveyInput } from "@k2b/cloud/ai";
import { CLOUD_AI_TEXT_EDITOR_MAX_CHARS } from "@k2b/cloud/ai/browser";
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
      toolCallId: "b",
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
    const full = {
      ...approval,
      review: {
        locale: "en",
        sentence: { action: "Write", running: "Writing", done: "Wrote", confirm: "Write", decline: "Keep" },
        slots: {},
        contentRef: { href: "/api/approvals/11111111-1111-4111-8111-111111111111/content", digest: "a".repeat(64) },
      },
    };
    expect(approvalOptions(full).map((option) => option.optionId)).toEqual(["cloud", "reject"]);
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
      properties: { content: { type: "string", title: "Text", default: "original", maxLength: CLOUD_AI_TEXT_EDITOR_MAX_CHARS } },
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
  test("text editor declines oversized accepted drafts without throwing", () => {
    const input = { title: "Draft", content: "original", format: "markdown" as const, submitLabel: "Continue" };
    expect(textEditorResult(input, { action: "accept", content: { content: "x".repeat(CLOUD_AI_TEXT_EDITOR_MAX_CHARS + 1) } })).toEqual({
      submitted: false,
      feedback: "The edited draft is longer than 20,000 characters, so it was not sent. Ask in the chat what to shorten.",
    });
    expect(textEditorResult(input, { action: "accept", content: { content: "x".repeat(CLOUD_AI_TEXT_EDITOR_MAX_CHARS) } })).toMatchObject({
      submitted: true,
    });
  });
  test("local questions distinguish appending from replacement", () => {
    expect(localQuestion("append").kind).toBe("edit");
    expect(localQuestion("instructions")).toEqual({ name: "Allow", kind: "other", reject: "Reject" });
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

describe("ACP tool results", () => {
  const done = (name: string, args: unknown, result: unknown) =>
    toolCall({ id: "b", kind: "tool", callId: "c", name, status: "completed", args, result }, "/work");
  const text = (call: ReturnType<typeof toolCall>) =>
    call.content?.flatMap((part) => (part.type === "content" && part.content.type === "text" ? [part.content.text] : [])).join("");

  test("a finished call shows what it returned", () => {
    expect(text(done("search_mail", {}, { hits: 2 }))).toBe('```json\n{\n  "hits": 2\n}\n```');
    expect(text(done("local_bash", {}, { stdout: "ok\n", stderr: "", exitCode: 0, status: "completed" }))).toBe(
      "```console\nok\n\n```\nExit code 0",
    );
    expect(text(done("read_file", {}, "a ``` fence"))).toBe("````\na ``` fence\n````");
    expect(done("todo_write", {}, { todos: [] }).content).toEqual([]);
  });

  test("a long result stays visible up to the bound and says it was shortened", () => {
    const call = done("read_file", {}, "x".repeat(40_000));
    expect(call).not.toHaveProperty("rawOutput");
    expect(text(call)?.length).toBeLessThanOrEqual(16_000);
    expect(text(call)).toContain("x".repeat(15_000));
    expect(text(call)).toMatch(/Shortened to the first [\d,]+ of 40,000 characters\. The Cloud chat has the full result\.$/);
  });

  test("a created file shows as a diff; a replacement or a failed write shows its result", () => {
    expect(done("local_write", { path: "new.md", mode: "create", content: "new" }, { status: "completed" }).content).toEqual([
      { type: "diff", path: "/work/new.md", oldText: null, newText: "new" },
    ]);
    expect(text(done("local_write", { path: "new.md", mode: "create", content: "new" }, { status: "failed", error: "Exists" }))).toContain(
      '"error": "Exists"',
    );
    expect(text(done("local_write", { path: "notes.md", mode: "replace", content: "after" }, { status: "completed" }))).toContain(
      '"status": "completed"',
    );
  });

  test("escapes and fences never push a result past the bound", () => {
    for (const result of ["`".repeat(40_000), "\t".repeat(40_000), "\u0007".repeat(40_000)]) {
      const shown = text(done("read_file", {}, result)) ?? "";
      expect(shown.length).toBeLessThanOrEqual(16_000);
      expect(shown).toEndWith("The Cloud chat has the full result.");
    }
  });
});
