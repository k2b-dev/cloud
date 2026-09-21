/**
 * Guards the standalone contract for the file / code / markdown / docs /
 * structured-data / media components: their markup may only use classes the
 * package itself styles. Cloud's raw Tailwind utilities are NOT shipped with
 * `@k2b/ui`, so any utility left in the markup would style nothing.
 *
 * Requires the built stylesheet — `bun run build` (the package `test` script
 * does that first).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, Suspense } from "solid-js";
import { renderToString, renderToStringAsync } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-content-styles-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const stylesPath = resolve(import.meta.dir, "../../dist/styles.css");
if (!existsSync(stylesPath)) throw new Error("dist/styles.css is missing — run `bun run build` before this test");
const styles = readFileSync(stylesPath, "utf8");

const { default: CodeDisplay } = await import("./CodeDisplay");
const { DocCode, DocConceptGrid, DocInlineCode, DocLead, DocNote, DocPage, DocRows, DocSection } = await import("./Docs");
const { FileBrowserPanel } = await import("./FileBrowser");
const { default: FileTree } = await import("./FileTree");
const { default: FileView } = await import("./FileView");
const { default: Lightbox } = await import("./Lightbox");
const { default: MarkdownView } = await import("./MarkdownView");
const { default: PdfPreview } = await import("./PdfPreview");
const { default: StructuredDataPreview, isStructuredDataValue } = await import("./StructuredDataPreview");

/** Icon glyph classes live in the optional Tabler preset, not in styles.css. */
const isIconClass = (token: string) => token === "ti" || token.startsWith("ti-");
const hasRule = (token: string) => new RegExp(`\\.${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\w-])`).test(styles);

const classTokens = (html: string): string[] => {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1]!.split(/\s+/)) if (token) tokens.add(token);
  }
  return [...tokens];
};

/**
 * Deliberate marker classes: a component composes them onto an already-styled
 * base so consumers have something semantic to target. They carry no rules of
 * their own by design, so exempt them — but keep the list explicit and tiny,
 * because the whole point of this guard is that an unrecognised unstyled class
 * is a bug (that is how Cloud's Tailwind utilities went unnoticed).
 */
const HOOK_CLASSES = new Set(["k2b-copy-button"]);

const unstyled = (html: string) => classTokens(html).filter((token) => !isIconClass(token) && !HOOK_CLASSES.has(token) && !hasRule(token));
const foreign = (html: string) => classTokens(html).filter((token) => !isIconClass(token) && !/^(k2b-|cd-)/.test(token));

const content = { encoding: "utf8" as const, mediaType: "text/plain", content: "const answer = 42;\n" };

/** FileView loads its content through a resource — render it inside Suspense so SSR waits. */
const renderFileView = (props: Record<string, unknown>) =>
  renderToStringAsync(() =>
    createComponent(Suspense, {
      get children() {
        return createComponent(FileView, props as never);
      },
    }),
  );

