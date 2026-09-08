import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { AiConversationSource } from "@valentinkolb/cloud/ai";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AssistantChatContextSnapshot } from "../chat-context";
import {
  assistantChatContextFor,
  assistantReferenceTitle,
  visibleAssistantReferences,
  assistantResourceTypeLabel,
  splitAssistantConversationSources,
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

const { assistantChatContextHasContent, assistantChatContextHasPanel, AssistantChatContextContent, AssistantChatContextPanel } =
  await import("./AssistantChatContext");
const { AssistantChatContextSurface } = await import("./AssistantChatContextSurfaces");
const { AssistantLiveProvider, createAssistantLiveInvalidationHub } = await import("./assistant-live");

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
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
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
            initial: { chatId: "cHt234", sources: [reference], files: [], tasks: [] },
          });
        },
      }),
    );
    live.dispose();

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
    expect(split.references.map((item) => item.key)).toEqual(["nb1234"]);
  });

  test("renders the compact context only at the shared laptop breakpoint", () => {
    const html = renderToString(() => createComponent(AssistantChatContextSurface, { children: "Loading context" }));

    expect(html).toContain('data-assistant-context="compact"');
    expect(html).toContain('class="k2b-paper');
    expect(html).toContain('role="complementary"');
    expect(html).toContain("hidden");
    expect(html).toContain("lg:flex");
    expect(html).toContain("shrink-0");
    expect(html).not.toContain("absolute");
    expect(html).toContain('aria-label="Chat context"');
    expect(html).not.toContain("ti-adjustments-horizontal");
    expect(html).not.toContain("<h2");
    expect(html).toContain("Loading context");
  });

  test("omits the compact Paper after a successfully loaded empty context", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const renderPanel = (initial: AssistantChatContextSnapshot) =>
      renderToString(() =>
        createComponent(AssistantLiveProvider, {
          value: live,
          get children() {
            return createComponent(AssistantChatContextPanel, {
              chatId: initial.chatId,
              initial,
            });
          },
        }),
      );

    const empty = { chatId: "cHt234", sources: [], files: [], tasks: [] } satisfies AssistantChatContextSnapshot;
    const populated = { ...empty, sources: [source("web", "docs")] } satisfies AssistantChatContextSnapshot;

    expect(assistantChatContextHasContent(empty)).toBeFalse();
    expect(assistantChatContextHasPanel(empty)).toBeFalse();
    expect(assistantChatContextHasPanel(empty, true)).toBeTrue();
    expect(assistantChatContextHasContent({ ...empty, sources: [source("file", "stale.pdf")] })).toBeFalse();
    expect(renderPanel(empty)).not.toContain('data-assistant-context="compact"');
    expect(assistantChatContextHasContent(populated)).toBeTrue();
    expect(renderPanel(populated)).toContain('data-assistant-context="compact"');
    live.dispose();
  });

  test("keeps unknown non-Project context closed while it loads", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantChatContextPanel, { chatId: "cHt234" });
        },
      }),
    );
    live.dispose();

    expect(html).not.toContain('data-assistant-context="compact"');
    expect(html).not.toContain("Loading context");
  });

  test("renders only populated context sections", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantChatContextContent, {
            chatId: "cHt234",
            initial: { chatId: "cHt234", sources: [source("web", "Cloud docs")], files: [], tasks: [] },
          });
        },
      }),
    );
    live.dispose();

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
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
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
            initial: {
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
              tasks: [],
            },
          });
        },
      }),
    );
    live.dispose();

    expect(html).toContain("4 Images");
    expect(html).toContain("4 Files");
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("References");
    expect(html).not.toContain("Scheduled");
    expect(html.match(/>View all</g)).toHaveLength(2);
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
    expect(workspace).toContain("chatContextPresence() === true");
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
  expect(assistantChatContextHasContent({ chatId: "cHt234", sources: refs.slice(0, 1), files: [], tasks: [] })).toBe(false);
  expect(refs).toHaveLength(4);
});

test("uses readable AI type labels and preserves authored titles", () => {
  expect(assistantResourceTypeLabel({ type: "core.ai.task", id: "tSk234" })).toBe("Scheduled AI task");
  expect(assistantResourceTypeLabel({ type: "core.ai.chat", id: "cHt234" })).toBe("AI conversation");
  const item = { ...source("resource", "task"), ref: { type: "core.ai.task", id: "tSk234" }, title: "core.ai.task tSk234" };
  expect(assistantReferenceTitle(item, () => "Geplante KI-Aufgabe")).toBe("Geplante KI-Aufgabe");
  expect(assistantReferenceTitle({ ...item, title: "Read my mail" }, () => "Geplante KI-Aufgabe")).toBe("Read my mail");
});
