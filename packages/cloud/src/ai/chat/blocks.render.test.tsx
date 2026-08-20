import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiTurnBlock } from "../protocol";

const root = mkdtempSync(resolve(tmpdir(), "cloud-capability-block-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AiTurnBlockView } = await import("./blocks");
const { AiChatActionsProvider } = await import("./message-actions");
const { CloudSurveyBlock, CloudTextEditorBlock } = await import("./visual-tools");

const block = (status: "running" | "awaiting_approval" | "completed" | "failed"): AiTurnBlock => ({
  id: "tool-call-1",
  kind: "tool",
  callId: "call-1",
  name: "contacts__query__list",
  args: { limit: 10 },
  status,
  result: status === "running" || status === "awaiting_approval" ? undefined : { data: [] },
  isError: status === "failed",
  approval:
    status === "awaiting_approval"
      ? { message: "Contacts: List contacts\nReview the validated arguments below before running this Action.", allowAlways: false }
      : undefined,
  presentation: {
    kind: "capability",
    appId: "contacts",
    appName: "Contacts",
    appIcon: "ti ti-address-book",
    appAccent: "#0f766e",
    title: "List contacts",
    capabilityKind: "query",
  },
});

describe("capability tool presentation", () => {
  test("renders compact capability rows with only the capability title", () => {
    for (const status of ["running", "completed", "failed"] as const) {
      const html = renderToString(() => createComponent(AiTurnBlockView, { block: block(status), turnId: "turn-1" }));
      expect(html).toContain("List contacts");
      expect(html).not.toContain("Contacts: List contacts");
      expect(html).toContain("ti-address-book");
      expect(html).not.toContain("<small>");
      expect(html).toContain("--k2b-chat-activity-accent:#0f766e");
    }
  });

  test("renders structured tool input and responses as full-width data previews", () => {
    const completed = block("completed");
    if (completed.kind !== "tool") throw new Error("tool block missing");
    completed.args = {
      mailboxId: "5guDsC",
      read: true,
      target: { conversationId: "nTf34n", sourceFolderId: "dScSu4" },
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
      ninth: 9,
    };
    completed.result = {
      data: { conversationId: "nTf34n", commands: [{ state: "queued" }] },
      refs: [],
      links: [],
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(html.match(/class="k2b-content-structured-data w-full"/g)?.length).toBe(2);
    expect(html).toContain('data-body-inset="false"');
    expect(html).toContain('class="flex w-full min-w-0 flex-col gap-2"');
    expect(html).not.toContain("ml-6");
    expect(html).not.toContain("max-w-xl");
    expect(html).toContain('<p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">Input</p>');
    expect(html).toContain('<p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">Response</p>');
    expect(html).not.toContain("k2b-content-structured-data__title");
    expect(html).toContain("1 more row hidden");
    expect(html).toContain("View raw");
    expect(html).toContain("mailboxId");
    expect(html).toContain("commands");
  });

  test.each([
    {
      name: "web_search",
      args: { query: "Cloud platform" },
      result: [{ title: "Cloud", url: "https://cloud.example/docs" }],
      content: "cloud.example",
      bodyClass: "max-h-56 w-full min-w-0",
    },
    {
      name: "web_extract",
      args: { url: "https://cloud.example/docs" },
      result: { title: "Cloud docs", url: "https://cloud.example/docs", description: "Application platform." },
      content: "Application platform.",
      bodyClass: "flex w-full min-w-0",
    },
  ])("renders completed $name results full-width without an activity inset", ({ name, args, result, content, bodyClass }) => {
    const completed: AiTurnBlock = {
      id: `${name}-call`,
      kind: "tool",
      callId: `${name}-1`,
      name,
      args,
      status: "completed",
      result,
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(html).toContain('data-body-inset="false"');
    expect(html).toContain(bodyClass);
    expect(html).toContain(content);
    expect(html).not.toContain("max-w-xl");
  });

  test("renders persisted local Bash calls without execution controls", () => {
    const completed: AiTurnBlock = {
      id: "bash-call-1",
      kind: "tool",
      callId: "bash-1",
      name: "local_bash",
      args: { command: "git status --short" },
      status: "completed",
      result: { status: "completed", exitCode: 0, stdout: "", stderr: "", truncated: false },
      isError: false,
    };
    const pending: AiTurnBlock = { ...completed, status: "awaiting_client", result: undefined };

    const completedHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));
    const pendingHtml = renderToString(() => createComponent(AiTurnBlockView, { block: pending, turnId: "turn-1" }));

    expect(completedHtml).toContain("Local Bash");
    expect(completedHtml).toContain("ti-terminal-2");
    expect(completedHtml).toContain("git status --short");
    expect(completedHtml).not.toContain("<small>");
    expect(pendingHtml).toContain("Local Bash");
    expect(pendingHtml).toContain("ti-terminal-2");
    expect(pendingHtml).not.toContain("Approve");
    expect(pendingHtml).not.toContain("Run");
  });

  test("uses semantic built-in icons while a tool runs and after it completes", () => {
    const running: AiTurnBlock = {
      id: "project-call-1",
      kind: "tool",
      callId: "project-1",
      name: "search_project",
      args: { action: "list" },
      status: "running",
    };
    const completed: AiTurnBlock = { ...running, status: "completed", result: { ok: true, message: "Found 1 Project item." } };

    const runningHtml = renderToString(() => createComponent(AiTurnBlockView, { block: running, turnId: "turn-1" }));
    const completedHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(runningHtml).toContain("ti-folder-search");
    expect(completedHtml).toContain("ti-folder-search");
  });

  test("keeps the app identity on approval prompts", () => {
    const renderApproval = (approvalBlock: AiTurnBlock) =>
      renderToString(() =>
        createComponent(AiChatActionsProvider, {
          actions: { onApproval: async () => undefined },
          get children() {
            return createComponent(AiTurnBlockView, { block: approvalBlock, turnId: "turn-1" });
          },
        }),
      );
    const html = renderApproval(block("awaiting_approval"));
    expect(html).toContain(">Contacts · List contacts</h3>");
    expect(html).toContain("List contacts");
    expect(html).toContain('data-variant="ai"');
    expect(html).toContain('<span class="k2b-button__label">List contacts</span>');
    expect(html).not.toContain("Contacts: List contacts");
    expect(html).not.toContain("Approve Contacts: List contacts");
    expect(html).not.toContain("Review the validated arguments");
    expect(html).not.toContain("Contacts · Approval required");
    expect(html).toContain("ti-address-book");
    expect(html).toContain("--app-accent:#0f766e");
    expect(html).toContain("app-accent-scope");
    expect(html).toContain("border-[var(--k2b-border)]");
    expect(html).toContain("bg-[var(--k2b-surface)]");
    expect(html).toContain("data-ai-approval-footer");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("k2b-split-button");
    expect(html).toContain("Details");
    expect(html).toContain("ti-eye");
    expect(html).toContain("More options for List contacts");
    expect(html).not.toContain("k2b-content-structured-data");

    const rememberable = block("awaiting_approval");
    if (rememberable.kind !== "tool" || !rememberable.approval) throw new Error("approval block missing");
    rememberable.approval.allowAlways = true;
    const rememberableHtml = renderApproval(rememberable);
    expect(rememberableHtml).toContain("k2b-split-button");
    expect(rememberableHtml).toContain("Always approve");
    expect(rememberableHtml).toContain("More options for List contacts");
    expect(rememberableHtml).not.toContain("Always allow");

    const customReview = block("awaiting_approval");
    if (customReview.kind !== "tool" || !customReview.approval) throw new Error("approval block missing");
    customReview.approval.message = "The draft includes an external recipient.";
    customReview.approval.review = {
      message: "The draft includes an external recipient.",
      details: [
        { label: "Subject", value: "Release follow-up" },
        { label: "Recipients", value: "Ada", display: "inline" },
        { label: "Send on", value: "2026-08-20", format: "date" },
        { label: "Send at", value: "2026-08-20T09:00:00+02:00", format: "date-time" },
        { label: "Proposed body", value: "Hello **Ada**\n<script>alert('plain text')</script>", display: "block" },
      ],
      links: [
        { rel: "open", href: "/app/contacts" },
        { rel: "edit", href: "/app/mail/MbA123/drafts/DrG789", title: "Edit draft" },
      ],
      approvalScope: "book:default",
    };
    const customHtml = renderApproval(customReview);
    expect(customHtml).toContain("The draft includes an external recipient.");
    expect(customHtml.indexOf("The draft includes an external recipient.")).toBeLessThan(customHtml.indexOf("data-ai-approval-footer"));
    expect(customHtml).toContain('<dt class="font-semibold text-primary">Subject</dt>');
    expect(customHtml).toContain("border-t border-[var(--k2b-border)] pt-3");
    expect(customHtml).not.toContain("border-y border-[var(--k2b-border)]");
    expect(customHtml).toContain('<dd class="min-w-0 whitespace-pre-wrap break-words">Release follow-up</dd>');
    expect(customHtml).toContain('<dt class="font-semibold text-primary">Recipients</dt>');
    expect(customHtml).toContain('<time datetime="2026-08-20">');
    expect(customHtml).toContain('<time datetime="2026-08-20T09:00:00+02:00">');
    expect(customHtml).toContain('aria-label="Proposed body"');
    expect(customHtml).toContain('aria-label="Proposed body content"');
    expect(customHtml).toContain('tabindex="0"');
    expect(customHtml).toContain("Hello **Ada**");
    expect(customHtml).toContain("&lt;script>alert('plain text')&lt;/script>");
    expect(customHtml).not.toContain("<strong>Ada</strong>");
    expect(customHtml).toContain('href="/app/mail/MbA123/drafts/DrG789"');
    expect(customHtml).toContain(">Open in Contacts</span></a>");
    expect(customHtml).toContain(">Edit draft</span></a>");
    expect(customHtml.indexOf(">Open in Contacts</span></a>")).toBeGreaterThan(customHtml.indexOf("data-ai-approval-footer"));
    expect(customHtml.indexOf(">Open in Contacts</span></a>")).toBeLessThan(customHtml.indexOf(">Reject</span>"));
    expect(customHtml).toContain('data-variant="ghost"');
    expect(customHtml).not.toContain("book:default");
  });
});

describe("survey presentation", () => {
  test("uses a neutral action sheet with vertical choices and a bottom action footer", () => {
    const html = renderToString(() =>
      createComponent(CloudSurveyBlock, {
        args: {
          title: "Choose a follow-up time",
          description: "When should I remind you?",
          questions: [
            {
              id: "timing",
              type: "single",
              label: "Reminder",
              required: true,
              options: [
                { label: "Tomorrow morning", value: "tomorrow" },
                { label: "Friday afternoon", value: "friday" },
              ],
            },
            {
              id: "confidence",
              type: "rating",
              label: "Confidence",
              min: 1,
              max: 5,
            },
          ],
        },
        onSubmit: async () => undefined,
      }),
    );

    expect(html).toContain("Choose a follow-up time");
    expect(html).toContain('class="w-full min-w-0 overflow-hidden');
    expect(html).toContain('class="mt-2 grid gap-1.5"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('class="k2b-slider"');
    expect(html).toContain("var(--k2b-surface-muted)");
    expect(html).toContain("Tomorrow morning");
    expect(html).toContain("Friday afternoon");
    expect(html).toContain("border-t border-[var(--k2b-border)]");
    expect(html).toContain("k2b-button ml-auto");
    expect(html).toContain("Submit");
  });

  test("collapses an accepted active survey while retaining its answers", () => {
    const completed: AiTurnBlock = {
      id: "survey-call",
      kind: "tool",
      callId: "call-1",
      name: "survey",
      args: {
        title: "Invoice details",
        questions: [{ id: "amount", type: "text", label: "Amount" }],
      },
      status: "completed",
      frontendMode: "client_interaction",
      result: { submitted: true, answers: { amount: "150 EUR" } },
    };

    const activeHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1", active: true }));
    const historicalHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(activeHtml).toContain("Invoice details · waiting");
    expect(activeHtml).toContain('class="group w-full min-w-0 text-xs"');
    expect(activeHtml).toContain('class="mt-1 w-full min-w-0 rounded-md bg-zinc-100/70');
    expect(activeHtml).toContain("150 EUR");
    expect(activeHtml).not.toContain("Waiting for the assistant to continue");
    expect(activeHtml).not.toContain("Submit</span>");
    expect(historicalHtml).toContain("Invoice details · submitted");
  });
});

describe("text editor presentation", () => {
  test.each(["plain", "markdown"] as const)("renders %s source in the direct Markdown editor", (format) => {
    const html = renderToString(() =>
      createComponent(CloudTextEditorBlock, {
        args: {
          title: "Review mail",
          description: "Adjust this draft before I continue.",
          content: "Hello **Ada**",
          format,
          submitLabel: "Use draft",
        },
        onSubmit: async () => undefined,
      }),
    );

    expect(html).toContain("Review mail");
    expect(html).toContain('aria-label="Review mail"');
    expect(html).toContain("k2b-markdown-editor");
    expect(html).not.toContain("k2b-autocomplete");
    expect(html).not.toContain('data-fill="true"');
    expect(html).not.toContain("Adjust this draft before I continue.");
    expect(html).toContain("Suggest changes");
    expect(html).toContain("13 / 20,000");
    expect(html).toContain("Use draft");
    expect(html).toContain("20,000");
  });

  test("collapses accepted text immediately and keeps the exact source in details", () => {
    const completed: AiTurnBlock = {
      id: "text-editor-call",
      kind: "tool",
      callId: "call-2",
      name: "text_editor",
      args: { title: "Review mail", content: "Initial", format: "markdown" },
      status: "completed",
      frontendMode: "client_interaction",
      result: { submitted: true, content: "Hello **Ada**", format: "markdown" },
    };
    const activeHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1", active: true }));
    const historicalHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(activeHtml).toContain("Review mail · waiting");
    expect(activeHtml).toContain('class="group w-full min-w-0 text-xs"');
    expect(activeHtml).toContain('class="mt-1 w-full min-w-0 rounded-md bg-zinc-100/70');
    expect(activeHtml).toContain("Hello **Ada**");
    expect(activeHtml).not.toContain("<strong>Ada</strong>");
    expect(activeHtml).not.toContain("Waiting for the assistant to continue");
    expect(historicalHtml).toContain("Review mail · submitted");
  });

  test("keeps revision feedback distinct from accepted source", () => {
    const completed: AiTurnBlock = {
      id: "text-editor-feedback-call",
      kind: "tool",
      callId: "call-3",
      name: "text_editor",
      args: { title: "Review mail", content: "Initial", format: "markdown" },
      status: "completed",
      frontendMode: "client_interaction",
      result: { submitted: false, feedback: "Make the opening more direct." },
    };

    const activeHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1", active: true }));
    const historicalHtml = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(activeHtml).toContain("Review mail · revising");
    expect(activeHtml).toContain("Make the opening more direct.");
    expect(activeHtml).toContain("Feedback");
    expect(historicalHtml).toContain("Review mail · changes requested");
    expect(historicalHtml).not.toContain("Initial");
  });
});