describe("@k2b/ui content style coverage", () => {
  test("code, docs and markdown markup only uses classes the package styles", () => {
    const html = renderToString(() => [
      createComponent(CodeDisplay, { code: "const answer = 42;", language: "ts", title: "example.ts" }),
      createComponent(CodeDisplay, { code: "plain", copy: false, lineNumbers: false }),
      createComponent(DocPage, {
        children: [
          createComponent(DocLead, { children: "Lead" }),
          createComponent(DocSection, {
            title: "Section",
            eyebrow: "Eyebrow",
            children: createComponent(DocInlineCode, { children: "x" }),
          }),
          createComponent(DocCode, { code: "select 1", title: "query", copy: true, lineNumbers: true }),
          createComponent(DocConceptGrid, { items: [{ title: "Source", icon: "ti ti-code", text: "Exact" }] }),
          createComponent(DocRows, { items: [{ title: "Mode", icon: "ti ti-check", text: "Portable" }] }),
          createComponent(DocNote, { title: "Note", variant: "warning", children: "Careful" }),
        ],
      }),
      createComponent(MarkdownView, { trustedHtml: "<p>Body</p>", headingScale: "compact" }),
    ]);

    expect(unstyled(html)).toEqual([]);
    expect(foreign(html)).toEqual([]);
  });

  test("files, media and structured data markup only uses classes the package styles", async () => {
    const tree = renderToString(() =>
      createComponent(FileTree, {
        entries: [
          { path: "/src/app.ts", size: 4, badge: "new" },
          { path: "/README.md", size: 10 },
        ],
        selectedPath: "/README.md",
        actions: { download: () => {}, rename: () => {} },
      }),
    );
    const structured = renderToString(() => createComponent(StructuredDataPreview, { data: { ok: true }, title: "Payload" }));
    const structuredRaw = renderToString(() =>
      createComponent(StructuredDataPreview, { data: { ok: true }, defaultMode: "raw", copy: true }),
    );
    const pdf = renderToString(() =>
      createComponent(PdfPreview, { request: async () => new Blob([], { type: "application/pdf" }), title: "Report" }),
    );
    const lightbox = renderToString(() =>
      createComponent(Lightbox, { images: [{ src: "/a.png", alt: "A", downloadUrl: "/a.png" }, { src: "/b.png" }], onClose: () => {} }),
    );
    const source = await renderFileView({
      file: { path: "/src/app.ts", mediaType: "text/plain" },
      load: async () => content,
      save: async () => {},
      downloadHref: "/download",
    });
    const markdownFile = await renderFileView({
      file: { path: "/README.md", mediaType: "text/markdown" },
      load: async () => ({ encoding: "utf8" as const, mediaType: "text/markdown", content: "# Title\n\nBody\n" }),
      downloadHref: "/download",
    });

    for (const html of [tree, structured, structuredRaw, pdf, lightbox, source, markdownFile]) {
      expect(unstyled(html)).toEqual([]);
      expect(foreign(html)).toEqual([]);
    }
  });

  test("the source editor reuses the markdown editor chrome instead of a private one", async () => {
    const html = await renderFileView({
      file: { path: "/src/app.ts", mediaType: "text/plain" },
      load: async () => content,
      save: async () => {},
    });

    expect(html).toContain("k2b-markdown-editor");
    expect(html).toContain("k2b-markdown-editor__toolbar");
    expect(html).toContain("k2b-markdown-editor__surface");
    expect(html).toContain("k2b-content-file-view__code-input");
    expect(html).not.toContain("md-editor-toolbar");
  });

  test("syntax highlighting tokens emitted by CodeDisplay are styled", () => {
    const html = renderToString(() => createComponent(CodeDisplay, { code: 'const answer = "42"; // note', language: "ts" }));

    expect(html).toContain("cd-k");
    for (const token of ["cd-c", "cd-s", "cd-n", "cd-k", "cd-p", "cd-a", "cd-f", "cd-md-syntax", "cd-md-tag", "cd-md-formula"]) {
      expect(hasRule(token)).toBe(true);
    }
  });

  test("code and Markdown never turn untrusted source into executable markup", () => {
    const code = renderToString(() => createComponent(CodeDisplay, { code: '<img src=x onerror="alert(1)">', language: "text" }));
    const markdown = renderToString(() =>
      createComponent(MarkdownView, {
        markdown: '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(1))',
        inlineTokens: ['<img src=x onerror="alert(1)">', "unsafe"],
      }),
    );
    const trusted = renderToString(() => createComponent(MarkdownView, { trustedHtml: "<strong>Trusted</strong>" }));

    expect(code).not.toContain('<img src="x"');
    expect(code).toContain("&lt;img");
    expect(markdown).not.toContain('<img src="x"');
    expect(markdown).not.toContain('href="javascript:');
    expect(markdown).toContain('<span class="k2b-content-markdown__inline-token">unsafe</span>');
    expect(trusted).toContain("<strong>Trusted</strong>");
  });

  test("highlights only configured standalone Markdown text tokens", () => {
    const html = renderToString(() =>
      createComponent(MarkdownView, {
        markdown:
          "Hello @auth.name. Email support@auth.name or ignore @auth.name.extra and \\@auth.name. `@auth.name` [profile](/users/@auth.name) [@auth.name](/profile)",
        inlineTokens: ["@auth", "@auth.name"],
      }),
    );

    expect(html.match(/class="k2b-content-markdown__inline-token"/g)).toHaveLength(2);
    expect(html).toContain('<span class="k2b-content-markdown__inline-token">@auth.name</span>.');
    expect(html).toContain("support@auth.name");
    expect(html).toContain("@auth.name.extra");
    expect(html).toContain("<code>@auth.name</code>");
    expect(html).toContain('href="/users/@auth.name"');
  });
});

