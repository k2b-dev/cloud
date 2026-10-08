import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import type { NavigationItem } from "@k2b/ui";
import { createComponent, createSignal } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../tests/fixtures/select-html";

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
const { createAssistantLiveHub } = await import("./assistant-live");
const live = createAssistantLiveHub();
// One fixed server render time, so the day sections do not depend on when the test runs.
const renderedAt = "2026-10-08T10:00:00.000Z";

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
  test("marks a running chat with one quiet status at the row end instead of a second line", () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        timeZone: "UTC",
        renderedAt,
        conversations: () => [
          {
            ...conversation("working", "Import", null),
            runStatus: "running",
            activity: { completed: 1, total: 3, step: "Check totals", tool: "Read file" },
          },
          { ...conversation("waiting", "Approval", null), runStatus: "needs_attention" },
        ],
        activeConversationId: () => null,
        live,
      }),
    );
    expect(html).toContain('class="assistant-chat-marker" data-tone="progress" title="Running"');
    expect(html).toContain('class="assistant-chat-marker" data-tone="attention" title="Waiting for you"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('class="k2b-app-workspace__sidebar-item-description"');
  });

  test("selects only the visible project or Studio despite a retained chat", () => {
    for (const activeView of ["chat", "apps"] as const) {
      const html = renderToString(() =>
        createComponent(AssistantSidebar, {
          timeZone: "UTC",
          renderedAt,
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

  test("lists open chats as flat rows under day headings, pinned chats first", () => {
    const today = renderedAt;
    const [conversations] = createSignal([
      { ...conversation("chatpinned", "Pinned chat", null), pinnedAt: "2026-08-12T10:00:00.000Z" },
      { ...conversation("chatproject", "Project chat", project.id), lastUsedAt: today },
      ...Array.from({ length: 17 }, (_, index) => ({
        ...conversation(`chat${index + 1}`, `General chat ${index + 1}`, null),
        lastUsedAt: new Date(Date.parse(renderedAt) - 90 * 86_400_000).toISOString(),
      })),
    ]);
    const rendered = renderToString(() =>
      createComponent(AssistantSidebar, { timeZone: "UTC", renderedAt, conversations, projects: [project], live }),
    );
    // The desktop list, without hydration markers, after the mobile navigation snapshot that lists the same chats.
    const html = rendered.slice(rendered.indexOf("<aside")).replaceAll(/<!--[^>]*-->/g, "");

    expect(html.indexOf("<h2>Pinned</h2>")).toBeGreaterThan(-1);
    const row = (id: string) => html.indexOf(`href="/app/assistant?conversation=${id}"`);
    expect(html.indexOf("<h2>Pinned</h2>")).toBeLessThan(row("chatpinned"));
    expect(row("chatpinned")).toBeLessThan(html.indexOf("<h2>Today</h2>"));
    expect(html.indexOf("<h2>Today</h2>")).toBeLessThan(row("chatproject"));
    expect(row("chatproject")).toBeLessThan(html.indexOf("<h2>Older</h2>"));
    expect(html.indexOf("<h2>Older</h2>")).toBeLessThan(row("chat1"));
    expect(html).toContain("General chat 17");
    expect(html).toContain("Chat settings");
    expect(html).toContain("Mark chat done");
    expect(html).toContain("All chats");
    // No context header with project name and time above each title, and no cards.
    expect(html).not.toContain('data-variant="card"');
    expect(html).not.toContain("k2b-app-workspace__sidebar-item-context");
    expect(html).toContain('data-marquee="false"');
  });

  test("separates Done from pinned and Project chats and offers reopening", () => {
    const done = { ...conversation("finished", "Completed work", project.id), done: true, isDone: true, pinnedAt: null };
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        timeZone: "UTC",
        renderedAt,
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

  test("pinned chats sit under their heading without a Done action or Ready filler", () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        timeZone: "UTC",
        renderedAt,
        conversations: () => [{ ...conversation("pinned", "Pinned work", null), pinnedAt: "2026-09-14T11:00:00.000Z" }],
        live,
      }),
    );
    expect(html.replaceAll(/<!--[^>]*-->/g, "")).toContain("<h2>Pinned</h2>");
    expect(html).not.toContain("Mark chat done");
    expect(html).not.toContain(">Ready<");
    expect(html).not.toContain('class="k2b-app-workspace__sidebar-item-description"');
  });

  test("shows empty chat, Done, Studio, and Project lists as inline lines where their first rows would be", async () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, { timeZone: "UTC", renderedAt, conversations: () => [], projects: [], live }),
    );
    const inline = await selectHtml(html, '.k2b-placeholder[data-variant="inline"][data-align="left"]');
    const icons = await selectHtml(html, '.k2b-placeholder[data-variant="inline"] .k2b-placeholder__icon > i');

    // Both footers (expanded and collapsed sidebar) carry the Studio and Project menus.
    const studio = "No apps yet. Ask Assistant to build one.";
    expect(inline.map((placeholder) => placeholder.text)).toEqual([
      "No chats yet",
      "No done chats.",
      studio,
      "No Projects yet",
      studio,
      "No Projects yet",
    ]);
    // Chat rows are cards without a leading icon; Studio and Project lines carry their rows' icons.
    expect(icons.map((icon) => icon.attributes.class)).toEqual(["ti ti-app-window", "ti ti-folder", "ti ti-app-window", "ti ti-folder"]);
    expect(await selectHtml(html, ".k2b-app-workspace__sidebar-section-content > .k2b-placeholder:first-child")).toHaveLength(2);
  });

  test("keeps New Chat text and icon stable while creation is pending", () => {
    const [conversations] = createSignal<AiConversation[]>([]);
    const idle = renderToString(() =>
      createComponent(AssistantSidebar, { timeZone: "UTC", renderedAt, conversations, projects: [project], live }),
    );
    const pending = renderToString(() =>
      createComponent(AssistantSidebar, {
        timeZone: "UTC",
        renderedAt,
        conversations,
        projects: [project],
        creatingConversation: () => true,
        live,
      }),
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

describe("Assistant phone menu", () => {
  test("lists the same day sections as the desktop list, with each status in a kept slot instead of a second line", () => {
    const html = renderToString(() =>
      createComponent(AssistantSidebar, {
        timeZone: "UTC",
        renderedAt,
        conversations: () => [
          { ...conversation("pinned", "Pinned work", null), pinnedAt: "2026-09-14T11:00:00.000Z" },
          { ...conversation("working", "Import", null), lastUsedAt: renderedAt, runStatus: "running" },
          { ...conversation("quiet", "Notes", null), lastUsedAt: "2026-10-07T09:00:00.000Z" },
          { ...conversation("planned", "Weekly report", null), lastUsedAt: "2026-06-01T09:00:00.000Z", hasActiveSchedule: true },
        ],
        live,
      }),
    );
    const snapshot = /<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)?.[1];
    const items = (JSON.parse(snapshot!) as { items: NavigationItem[] }).items;
    const sections = items.filter((item) => item.section);
    expect(sections.map((section) => [section.label, section.children?.map((chat) => [chat.label, chat.status])])).toEqual([
      ["Pinned", [["Pinned work", null]]],
      ["Today", [["Import", { icon: "ti ti-loader-2 animate-spin motion-reduce:animate-none", label: "Running", tone: "neutral" }]]],
      ["Yesterday", [["Notes", null]]],
      ["Older", [["Weekly report", { icon: "ti ti-clock", label: "Active schedule", tone: "neutral" }]]],
    ]);
    // Rows are plain titles like the desktop list: no per-chat icon, and no description line that comes and goes.
    const chats = sections.flatMap((section) => section.children ?? []);
    expect(chats.every((chat) => chat.icon === undefined && chat.description === undefined)).toBe(true);
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

  test("shows the time each page is ordered by: last update, or last use for Done", () => {
    const chat = {
      ...conversation("renamed", "Renamed chat", null),
      lastUsedAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-10-08T09:00:00.000Z",
    };
    const render = (orderedByUse: boolean) =>
      renderToString(() =>
        createComponent(AssistantAllChatsList, { conversations: [chat], orderedByUse, onOpenConversation: async () => "opened" }),
      );
    expect(render(false)).toContain('datetime="2026-10-08T09:00:00.000Z"');
    expect(render(true)).toContain('datetime="2026-09-14T00:00:00.000Z"');
  });
});
