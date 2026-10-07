import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiConversationSource } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";
import {
  assistantChatContextFor,
  assistantReferenceTitle,
  assistantResourceTypeLabel,
  splitAssistantConversationSources,
  visibleAssistantReferences,
} from "./assistant-context";

const root = mkdtempSync(resolve(tmpdir(), "assistant-chat-context-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { AssistantChatContextContent } = await import("./AssistantChatContext");
const { AssistantLiveProvider, createAssistantLiveHub } = await import("./assistant-live");

const source = (kind: AiConversationSource["kind"], key: string): AiConversationSource => ({
  kind,
  key,
  title: key,
  preview: null,
  icon: "ti ti-link",
  href: null,
  path: kind === "file" ? `/${key}` : null,
  mediaType: null,
  size: null,
  ref: kind === "resource" ? { type: "notebook", id: key } : null,
  occurrences: 1,
  firstSeenAt: "2026-08-12T08:00:00.000Z",
  lastSeenAt: "2026-08-12T08:00:00.000Z",
  sourceTurnId: null,
  sourceCallId: null,
  sourceMessageSeq: null,
});

test("Assistant chat context never reuses the previous chat snapshot while a new chat loads", () => {
  const stale = { chatId: "old-chat" } as AssistantChatContextSnapshot;
  expect(assistantChatContextFor("new-chat", stale)).toBeNull();
  expect(assistantChatContextFor("old-chat", stale)).toBe(stale);
});

describe("Assistant chat context", () => {
  test("does not expose raw resource types and IDs as reference titles", () => {
    const item = source("resource", "mail.message:MsG123");
    item.ref = { type: "mail.message", id: "MsG123" };
    item.title = "mail.message MsG123";

    expect(assistantReferenceTitle(item)).toBe("Mail message");
    expect(assistantReferenceTitle({ ...item, title: "Quarterly update" })).toBe("Quarterly update");
    expect(assistantResourceTypeLabel(item.ref)).toBe("Mail message");
  });

  test("renders the resource preview below its title", () => {
    const live = createAssistantLiveHub();
    const reference = source("resource", "mail.message:MsG123");
    reference.ref = { type: "mail.message", id: "MsG123" };
    reference.title = "Quarterly update";
    reference.preview = "A preview that is not used as the resource type.";
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantChatContextContent, {
            chatId: "cHt234",
            initial: emptySidebarSnapshot({ chatId: "cHt234", sources: [reference], files: [] }),
          });
        },
      }),
    );

    expect(html).toContain("Quarterly update");
    expect(html).not.toContain("Mail message");
    expect(html).toContain("A preview that is not used as the resource type.");
  });

  test("keeps used sources, Cloud references, and files in distinct user-facing groups", () => {
    const split = splitAssistantConversationSources([
      source("web", "docs"),
      source("activity", "search"),
      source("resource", "nb1234"),
      source("file", "brief.pdf"),
    ]);

    expect(split.sources.map((item) => item.key)).toEqual(["docs", "search"]);
    // Each web search is its own entry and keeps the search icon.
    const searches = splitAssistantConversationSources([source("activity", "web_search:umsatz q3"), source("activity", "web_search")]);
    expect(searches.sources.map((item) => item.icon)).toEqual(["ti ti-search", "ti ti-search"]);
    expect(split.references.map((item) => item.key)).toEqual(["nb1234"]);
  });

  test("renders only populated context sections", () => {
    const live = createAssistantLiveHub();
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantChatContextContent, {
            chatId: "cHt234",
            initial: emptySidebarSnapshot({ chatId: "cHt234", sources: [source("web", "Cloud docs")], files: [] }),
          });
        },
      }),
    );

    expect(html).toContain("Sources");
    expect(html).toContain("Cloud docs");
    expect(html).not.toContain("References");
    expect(html).not.toContain("Images");
    expect(html).not.toContain("Files");
    expect(html).not.toContain("Scheduled");
    expect(html).not.toContain("No sources used yet.");
    expect(html).not.toContain("No references used yet.");
    expect(html).not.toContain("No files yet.");
    expect(html).not.toContain("Nothing scheduled.");
    expect(html).not.toContain("tabular-nums");
    expect(html).not.toContain("text-right");
    expect(html).not.toContain("Chat ID");
    expect(html).not.toContain(">Chat context<");
  });

  test("counts files in section titles and only adds View all for hidden rows", () => {
    const live = createAssistantLiveHub();
    const file = (path: string, mediaType: string) => ({
      path,
      size: 42,
      mediaType,
      origin: "user" as const,
      updatedAt: "2026-08-12T08:00:00.000Z",
      version: 1,
    });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantChatContextContent, {
            chatId: "cHt234",
            initial: emptySidebarSnapshot({
              chatId: "cHt234",
              sources: [],
              files: [
                file("image-one.png", "image/png"),
                file("image-two.png", "image/png"),
                file("image-three.png", "image/png"),
                file("image-four.png", "image/png"),
                file("file-one.txt", "text/plain"),
                file("file-two.txt", "text/plain"),
                file("file-three.txt", "text/plain"),
                file("file-four.txt", "text/plain"),
              ],
            }),
          });
        },
      }),
    );

    expect(html).toContain("4 Images");
    expect(html).toContain("4 Files");
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("References");
    expect(html).not.toContain("Scheduled");
    expect(html.match(/>View all(?: · \d+)?</g)).toHaveLength(2);
    for (const visible of ["image-one.png", "image-two.png", "image-three.png", "file-one.txt", "file-two.txt", "file-three.txt"]) {
      expect(html).toContain(visible);
    }
    expect(html).not.toContain("image-four.png");
    expect(html).not.toContain("file-four.txt");
  });

  test("uses direct context viewers instead of an intermediate DetailPanel", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "AssistantChatContext.tsx")).text();
    expect(source).toContain("openAssistantContextFiles");
    expect(source).toContain("loadAssistantContextImages");
    expect(source).toContain("openAssistantKnowledgeSearch");
    expect(source).not.toContain("AssistantChatDetailPanel");
    expect(source).not.toContain("onViewDetail");
  });

  test("uses the shared compact action rows and keeps Project editing out of chats", async () => {
    const [context, shared, workspace] = await Promise.all([
      Bun.file(resolve(import.meta.dir, "AssistantChatContext.tsx")).text(),
      Bun.file(resolve(import.meta.dir, "AssistantContextContent.tsx")).text(),
      Bun.file(resolve(import.meta.dir, "AssistantWorkspace.island.tsx")).text(),
    ]);
    expect(context).toContain('title={text("View project")}');
    expect(context).toMatch(/icon="ti ti-eye"\s+title=\{text\("View project"\)\}/);
    expect(context).not.toContain("openAssistantProjectSettingsDialog");
    expect(shared).toContain("<DetailPanel.Action");
  });
});

