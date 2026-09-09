import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { FileSource } from "@k2b/ui";
import type { CapabilityCatalogClientResult, CapabilityClientResult } from "@k2b/cloud/capabilities";

const root = mkdtempSync(resolve(tmpdir(), "assistant-context-content-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { assistantContextFileSource, assistantMarkdownBody, isAssistantContextImage, resolveAssistantCloudResource } = await import(
  "./AssistantContextContent"
);
type AssistantContextFile = import("./AssistantContextContent").AssistantContextFile;

const source = (label: string): FileSource => ({
  list: async () => [],
  read: async (path) => ({ encoding: "utf8", content: `${label}:${path}`, mediaType: "text/plain" }),
  downloadHref: (path) => `/${label}${path}`,
});

describe("Assistant context files", () => {
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
        protocolVersion: 1,
        apps: [
          {
            appId: "notebooks",
            appName: "Notebooks",
            appIcon: "ti ti-notebook",
            appDescription: "Markdown notebooks.",
            manifest: {
              protocolVersion: 1,
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
