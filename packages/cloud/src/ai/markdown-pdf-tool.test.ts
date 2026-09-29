import { describe, expect, test } from "bun:test";
import { CloudAiMarkdownToPdfOutputSchema, createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const context = {
  actor: { kind: "user" as const, user: { id: "user-1" } },
  conversationId: "conversation-1",
  signal: new AbortController().signal,
};

describe("markdown_to_pdf", () => {
  test("renders an assistant Markdown file and writes the derived PDF path", async () => {
    let renderInput: unknown;
    let writeInput: unknown;
    const tool = createCloudAiMarkdownToPdfTool({
      read: async () => ({
        path: "/reports/summary.md",
        bytes: bytes("# Summary"),
        size: 9,
        mediaType: "text/markdown",
        origin: "assistant",
        updatedAt: "2026-08-19T12:00:00.000Z",
        version: 1,
      }),
      render: async (input) => {
        renderInput = input;
        return { pdf: bytes("%PDF-cloud"), contentType: "application/pdf" };
      },
      write: async (input) => {
        writeInput = input;
      },
    });
    if (tool.location !== "server") throw new Error("Expected server tool");

    const result = await tool.run({ path: "/reports/summary.md", template: "report", customCss: "h1 { color: navy; }" }, context as never);

    expect(renderInput).toEqual({ markdown: "# Summary", title: "summary", templateId: "report", customCss: "h1 { color: navy; }" });
    expect(writeInput).toMatchObject({
      conversationId: "conversation-1",
      path: "/reports/summary.pdf",
      mediaType: "application/pdf",
      origin: "assistant",
    });
    expect(CloudAiMarkdownToPdfOutputSchema.parse(result)).toEqual({
      sourcePath: "/reports/summary.md",
      path: "/reports/summary.pdf",
      size: 10,
      mediaType: "application/pdf",
    });
    expect(tool.def.approval).toBe("never");
    expect(tool.def.promptHint).toContain("write_file");
    expect(tool.def.promptHint).toContain("present");
  });

  test("supports custom-only CSS by omitting the template", async () => {
    let renderInput: unknown;
    const tool = createCloudAiMarkdownToPdfTool({
      read: async () => ({
        path: "/custom.md",
        bytes: bytes("Custom"),
        size: 6,
        mediaType: "text/markdown",
        origin: "assistant",
        updatedAt: "2026-08-19T12:00:00.000Z",
        version: 1,
      }),
      render: async (input) => {
        renderInput = input;
        return { pdf: bytes("%PDF"), contentType: "application/pdf" };
      },
      write: async () => undefined,
    });
    if (tool.location !== "server") throw new Error("Expected server tool");

    await tool.run({ path: "/custom.md", customCss: "@page { size: A4; }" }, context as never);
    expect(renderInput).toEqual({ markdown: "Custom", title: "custom", templateId: undefined, customCss: "@page { size: A4; }" });
  });

  test("requires a conversation-scoped assistant-owned Markdown source", async () => {
    const tool = createCloudAiMarkdownToPdfTool({
      read: async () => ({
        path: "/upload.md",
        bytes: bytes("Upload"),
        size: 6,
        mediaType: "text/markdown",
        origin: "user",
        updatedAt: "2026-08-19T12:00:00.000Z",
        version: 1,
      }),
      render: async () => {
        throw new Error("must not render");
      },
      write: async () => {
        throw new Error("must not write");
      },
    });
    if (tool.location !== "server") throw new Error("Expected server tool");

    await expect(tool.run({ path: "/project/report.md" }, context as never)).rejects.toThrow("Project files are read-only");
    await expect(tool.run({ path: "/report.txt" }, context as never)).rejects.toThrow("requires a .md file");
    await expect(tool.run({ path: "/upload.md" }, context as never)).rejects.toThrow("write_file");
    await expect(tool.run({ path: "/upload.md" }, { ...context, conversationId: undefined } as never)).rejects.toThrow(
      "conversation context",
    );
  });

  test("does not hide a protected output-path conflict", async () => {
    const tool = createCloudAiMarkdownToPdfTool({
      read: async () => ({
        path: "/report.md",
        bytes: bytes("Report"),
        size: 6,
        mediaType: "text/markdown",
        origin: "assistant",
        updatedAt: "2026-08-19T12:00:00.000Z",
        version: 1,
      }),
      render: async () => ({ pdf: bytes("%PDF"), contentType: "application/pdf" }),
      write: async () => {
        throw new Error("Cannot overwrite user-uploaded file /report.pdf.");
      },
    });
    if (tool.location !== "server") throw new Error("Expected server tool");

    await expect(tool.run({ path: "/report.md" }, context as never)).rejects.toThrow("Cannot overwrite user-uploaded file");
  });
});
