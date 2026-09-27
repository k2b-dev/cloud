import { describe, expect, test } from "bun:test";
import type { GotenbergConfig, RenderHtmlToPdfInput, RenderHtmlToPdfOptions } from "../services/pdf";
import type { AiFileContent } from "./files-store";
import { CloudAiHtmlToPdfInputSchema, CloudAiHtmlToPdfOutputSchema, createCloudAiHtmlToPdfTool } from "./html-pdf-tool";
import { createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const context = () => ({
  actor: { kind: "user" as const, user: { id: "user-1" } },
  conversationId: "conversation-1",
  signal: new AbortController().signal,
});
const config: GotenbergConfig = { url: "http://gotenberg.test", timeoutMs: 1_000, maxHtmlBytes: 1_024, maxPdfBytes: 4_096 };

type StoredFile = { content: string | Uint8Array; mediaType?: string; origin?: "user" | "assistant" };

/** In-memory conversation files; reads and writes are recorded for assertions. */
const conversation = (files: Record<string, StoredFile>) => {
  const reads: string[] = [];
  const written: { path: string; bytes: Uint8Array; mediaType: string; origin: string }[] = [];
  const file = (path: string): AiFileContent | null => {
    const stored = files[path];
    if (!stored) return null;
    const content = typeof stored.content === "string" ? bytes(stored.content) : stored.content;
    return {
      path,
      bytes: content,
      size: content.byteLength,
      mediaType: stored.mediaType ?? "text/html",
      origin: stored.origin ?? "assistant",
      updatedAt: "2026-09-27T12:00:00.000Z",
      version: 1,
    };
  };
  return {
    reads,
    written,
    dependencies: {
      stat: async ({ path }: { path: string }) => {
        const found = file(path);
        if (!found) return null;
        const { bytes: _bytes, ...stat } = found;
        return stat;
      },
      read: async ({ path }: { path: string }) => {
        reads.push(path);
        return file(path);
      },
      write: async (input: { path: string; bytes: Uint8Array; mediaType: string; origin: "assistant" }) => {
        written.push(input);
      },
      config: async () => config,
    },
  };
};

const serverTool = (dependencies: Parameters<typeof createCloudAiHtmlToPdfTool>[0]) => {
  const tool = createCloudAiHtmlToPdfTool(dependencies);
  if (tool.location !== "server") throw new Error("Expected server tool");
  return tool;
};

describe("html_to_pdf", () => {
  test("renders the HTML with uploaded CSS, header, footer, and assets and the page, then writes the sibling PDF", async () => {
    const files = conversation({
      "/letters/offer.html": { content: '<html><body><img src="logo.png"><h1 class="title">Offer</h1></body></html>' },
      "/letters/offer.css": { content: ".title { color: teal; }", mediaType: "text/css", origin: "user" },
      "/letters/header.html": { content: "<p>Example Ltd.</p>", origin: "user" },
      "/letters/footer.html": { content: '<p><span class="pageNumber"></span></p>', origin: "user" },
      "/uploads/logo.png": { content: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png", origin: "user" },
      "/uploads/brand.woff2": { content: new Uint8Array([119, 79, 70, 50, 1]), mediaType: "font/woff2", origin: "user" },
    });
    let rendered: { input: RenderHtmlToPdfInput; config: GotenbergConfig; options: RenderHtmlToPdfOptions } | undefined;
    const ctx = context();
    const tool = serverTool({
      ...files.dependencies,
      render: async (input, usedConfig, options) => {
        rendered = { input, config: usedConfig, options };
        return { pdf: bytes("%PDF-offer"), contentType: "application/pdf" };
      },
    });

    const result = await tool.run(
      {
        path: "/letters/offer.html",
        cssPath: "letters/offer.css",
        customCss: "h1 { font-family: Brand; }",
        headerPath: "/letters/header.html",
        footerPath: "/letters/footer.html",
        assets: ["/uploads/logo.png", "/uploads/brand.woff2"],
        page: { format: "A5", landscape: true, margin: { top: 30, bottom: 25 } },
      },
      ctx as never,
    );

    expect(rendered?.input.html).toBe(
      '<!doctype html><html><body><img src="logo.png"><h1 class="title">Offer</h1></body></html>\n<style>\n.title { color: teal; }\nh1 { font-family: Brand; }\n</style>\n',
    );
    expect(rendered?.input.headerHtml).toBe("<p>Example Ltd.</p>");
    expect(rendered?.input.footerHtml).toBe('<p><span class="pageNumber"></span></p>');
    expect(rendered?.input.assets?.map((asset) => [asset.name, asset.data.type, asset.data.size])).toEqual([
      ["logo.png", "image/png", 4],
      ["brand.woff2", "font/woff2", 5],
    ]);
    expect(rendered?.input.page).toEqual({ format: "A5", landscape: true, margin: { top: 30, bottom: 25 } });
    expect(rendered?.input.tagged).toBe(true);
    expect(rendered?.config).toBe(config);
    expect(rendered?.options.signal).toBe(ctx.signal);
    expect(files.written).toEqual([
      {
        conversationId: "conversation-1",
        path: "/letters/offer.pdf",
        bytes: bytes("%PDF-offer"),
        mediaType: "application/pdf",
        origin: "assistant",
      },
    ] as never);
    expect(CloudAiHtmlToPdfOutputSchema.parse(result)).toEqual({
      sourcePath: "/letters/offer.html",
      path: "/letters/offer.pdf",
      size: 10,
      mediaType: "application/pdf",
    });
    expect(tool.def.approval).toBe("never");
    expect(tool.def.promptHint).toContain("write_file");
    expect(tool.def.promptHint).toContain("present");
    expect(tool.def.description).toContain("offline");
    expect(tool.def.description).toContain("MathML");
    expect(tool.def.description).toContain("percent-encode");
  });

  test("defaults to an A4 portrait page and leaves a document without separate CSS unchanged", async () => {
    let input: RenderHtmlToPdfInput | undefined;
    const files = conversation({ "/report.htm": { content: "<p>Report</p>" } });
    const tool = serverTool({
      ...files.dependencies,
      render: async (value) => {
        input = value;
        return { pdf: bytes("%PDF"), contentType: "application/pdf" };
      },
    });

    const result = await tool.run({ path: "/report.htm", customCss: "  " }, context() as never);

    expect(input).toEqual({
      html: "<!doctype html><p>Report</p>",
      headerHtml: undefined,
      footerHtml: undefined,
      assets: [],
      page: { format: "A4", landscape: false, margin: undefined },
      tagged: true,
    });
    expect(result.path).toBe("/report.pdf");
  });

  test("requires an assistant-owned conversation HTML source", async () => {
    const files = conversation({
      "/upload.html": { content: "<p>Upload</p>", origin: "user" },
      "/notes.md": { content: "# Notes", mediaType: "text/markdown" },
    });
    const tool = serverTool({
      ...files.dependencies,
      render: async () => {
        throw new Error("must not render");
      },
    });

    await expect(tool.run({ path: "/project/offer.html" }, context() as never)).rejects.toThrow("converts only conversation files");
    await expect(tool.run({ path: "/skills/brand/letter.html" }, context() as never)).rejects.toThrow("converts only conversation files");
    await expect(tool.run({ path: "/notes.md" }, context() as never)).rejects.toThrow("requires a .html file");
    await expect(tool.run({ path: "/upload.html" }, context() as never)).rejects.toThrow("assistant-owned HTML file");
    await expect(tool.run({ path: "/missing.html" }, context() as never)).rejects.toThrow("No such file: /missing.html");
    await expect(tool.run({ path: "/upload.html" }, { ...context(), conversationId: undefined } as never)).rejects.toThrow(
      "conversation context",
    );
    expect(files.reads).toEqual([]);
  });

  test("reads CSS, header, footer, and assets only from this conversation", async () => {
    const files = conversation({ "/offer.html": { content: "<p>Offer</p>" } });
    const tool = serverTool({
      ...files.dependencies,
      render: async () => {
        throw new Error("must not render");
      },
    });

    await expect(tool.run({ path: "/offer.html", assets: ["/project/logo.png"] }, context() as never)).rejects.toThrow(
      "only files of this conversation",
    );
    await expect(tool.run({ path: "/offer.html", cssPath: "/skills/brand/brand.css" }, context() as never)).rejects.toThrow(
      "only files of this conversation",
    );
    await expect(tool.run({ path: "/offer.html", headerPath: "/../header.html" }, context() as never)).rejects.toThrow(
      "absolute conversation file path",
    );
    await expect(tool.run({ path: "/offer.html", assets: ["/logo.png"] }, context() as never)).rejects.toThrow("No such file: /logo.png");
    expect(files.reads).toEqual([]);
  });

  test("checks the shared input budget before loading any file", async () => {
    const files = conversation({
      "/offer.html": { content: "x".repeat(600) },
      "/photo.jpg": { content: new Uint8Array(500), mediaType: "image/jpeg", origin: "user" },
    });
    const tool = serverTool({
      ...files.dependencies,
      render: async () => {
        throw new Error("must not render");
      },
    });

    await expect(tool.run({ path: "/offer.html", assets: ["/photo.jpg"] }, context() as never)).rejects.toThrow(
      "exceed the 1024-byte PDF input budget",
    );
    await expect(tool.run({ path: "/offer.html", customCss: "y".repeat(500) }, context() as never)).rejects.toThrow(
      "exceed the 1024-byte PDF input budget",
    );
    expect(files.reads).toEqual([]);
  });

  test("rejects CSS that would close its style element and text that is not UTF-8", async () => {
    const files = conversation({
      "/offer.html": { content: "<p>Offer</p>" },
      "/broken.html": { content: new Uint8Array([0xc3, 0x28]) },
    });
    const tool = serverTool({
      ...files.dependencies,
      render: async () => {
        throw new Error("must not render");
      },
    });

    await expect(tool.run({ path: "/offer.html", customCss: "p { color: red; } </STYLE><p>" }, context() as never)).rejects.toThrow(
      "CSS cannot contain </style",
    );
    await expect(tool.run({ path: "/broken.html" }, context() as never)).rejects.toThrow("not valid UTF-8");
  });

  test("bounds the input schema", () => {
    expect(
      CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", assets: Array.from({ length: 64 }, (_, i) => `/${i}.png`) }).success,
    ).toBe(true);
    expect(
      CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", assets: Array.from({ length: 65 }, (_, i) => `/${i}.png`) }).success,
    ).toBe(false);
    expect(CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", page: { margin: { top: -1 } } }).success).toBe(false);
    expect(CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", page: { format: "B5" } }).success).toBe(false);
    expect(CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", customCss: "x".repeat(32 * 1024 + 1) }).success).toBe(false);
    expect(CloudAiHtmlToPdfInputSchema.safeParse({ path: "/a.html", url: "https://example.com" }).success).toBe(false);
  });

  test("reports a cancelled conversion instead of a renderer error and writes nothing", async () => {
    const files = conversation({ "/offer.html": { content: "<p>Offer</p>" } });
    const controller = new AbortController();
    const tool = serverTool({
      ...files.dependencies,
      render: async () => {
        controller.abort(new Error("Turn stopped."));
        throw new Error("Gotenberg request timed out.");
      },
    });

    await expect(tool.run({ path: "/offer.html" }, { ...context(), signal: controller.signal } as never)).rejects.toThrow("Turn stopped.");
    expect(files.written).toEqual([]);
  });

  test("does not hide a protected output-path conflict", async () => {
    const files = conversation({ "/offer.html": { content: "<p>Offer</p>" } });
    const tool = serverTool({
      ...files.dependencies,
      render: async () => ({ pdf: bytes("%PDF"), contentType: "application/pdf" }),
      write: async () => {
        throw new Error("Cannot overwrite user-uploaded file /offer.pdf.");
      },
    });

    await expect(tool.run({ path: "/offer.html" }, context() as never)).rejects.toThrow("Cannot overwrite user-uploaded file");
  });
});

describe("chat PDF conversions", () => {
  test("share two active renders across markdown_to_pdf and html_to_pdf", async () => {
    const releases: (() => void)[] = [];
    const held = () =>
      new Promise<{ pdf: Uint8Array; contentType: string }>((resolve) => {
        releases.push(() => resolve({ pdf: bytes("%PDF"), contentType: "application/pdf" }));
      });
    const files = conversation({
      "/offer.html": { content: "<p>Offer</p>" },
      "/notes.md": { content: "# Notes", mediaType: "text/markdown" },
    });
    const html = serverTool({ ...files.dependencies, render: held });
    const markdown = createCloudAiMarkdownToPdfTool({ read: files.dependencies.read, write: files.dependencies.write, render: held });
    if (markdown.location !== "server") throw new Error("Expected server tool");

    const first = html.run({ path: "/offer.html" }, context() as never);
    const second = markdown.run({ path: "/notes.md" }, context() as never);
    while (releases.length < 2) await Bun.sleep(1);

    await expect(html.run({ path: "/offer.html" }, context() as never)).rejects.toThrow("PDF renderer is busy");
    await expect(markdown.run({ path: "/notes.md" }, context() as never)).rejects.toThrow("PDF renderer is busy");

    releases.shift()?.();
    await Promise.race([first, second]);
    const third = html.run({ path: "/offer.html" }, context() as never);
    while (releases.length < 2) await Bun.sleep(1);
    for (const release of releases.splice(0)) release();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });
});
