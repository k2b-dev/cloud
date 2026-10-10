import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { PanesLayout } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ComposePreview } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "mail-composer-editor-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MailComposerEditor }, { LocaleProvider }] = await Promise.all([import("./MailComposerEditor.tsx"), import("@k2b/ui")]);
const History = () => "Earlier message";

const panes = (active: string, ...items: string[]): PanesLayout => ({
  version: 2,
  root: { type: "group", items, active },
});

const renderEditor = (
  format: "plain" | "markdown",
  value: PanesLayout,
  history = false,
  preview: ComposePreview | null = null,
  options: { locale?: "en" | "de"; previewError?: string } = {},
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return createComponent(MailComposerEditor, {
          format: () => format,
          body: () => "Draft body",
          onBodyInput: () => undefined,
          editable: () => true,
          completions: () => [],
          panes: () => value,
          onPanesChange: () => undefined,
          preview: () => preview,
          previewError: () => options.previewError,
          previewPending: () => false,
          onRetryPreview: () => undefined,
          onEditorReady: () => undefined,
          history: history ? () => createComponent(History, {}) : undefined,
        });
      },
    }),
  );

describe("MailComposerEditor", () => {
  test("adds conversation history beside the plain-text editor", () => {
    const html = renderEditor("plain", panes("history", "editor", "history"), true);

    expect(html).toContain("Write");
    expect(html).toContain("History");
    expect(html).toContain("Earlier message");
    expect(html).not.toContain("Preview");
  });

  test("keeps a standalone plain-text message as a single editor", () => {
    const html = renderEditor("plain", panes("editor", "editor"));

    expect(html).toContain('aria-label="Message body"');
    expect(html).not.toContain("History");
    expect(html).not.toContain("Preview");
  });

  test("keeps preview and adds history for a Markdown conversation", () => {
    const html = renderEditor("markdown", panes("preview", "editor", "preview", "history"), true);

    expect(html).toContain("Write");
    expect(html).toContain("Preview");
    expect(html).toContain("History");
    expect(html).toContain("Preparing preview...");
    expect(html).not.toContain("Earlier message");
    expect(html).not.toContain("Updating");
  });

  test("removes the browser body margin from the HTML preview", () => {
    const html = renderEditor("markdown", panes("preview", "preview"), false, { html: "<p>Preview body</p>", text: "Preview body" });

    expect(html).toContain("body{margin:0}");
    expect(html).toContain("Preview body");
  });

  test("shows a failed preview in place of the outdated one, with its reason and a retry, in English and German", () => {
    const outdated = { html: "<p>Outdated preview</p>", text: "Outdated preview" };
    const english = renderEditor("markdown", panes("preview", "preview"), false, outdated, {
      previewError: "This message is too complex to render safely. Shorten it or simplify its formatting.",
    });
    expect(english).toContain('role="alert"');
    expect(english).toContain("Preview could not be rendered");
    expect(english).toContain("This message is too complex to render safely.");
    expect(english).toContain(">Retry<");
    expect(english).not.toContain("Outdated preview");

    const german = renderEditor("markdown", panes("preview", "preview"), false, outdated, {
      locale: "de",
      previewError: "Diese Nachricht ist zu komplex, um sie sicher darzustellen. Kürze sie oder vereinfache die Formatierung.",
    });
    expect(german).toContain("Die Vorschau konnte nicht erstellt werden");
    expect(german).toContain("Diese Nachricht ist zu komplex");
    expect(german).toContain(">Erneut versuchen<");
    expect(german).not.toContain("Outdated preview");
  });

  test("does not repeat the generic preview failure as its own reason", () => {
    const html = renderEditor("markdown", panes("preview", "preview"), false, null, { previewError: "Preview could not be rendered" });
    expect(html.match(/Preview could not be rendered/g)).toHaveLength(1);
  });
});