describe("@k2b/ui content behaviour", () => {
  test("FileBrowserPanel renders its standalone file workspace contract", () => {
    const html = renderToString(() =>
      createComponent(FileBrowserPanel, {
        source: {
          list: async () => [{ path: "/README.md", mediaType: "text/markdown" }],
          read: async () => ({ encoding: "utf8" as const, mediaType: "text/markdown", content: "# Readme" }),
        },
        initialPath: "/README.md",
      }),
    );

    expect(html).toContain("k2b-content-file-browser");
    expect(html).toContain("k2b-content-file-browser__sidebar");
    expect(html).toContain("Select a file");
  });

  test("FileBrowserPanel does not read an initially selected folder as a file", async () => {
    let reads = 0;
    const html = await renderToStringAsync(() =>
      createComponent(Suspense, {
        get children() {
          return createComponent(FileBrowserPanel, {
            source: {
              list: async () => [{ path: "/src", kind: "folder" as const }],
              read: async () => {
                reads += 1;
                return content;
              },
            },
            initialPath: "/src",
          });
        },
      }),
    );

    expect(html).toContain("Folder selected");
    expect(reads).toBe(0);
  });

  test("FileTree displays a label without replacing file identity", () => {
    const html = renderToString(() =>
      createComponent(FileTree, {
        entries: [{ path: "/recording.wav", displayName: "11.09.26, 13:42:00" }],
        selectedPath: "/recording.wav",
      }),
    );
    expect(html).toContain('aria-label="11.09.26, 13:42:00"');
    expect(html).toContain('data-state="selected"');
    expect(html).toContain('k2b-content-file-tree__name">11.09.26, 13:42:00');
  });

  test("FileTree keeps tree semantics, depth indentation and per-entry affordances", () => {
    const html = renderToString(() =>
      createComponent(FileTree, {
        entries: [
          { path: "/src/app.ts", size: 4, badge: "new" },
          { path: "/README.md", size: 10 },
        ],
        selectedPath: "/src/app.ts",
        actions: { rename: () => {}, remove: () => {} },
      }),
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-state="selected"');
    // Root entries sit at 6px, one level deeper at 6 + 14px.
    expect(html).toContain("padding-left:6px");
    expect(html).toContain("padding-left:20px");
    expect(html).toContain("new");
    expect(html).toContain("Actions for app.ts");
    const contextHost = /<div[^>]*class="k2b-content-file-tree__context-host"[^>]*>/.exec(html)?.[0] ?? "";
    expect(contextHost).toContain('role="group"');
    expect(contextHost).toContain('tabindex="-1"');
    expect(contextHost).not.toContain('role="button"');
    // Colour utilities from `fileIcons` are stripped — only the glyph survives.
    expect(html).not.toContain("text-blue-500");
  });

  test("FileView is read-only without `save` and gains the editor chrome with it", async () => {
    const readOnly = await renderFileView({ file: { path: "/src/app.ts", mediaType: "text/plain" }, load: async () => content });
    const editable = await renderFileView({
      file: { path: "/src/app.ts", mediaType: "text/plain" },
      load: async () => content,
      save: async () => {},
    });

    expect(readOnly).toContain("k2b-content-code-display");
    expect(readOnly).not.toContain("k2b-markdown-editor");
    expect(editable).toContain("k2b-markdown-editor");
    expect(editable).toContain("Save (Ctrl/Cmd+S)");
  });

  test("FileView renderer extensions are isolated per instance", async () => {
    const renderer = (id: string) => ({
      id,
      match: () => true,
      component: () => <div data-renderer={id}>{id}</div>,
    });
    const first = await renderFileView({
      file: { path: "/asset.custom", mediaType: "application/x-custom" },
      load: async () => content,
      renderers: [renderer("first")],
    });
    const second = await renderFileView({
      file: { path: "/asset.custom", mediaType: "application/x-custom" },
      load: async () => content,
      renderers: [renderer("second")],
    });

    expect(first).toContain('data-renderer="first"');
    expect(first).not.toContain('data-renderer="second"');
    expect(second).toContain('data-renderer="second"');
    expect(second).not.toContain('data-renderer="first"');
  });

  test("FileView renders markdown previews without frontmatter and offers the download action", async () => {
    const html = await renderFileView({
      file: { path: "/notes.md", mediaType: "text/markdown" },
      load: async () => ({ encoding: "utf8" as const, mediaType: "text/markdown", content: "---\ntitle: Hidden\n---\n\n# Visible\n" }),
      downloadHref: "/files/notes.md",
    });

    const rendered = /<div class="k2b-content-markdown[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(rendered).toContain("<h1>Visible</h1>");
    expect(rendered).not.toContain("title: Hidden");
    expect(html).toContain('href="/files/notes.md"');
    expect(html).toContain('data-heading-scale="compact"');
  });

  test("StructuredDataPreview caps rows and reports the remainder", () => {
    const html = renderToString(() => createComponent(StructuredDataPreview, { data: { a: 1, b: 2, c: 3 }, maxRows: 1 }));

    expect(html).toContain("2 more rows hidden.");
    expect(html).toContain("View raw");
  });

  test("StructuredDataPreview accepts only finite, acyclic JSON values", () => {
    expect(isStructuredDataValue({ ok: true, values: [1, null, "ready"] })).toBe(true);
    expect(isStructuredDataValue({ invalid: Number.NaN })).toBe(false);
    expect(isStructuredDataValue(new Date())).toBe(false);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isStructuredDataValue(cyclic)).toBe(false);
  });

  test("DocNote exposes its variant as data instead of palette classes", () => {
    const html = renderToString(() => createComponent(DocNote, { title: "Careful", variant: "warning", children: "Body" }));

    expect(html).toContain('data-variant="warning"');
    expect(html).not.toContain("amber");
  });
});
