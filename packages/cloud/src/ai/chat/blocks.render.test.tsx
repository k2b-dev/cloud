import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Accessor, createComponent, createRoot, createSignal } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiActiveTurn } from "../client/projection";
import type { AiTurnBlock } from "../protocol";
import type { AiAssistantTimelineItem } from "../timeline";
import type { AiStoredMessage } from "../types";

const root = mkdtempSync(resolve(tmpdir(), "cloud-capability-block-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AiTurnBlockList, AiTurnBlockView } = await import("./blocks");
const { AiChatActionsProvider } = await import("./message-actions");
const { AiAssistantContent, createAiChatTimeline, partitionCompletedAssistantBlocks } = await import("./presentation");
const { createAiToolDisclosureState } = await import("./tool-disclosure");
const { CloudSurveyBlock, CloudTextEditorBlock } = await import("./visual-tools");

const hasOpenDetails = (html: string): boolean => /<details\b[^>]*\sopen(?:=""|(?=[\s>]))/.test(html);
const hasOpenDetailsContaining = (html: string, text: string): boolean => {
  const textIndex = html.indexOf(text);
  const detailsIndex = html.lastIndexOf("<details", textIndex);
  const tagEnd = html.indexOf(">", detailsIndex);
  return detailsIndex >= 0 && tagEnd > detailsIndex && /\sopen(?:=""|(?=[\s>]))/.test(html.slice(detailsIndex, tagEnd + 1));
};

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
    expect(hasOpenDetails(html)).toBe(true);
  });

  test("renders internal discovery results as readable tool lists instead of JSON", () => {
    const completed: AiTurnBlock = {
      id: "search-tools-call",
      kind: "tool",
      callId: "search-tools-1",
      name: "search_tools",
      args: { query: "tag mail" },
      status: "completed",
      result: {
        tools: [
          {
            name: "mail__action__conversation_dot_tag_dot_change",
            title: "Change conversation tags",
            description: "Add or remove mailbox tags.",
            kind: "action",
            appId: "mail",
          },
        ],
      },
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(html).toContain("Search tools: tag mail");
    expect(html).toContain("Change conversation tags");
    expect(html).toContain("Add or remove mailbox tags.");
    expect(html).toContain(">mail</span>");
    expect(html).toContain(">·</span>");
    expect(html).toContain("min-w-0 flex-1 truncate text-dimmed");
    expect(html).not.toContain("bg-zinc-100/70");
    expect(html).not.toContain(">Input</p>");
    expect(html).not.toContain(">Response</p>");
    expect(html).not.toContain("k2b-content-structured-data");
    expect(hasOpenDetails(html)).toBe(false);
  });

  test("uses provider-authored capability summaries and semantic links", () => {
    const completed = block("completed");
    if (completed.kind !== "tool") throw new Error("tool block missing");
    completed.result = {
      data: { conversationId: "nTf34n", tags: ["#foo"] },
      summary: "Tagged mail with #foo",
      refs: [{ type: "mail.conversation", id: "nTf34n" }],
      links: [{ rel: "open", href: "/app/mail/5guDsC?conversation=nTf34n" }],
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(html).toContain("Tagged mail with #foo");
    expect(html).not.toContain(">List contacts</strong>");
    expect(html).not.toContain("mail.conversation:nTf34n");
    expect(html).toContain('href="/app/mail/5guDsC?conversation=nTf34n"');
    expect(html).toMatch(/class="k2b-button ai-chat-result-link\s*"/);
    expect(html).not.toContain(">Input</p>");
    expect(html).not.toContain(">Response</p>");
    expect(html).not.toContain("k2b-content-structured-data");
    expect(hasOpenDetails(html)).toBe(false);
  });

  test("keeps capability failures and validation details immediately visible", () => {
    const failed = block("failed");
    if (failed.kind !== "tool") throw new Error("tool block missing");
    failed.result = "VALIDATION_FAILED: Capability input did not match the registered schema Input issues: mailboxId: Must be a stable ID";

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: failed, turnId: "turn-1" }));

    expect(html).toContain("List contacts failed");
    expect(html).toContain("mailboxId: Must be a stable ID");
    expect(html).toContain('data-tone="danger"');
    expect(hasOpenDetails(html)).toBe(true);
  });

  test("does not turn malformed historical capability links into navigation", () => {
    const completed = block("completed");
    if (completed.kind !== "tool") throw new Error("tool block missing");
    completed.result = {
      data: { conversationId: "nTf34n" },
      summary: "Loaded conversation",
      links: [{ rel: "open", href: "//example.test/escape", title: "Open" }],
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" }));

    expect(html).toContain("Loaded conversation");
    expect(html).not.toContain("example.test");
  });

  test.each([
    ["list_apps", {}, { apps: { contacts: "People and address books" } }, "People and address books"],
    [
      "load_tools",
      { names: ["mail__query__activity_dot_list"] },
      {
        loaded: ["mail__query__activity_dot_list"],
        alreadyLoaded: [],
        missing: [],
        evicted: [],
        titles: { mail__query__activity_dot_list: "List mail activity" },
      },
      "List mail activity",
    ],
    [
      "search_help",
      { query: "mail tags" },
      { documents: [{ appId: "mail", appName: "Mail", documentId: "tags", title: "Organize with tags" }] },
      "Organize with tags",
    ],
    [
      "read_help",
      { appId: "mail", documentId: "tags" },
      { document: { appId: "mail", appName: "Mail", documentId: "tags", title: "Organize with tags", markdown: "# Tags" } },
      "Read help: Organize with tags",
    ],
    [
      "search_project",
      { query: "invoice" },
      { items: [{ kind: "knowledge", id: "abc123", title: "Invoice policy" }], truncated: false },
      "Invoice policy",
    ],
    [
      "read_project_knowledge",
      { id: "abc123" },
      { title: "Invoice policy", content: "Policy text" },
      "Read Project knowledge: Invoice policy",
    ],
    [
      "list_files",
      { path: "/" },
      { files: [{ path: "/report.pdf", size: 2048, mediaType: "application/pdf", origin: "assistant" }], truncated: false },
      "report.pdf",
    ],
    [
      "read_file",
      { path: "/notes.md", offset: 0, length: 100 },
      {
        path: "/notes.md",
        mediaType: "text/markdown",
        representation: "text",
        content: "hidden",
        offset: 0,
        nextOffset: 42,
        eof: true,
        truncated: false,
      },
      "bytes 0–42 · complete",
    ],
    [
      "write_file",
      { path: "/notes.md", content: "hidden" },
      { path: "/notes.md", size: 42, mediaType: "text/markdown" },
      "Wrote file: notes.md",
    ],
    ["calculate", { kind: "math", expression: "21 * 2" }, { result: "42" }, "21 * 2"],
    [
      "view_image",
      { path: "/chart.png" },
      { path: "/chart.png", mediaType: "image/png", description: "A rising line chart." },
      "A rising line chart.",
    ],
    [
      "markdown_to_pdf",
      { path: "/report.md" },
      { sourcePath: "/report.md", path: "/report.pdf", size: 4096, mediaType: "application/pdf" },
      "Created PDF: report.pdf",
    ],
    [
      "read_cloud_resource",
      { type: "contacts.contact", id: "abc123" },
      { data: { id: "abc123" }, summary: "Loaded contact Ada" },
      "Loaded contact Ada",
    ],
  ] as const)("renders %s with its readable built-in presentation", (name, args, result, expected) => {
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

    expect(html).toContain(expected);
    expect(html).not.toContain(">Input</p>");
    expect(html).not.toContain(">Response</p>");
    expect(html).not.toContain("k2b-content-structured-data");
    expect(hasOpenDetails(html)).toBe(name === "view_image");
    if (name === "load_tools") expect(html).not.toContain("mail__query__activity_dot_list");
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
    expect(hasOpenDetails(completedHtml)).toBe(false);
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

  test("keeps Present busy until a completed result is available", () => {
    const running: AiTurnBlock = {
      id: "present-call",
      kind: "tool",
      callId: "present-1",
      name: "present",
      args: { path: "/report.pdf", title: "Quarterly report" },
      status: "running",
    };

    const html = renderToString(() => createComponent(AiTurnBlockView, { block: running, turnId: "turn-1" }));

    expect(html).toContain("Preparing file");
    expect(html).toContain('data-busy="true"');
    expect(html).not.toContain("Quarterly report");
    expect(html).not.toContain("Download");
  });

  test("shows one presented-file label and underlines only the Download text on hover", () => {
    const completed: AiTurnBlock = {
      id: "present-call",
      kind: "tool",
      callId: "present-1",
      name: "present",
      args: { path: "/testdatei.md", title: "Testdatei.md" },
      status: "completed",
      result: { path: "/testdatei.md", size: 120, mediaType: "text/markdown" },
    };

    const html = renderToString(() =>
      createComponent(AiChatActionsProvider, {
        actions: { onOpenFile: () => undefined, fileUrl: () => "/download/testdatei.md" },
        get children() {
          return createComponent(AiTurnBlockView, { block: completed, turnId: "turn-1" });
        },
      }),
    );

    expect(html.match(/Testdatei\.md/g)).toHaveLength(1);
    expect(html).toContain('download="testdatei.md"');
    expect(html).toContain('<span class="underline-offset-2 group-hover:underline">Download</span>');
    expect(html).not.toMatch(/<a[^>]*hover:underline/);
  });

  test("collapses intermediate text and tools after completion while keeping rich results and the final text visible", () => {
    const blocks: AiTurnBlock[] = [
      { id: "text-before", kind: "text", text: "Before tool" },
      {
        id: "tool-middle",
        kind: "tool",
        callId: "tool-1",
        name: "unknown_tool",
        status: "completed",
        result: { ok: true },
      },
      {
        id: "card-middle",
        kind: "tool",
        callId: "card-1",
        name: "card",
        args: { title: "Useful card", value: "42" },
        status: "completed",
        result: { ok: true },
      },
      {
        id: "present-middle",
        kind: "tool",
        callId: "present-1",
        name: "present",
        args: { path: "/report.pdf", title: "Useful report" },
        status: "completed",
        result: { path: "/report.pdf", size: 12, mediaType: "application/pdf" },
      },
      { id: "text-after", kind: "text", text: "After tool" },
    ];
    const item: AiAssistantTimelineItem = {
      type: "assistant",
      id: "stored-1",
      loopId: "turn-1",
      entries: [],
      blocks,
      actionEntry: null,
      workedMs: 1_000,
    };
    const partitioned = partitionCompletedAssistantBlocks(blocks);
    expect(partitioned.worked.map((candidate) => candidate.id)).toEqual(["text-before", "tool-middle"]);
    expect(partitioned.visible.map((candidate) => candidate.id)).toEqual(["card-middle", "present-middle", "text-after"]);

    const storedHtml = renderToString(() => createComponent(AiAssistantContent, { item }));
    const liveHtml = renderToString(() => createComponent(AiTurnBlockList, { blocks, turnId: "turn-1" }));

    expect(storedHtml).toContain("Worked for 1s");
    expect(hasOpenDetails(storedHtml)).toBe(false);
    expect(storedHtml.indexOf("Worked for 1s")).toBeLessThan(storedHtml.indexOf("Before tool"));
    expect(storedHtml.indexOf("Before tool")).toBeLessThan(storedHtml.indexOf("Unknown tool"));
    expect(storedHtml.indexOf("Unknown tool")).toBeLessThan(storedHtml.indexOf("Useful card"));
    expect(storedHtml.indexOf("Useful card")).toBeLessThan(storedHtml.indexOf("Useful report"));
    expect(storedHtml.indexOf("Useful report")).toBeLessThan(storedHtml.indexOf("After tool"));
    expect(storedHtml).not.toContain("unknown_tool");

    expect(liveHtml.indexOf("Before tool")).toBeLessThan(liveHtml.indexOf("Unknown tool"));
    expect(liveHtml.indexOf("Unknown tool")).toBeLessThan(liveHtml.indexOf("Useful card"));
    expect(liveHtml.indexOf("Useful card")).toBeLessThan(liveHtml.indexOf("Useful report"));
    expect(liveHtml.indexOf("Useful report")).toBeLessThan(liveHtml.indexOf("After tool"));
    expect(liveHtml).not.toContain("Worked for");
  });

  test("opens failed completed work immediately and preserves an explicit Worked disclosure choice", () => {
    const item: AiAssistantTimelineItem = {
      type: "assistant",
      id: "stored-failure",
      loopId: "turn-failure",
      entries: [],
      blocks: [
        {
          id: "failed-tool",
          kind: "tool",
          callId: "failed-1",
          name: "unknown_tool",
          status: "failed",
          result: { code: "VALIDATION_FAILED", message: "Mailbox is required" },
          isError: true,
        },
        { id: "final-text", kind: "text", text: "I could not finish that." },
      ],
      actionEntry: null,
      workedMs: 2_000,
    };

    const failedHtml = renderToString(() => createComponent(AiAssistantContent, { item }));
    expect(hasOpenDetailsContaining(failedHtml, "Worked for 2s")).toBe(true);
    expect(failedHtml).toContain('data-tone="danger"');
    expect(failedHtml).toContain("Mailbox is required");

    const disclosureState = createAiToolDisclosureState();
    disclosureState.set("worked:turn-failure", false);
    const collapsedHtml = renderToString(() => createComponent(AiAssistantContent, { item: { ...item }, disclosureState }));
    expect(hasOpenDetailsContaining(collapsedHtml, "Worked for 2s")).toBe(false);
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

describe("live tool disclosure stability", () => {
  test("keeps a user disclosure override across a remounted loop block", () => {
    const disclosureState = createAiToolDisclosureState();
    const completed: AiTurnBlock = {
      id: "tool-stable",
      kind: "tool",
      callId: "call-stable",
      name: "unknown_tool",
      status: "completed",
      result: { step: 1 },
    };

    const initialHtml = renderToString(() =>
      createComponent(AiTurnBlockList, { blocks: [completed], turnId: "turn-stable", disclosureState }),
    );
    expect(hasOpenDetails(initialHtml)).toBe(false);

    disclosureState.set(completed.id, true);
    const nextHtml = renderToString(() =>
      createComponent(AiTurnBlockList, {
        blocks: [{ ...completed, result: { step: 2 } }],
        turnId: "turn-stable",
        disclosureState,
      }),
    );
    expect(hasOpenDetails(nextHtml)).toBe(true);
  });

  test("does not recreate stored timeline items for active-turn updates", () => {
    const storedMessage: AiStoredMessage = {
      id: "message-1",
      shortId: "msg1",
      conversationId: "conversation-1",
      seq: 1,
      kind: "message",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      loopId: null,
      modelProfileId: null,
      providerModel: null,
      usage: null,
      stopReason: null,
      loopAggregate: null,
      loopDoneReason: null,
      compactedAt: null,
      meta: null,
      createdAt: "2026-08-20T12:00:00.000Z",
    };
    const activeTurn: AiActiveTurn = {
      turnId: "turn-1",
      attempt: 1,
      seq: 2,
      status: "running",
      blocks: [{ id: "text-1", kind: "text", text: "Working" }],
      modelProfileId: null,
    };

    createRoot((dispose) => {
      const [messages] = createSignal<readonly AiStoredMessage[]>([storedMessage]);
      const [active, setActive] = createSignal<AiActiveTurn | null>(activeTurn);
      let timeline: Accessor<readonly import("@k2b/ui").ChatTimelineItem[]> | undefined;
      createComponent(AiChatActionsProvider, {
        actions: {},
        get children() {
          timeline = createAiChatTimeline({ messages, activeTurn: active });
          return undefined;
        },
      });

      const storedBefore = timeline?.()[0];
      setActive({ ...activeTurn, seq: 3, blocks: [...activeTurn.blocks, { id: "text-2", kind: "text", text: "More" }] });
      expect(timeline?.()[0]).toBe(storedBefore);
      dispose();
    });
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
