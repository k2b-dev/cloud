import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent, createSignal } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-sidebar-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { default: AssistantSidebar } = await import("./AssistantSidebar");
const { default: AssistantAllChatsList } = await import("./AssistantAllChatsList");
const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });

const project = {
  id: "project123",
  shortId: "project123",
  name: "Support",
  description: "",
  icon: "ti ti-folders",
  instructions: "",
  defaultModelProfileId: null,
  permission: "admin",
  revision: 1,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
} satisfies AiProject;

const conversation = (id: string, title: string, projectId: string | null): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-09-14T00:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
});

describe("Assistant sidebar", () => {
  test("shows compact progress for an unopened running chat", () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        conversations: () => [
          {
            ...conversation("working", "Import", null),
            runStatus: "running",
            activity: { completed: 1, total: 3, step: "Check totals", tool: "Read file" },
          },
        ],
        activeConversationId: () => null,
        live,
      }),
    );
    expect(html).toContain("Check totals");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="33"');
  });

  test("selects only the visible project or Studio despite a retained chat", () => {
    for (const activeView of ["chat", "apps"] as const) {
      const html = renderToString(() =>
        createComponent(AssistantSidebar, {
          conversations: () => [conversation("retained", "Retained chat", null)],
          projects: [project],
          activeConversationId: () => "retained",
          activeProjectId: project.id,
          activeView,
          live,
        }),
      );
      const selectedRows = html.match(/<(?:a|button|div)\b[^>]*class="[^"]*\bis-active\b[^"]*"[^>]*>/g) ?? [];
      expect(selectedRows.length).toBeGreaterThan(0);
      const selectedTitle = activeView === "apps" ? "Studio" : "Projects";
      expect(selectedRows.some((row) => row.includes(`title="${selectedTitle}"`))).toBe(true);
      expect(selectedRows.some((row) => row.includes("conversation=retained"))).toBe(false);
    }
  });

  test("puts projects in footer previews and lists pinned chats first without section headings", () => {
    const [conversations] = createSignal([
      { ...conversation("chatpinned", "Pinned chat", null), pinnedAt: "2026-08-12T10:00:00.000Z" },
      { ...conversation("chatprojectpinned", "Pinned project chat", project.id), pinnedAt: "2026-08-12T09:00:00.000Z" },
      conversation("chatproject", "Project chat", project.id),
      ...Array.from({ length: 17 }, (_, index) => conversation(`chat${index + 1}`, `General chat ${index + 1}`, null)),
    ]);
    const html = renderToString(() => createComponent(AssistantSidebar, { conversations, projects: [project], live }));

    expect(html).not.toContain('aria-expanded="true"');
    expect(html).toContain("Project chat");
    expect(html).not.toContain(">Pinned</");
    expect(html).toContain("Pinned chat");
    expect(html).not.toContain('title="Pinned chat"');
    expect(html).not.toContain('title="Pinned project chat"');
    expect(html).toContain("Chat settings");
    expect(html).toContain("Mark chat done");
    expect(html).toContain("assistant-chat-sidebar-item--done-action");
    expect(html).toContain('role="status">Done</span>');
    expect(html).not.toContain(">Chats</");
    expect(html).toContain("General chat 15");
    expect(html).toContain("General chat 17");
    expect(html).not.toContain(">See all<");
    expect(html).toContain("All chats");
    expect(html).not.toContain("Today");
    expect(html).not.toContain("This Week");
    expect(html).not.toContain("This Month");
    expect(html).toContain('data-variant="card"');
    expect(html).toContain('data-marquee="false"');
  });

  test("separates Done from pinned and Project chats and offers reopening", () => {
    const done = { ...conversation("finished", "Completed work", project.id), done: true, isDone: true, pinnedAt: null };
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        conversations: () => [done, { ...conversation("running", "Active work", null), runStatus: "running" }],
        projects: [project],
        doneCount: 21,
        live,
      }),
    );
    expect(html).toContain("Reopen chat");
    expect(html).toContain("Stop the response before marking it done");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("21");
    expect(html).not.toContain(">Pinned</");
    expect(html).not.toContain('title="Completed work"');
    expect(html).not.toContain("No recent chats");
    expect(html).not.toContain("max-h-[40vh]");
    expect(html).not.toContain("overflow-y-auto");
  });

  test("pinned cards expose their status without a Done action or Ready filler", () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        conversations: () => [{ ...conversation("pinned", "Pinned work", null), pinnedAt: "2026-09-14T11:00:00.000Z" }],
        live,
      }),
    );
    expect(html).toContain('aria-label="Pinned"');
    expect(html).not.toContain("Mark chat done");
    expect(html).not.toContain(">Ready<");
    expect(html).not.toContain('class="k2b-app-workspace__sidebar-item-description"');
  });

  test("keeps New Chat text and icon stable while creation is pending", () => {
    const [conversations] = createSignal<AiConversation[]>([]);
    const idle = renderToString(() => createComponent(AssistantSidebar, { conversations, projects: [project], live }));
    const pending = renderToString(() =>
      createComponent(AssistantSidebar, { conversations, projects: [project], creatingConversation: () => true, live }),
    );

    expect(idle.match(/New Chat|New chat/g)?.length).toBe(pending.match(/New Chat|New chat/g)?.length);
    expect(pending).toContain("ti ti-plus");
    expect(pending).toContain("ti ti-folders");
    expect(pending).not.toContain("ti ti-message-plus");
    expect(idle).not.toMatch(/k2b-app-workspace__sidebar-icon-action is-active[^>]+aria-label="New chat"/);
    expect(pending).not.toContain("Creating Chat");
    expect(pending).not.toContain("Creating chat");
    expect(idle).not.toContain(">Pinned</");
  });
});

describe("All chats list", () => {
  test("labels Project chats beside their title", () => {
    const html = renderToString(() =>
      createComponent(AssistantAllChatsList, {
        conversations: [conversation("chatproject", "Project chat", project.id)],
        projects: [project],
        onOpenConversation: async () => "opened",
      }),
    );

    expect(html).toMatch(/Project chat.*Support/);
    expect(html).toContain("k2b-status-badge");
    expect(html).toContain('data-tone="neutral"');
  });
});