test("hides only the current chat and the task already shown in Scheduled", () => {
  const refs = [
    { ...source("resource", "self"), ref: { type: "core.ai.chat", id: "cHt234" } },
    { ...source("resource", "other-chat"), ref: { type: "core.ai.chat", id: "cHt999" } },
    { ...source("resource", "visible-task"), ref: { type: "core.ai.task", id: "tSk234" } },
    { ...source("resource", "other-task"), ref: { type: "core.ai.task", id: "tSk999" } },
  ];
  expect(visibleAssistantReferences(refs, "cHt234", "tSk234").map((item) => item.key)).toEqual(["other-chat", "other-task"]);
  expect(visibleAssistantReferences(refs, "cHt234").map((item) => item.key)).toEqual(["other-chat", "visible-task", "other-task"]);
  expect(refs).toHaveLength(4);
});

test("uses readable AI type labels and preserves authored titles", () => {
  expect(assistantResourceTypeLabel({ type: "core.ai.task", id: "tSk234" })).toBe("Scheduled AI task");
  expect(assistantResourceTypeLabel({ type: "core.ai.chat", id: "cHt234" })).toBe("AI conversation");
  const item = { ...source("resource", "task"), ref: { type: "core.ai.task", id: "tSk234" }, title: "core.ai.task tSk234" };
  expect(assistantReferenceTitle(item, () => "Geplante KI-Aufgabe")).toBe("Geplante KI-Aufgabe");
  expect(assistantReferenceTitle({ ...item, title: "Read my mail" }, () => "Geplante KI-Aufgabe")).toBe("Read my mail");
});
