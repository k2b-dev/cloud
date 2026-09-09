import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
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
  test("opens every Project and caps the icon-free Chats section with See all", () => {
    const [conversations] = createSignal([
      { ...conversation("chatpinned", "Pinned chat", null), pinnedAt: "2026-08-12T10:00:00.000Z" },
      { ...conversation("chatprojectpinned", "Pinned project chat", project.id), pinnedAt: "2026-08-12T09:00:00.000Z" },
      conversation("chatproject", "Project chat", project.id),
      ...Array.from({ length: 17 }, (_, index) => conversation(`chat${index + 1}`, `General chat ${index + 1}`, null)),
    ]);
    const html = renderToString(() => createComponent(AssistantSidebar, { conversations, projects: [project], live }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Project chat");
    expect(html).toContain(">Pinned</");
    expect(html).toContain("Pinned chat");
    expect(html.match(/title="Pinned chat"/g)).toHaveLength(2);
    expect(html.match(/title="Pinned project chat"/g)).toHaveLength(2);
    expect(html.indexOf(">Pinned</")).toBeLessThan(html.indexOf(">Projects</"));
    expect(html).toContain('aria-label="Edit Project chat"');
    expect(html).toContain(">Chats</");
    expect(html).toContain("General chat 15");
    expect(html).not.toContain("General chat 16");
    expect(html.match(/>See all</g)?.length).toBe(2);
    expect(html).not.toContain(">All Chats</");
    expect(html).not.toContain("Today");
    expect(html).not.toContain("This Week");
    expect(html).not.toContain("This Month");
    expect(html).not.toContain('class="ti ti-message"');
  });

  test("keeps New Chat text and icon stable while creation is pending", () => {
    const [conversations] = createSignal<AiConversation[]>([]);
    const idle = renderToString(() => createComponent(AssistantSidebar, { conversations, projects: [project], live }));
    const pending = renderToString(() =>
      createComponent(AssistantSidebar, { conversations, projects: [project], creatingConversation: () => true, live }),
    );

    expect(idle.match(/New Chat|New chat/g)?.length).toBe(pending.match(/New Chat|New chat/g)?.length);
    expect(pending).toContain("ti ti-plus");
    expect(pending).toContain("ti ti-folder-plus");
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
