import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CapabilityCatalogClientResult, CapabilityClientResult } from "@k2b/cloud/capabilities";
import { createConfig } from "@k2b/ssr";
import type { FileSource } from "@k2b/ui";

const root = mkdtempSync(resolve(tmpdir(), "assistant-context-content-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { assistantContextFileSource, assistantMarkdownBody, isAssistantContextImage, resolveAssistantCloudResource } = await import(
  "./AssistantContextContent"
);
const { assistantConversationFileSource } = await import("./dictation-files");
type AssistantContextFile = import("./AssistantContextContent").AssistantContextFile;

const source = (label: string): FileSource => ({
  list: async () => [],
  read: async (path) => ({ encoding: "utf8", content: `${label}:${path}`, mediaType: "text/plain" }),
  downloadHref: (path) => `/${label}${path}`,
});

describe("Assistant context files", () => {
  test("file picker groups localized voice inputs and resolves selections to original paths", async () => {
    const originalFetch = globalThis.fetch;
    const recordedAt = "2026-09-11T11:42:00Z";
    const files = [
      {
        path: "/renamed.wav",
        size: 44,
        mediaType: "audio/wav",
        origin: "user",
        updatedAt: recordedAt,
        dictationRecordedAt: recordedAt,
        version: 1,
      },
      { path: "/dictation-manual.m4a", size: 44, mediaType: "audio/mp4", origin: "user", updatedAt: recordedAt, version: 1 },
    ];
    try {
      globalThis.fetch = Object.assign(async () => Response.json({ files }), { preconnect: originalFetch.preconnect });
      const picker = assistantConversationFileSource(
        "chat-id",
        () => "de-DE",
        () => "Spracheingaben",
      );
      const entries = await picker.list();
      expect(entries[0]!.path).toBe("/Spracheingaben/renamed.wav");
      expect(entries[0]!.displayName).toContain("11.09.26");
      expect(entries[1]!.path).toBe("/Chat/dictation-manual.m4a");
      expect(entries[1]!.displayName).toBeUndefined();
      expect(picker.actualPath(entries[0]!.path)).toBe("/renamed.wav");
      expect(picker.downloadHref?.(entries[0]!.path)).toContain("path=%2Frenamed.wav");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("groups dictation by provenance and keeps its real read/download identity", async () => {
    const chat = source("chat");
    const files: AssistantContextFile[] = [
      {
        id: "recorded",
        path: "/renamed.wav",
        mediaType: "audio/wav",
        size: 44,
        scope: "chat",
        source: chat,
        dictationRecordedAt: "2026-09-11T11:42:00Z",
        displayName: "11.09.26, 13:42:00",
      },
      { id: "uploaded", path: "/dictation-upload.m4a", mediaType: "audio/mp4", size: 44, scope: "chat", source: chat },
    ];
    const combined = assistantContextFileSource(files);
    const entries = await combined.list();
    expect(entries[0]).toMatchObject({ path: "/Voice inputs/renamed.wav", displayName: "11.09.26, 13:42:00", icon: "ti-microphone" });
    expect(entries[1]!.path).toBe("/Chat/dictation-upload.m4a");
    expect((await combined.read(entries[0]!.path)).content).toBe("chat:/renamed.wav");
    expect(combined.downloadHref?.(entries[0]!.path)).toBe("/chat/renamed.wav");
  });

  test("keeps Project and chat files in one collision-safe read-only browser", async () => {
    const projectSource = source("project");
    const chatSource = source("chat");
    const files = [
      { id: "project-file", path: "/notes.md", mediaType: "text/markdown", size: 20, scope: "project", source: projectSource },
      { id: "chat-file", path: "/notes.md", mediaType: "text/markdown", size: 10, scope: "chat", source: chatSource },
    ] satisfies AssistantContextFile[];
    const combined = assistantContextFileSource(files);

    expect((await combined.list()).map((file) => file.path)).toEqual(["/Project/notes.md", "/Chat/notes.md"]);
    expect(await combined.read("/Project/notes.md")).toEqual({
      encoding: "utf8",
      content: "project:/notes.md",
      mediaType: "text/plain",
    });
    expect(combined.downloadHref?.("/Chat/notes.md")).toBe("/chat/notes.md");
    expect(combined.isReadOnly?.("/Project/notes.md")).toBeTrue();
  });

  test("classifies images separately from regular files", () => {
    const base = { id: "file", path: "/file", size: 10, scope: "chat", source: source("chat") } satisfies Omit<
      AssistantContextFile,
      "mediaType"
    >;
    expect(isAssistantContextImage({ ...base, mediaType: "image/png" })).toBeTrue();
    expect(isAssistantContextImage({ ...base, mediaType: "application/pdf" })).toBeFalse();
  });
});

describe("Assistant context Markdown", () => {
  test("removes only a leading H1 that duplicates the structured title", () => {
    expect(assistantMarkdownBody("Typography and motion", "\n# Typography   and motion\n\nBody copy.")).toBe("Body copy.");
    expect(assistantMarkdownBody("Typography and motion", "# Different heading\n\nBody copy.")).toBe("# Different heading\n\nBody copy.");
    expect(assistantMarkdownBody("Typography and motion", "Body copy.")).toBe("Body copy.");
  });
});

describe("Assistant Cloud references", () => {
  test("opens a canonical reader whose data is a domain object", async () => {
    const ref = { type: "notebooks.note", id: "3rQGbm" };
    const catalog: CapabilityCatalogClientResult = {
      ok: true,
      data: {
        protocolVersion: 2,
        apps: [
          {
            appId: "notebooks",
            appName: "Notebooks",
            appIcon: "ti ti-notebook",
            appDescription: "Markdown notebooks.",
            manifest: {
              protocolVersion: 2,
              appId: "notebooks",
              manifestHash: "a".repeat(64),
              types: [
                {
                  localId: "note",
                  title: "Note",
                  description: "A Markdown note.",
                  icon: "ti ti-file-text",
                  reader: "note.read",
                },
              ],
              queries: [
                {
                  localId: "note.read",
                  title: "Read note",
                  description: "Read one note.",
                  inputSchema: {},
                  dataSchema: {},
                  schemaHash: "b".repeat(64),
                  openWorld: false,
                },
              ],
              actions: [],
              commands: [],
            },
          },
        ],
        page: { hasMore: false },
      },
    };
    const invocation: CapabilityClientResult<unknown> = {
      ok: true,
      data: {
        data: { id: ref.id, title: "Apache Paimon Vector Index 0.4.0", content: "# Release" },
        refs: [ref],
        links: [{ rel: "open", href: "/app/notebooks/JJVtWA/notes/3rQGbm" }],
      },
    };

    const resolved = await resolveAssistantCloudResource(ref, {
      listCatalog: async () => catalog,
      invoke: async () => invocation,
    });

    expect(resolved).toEqual({
      ref,
      title: "Note",
      icon: "ti ti-file-text",
      href: "/app/notebooks/JJVtWA/notes/3rQGbm",
    });
  });
});
