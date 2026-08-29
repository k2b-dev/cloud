import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { FileBaseInfo, FileInfo } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "files-detail-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: FileDetailPanel }, { LocaleProvider }] = await Promise.all([import("./FileDetailPanel.island.tsx"), import("@k2b/ui")]);

const bases: FileBaseInfo[] = [{ type: "home", id: "ada", name: "Ada" }];
const file: FileInfo = {
  name: "quarterly report.pdf",
  path: "/reports/quarterly report.pdf",
  type: "file",
  size: 4096,
  mtime: "2026-08-09T10:00:00.000Z",
  isHidden: false,
  mimeType: "application/pdf",
};

const renderPanel = (item: FileInfo, overrides: Partial<Parameters<typeof FileDetailPanel>[0]> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(FileDetailPanel, {
          initialFile: item,
          initialFilePath: item.path,
          initialBaseType: "home",
          initialBaseId: "ada",
          items: [item],
          bases,
          showEmpty: false,
          ...overrides,
        });
      },
    }),
  );

const legacyDetailClasses = [
  'class="detail-stack',
  'class="detail-section',
  'class="detail-section-label',
  'class="detail-facts',
  'class="detail-fact-key',
];

describe("File detail panel", () => {
  test("uses the shared panel contract with one scroll owner", () => {
    const html = renderPanel(file);

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain('<h2><span class="break-all">quarterly report.pdf</span></h2>');
    expect(html).toContain("[view-transition-name:files-detail-panel]");
    expect(html).toContain('data-scroll-preserve="files-detail-home-ada-%2Freports%2Fquarterly%20report.pdf"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain("~/reports/quarterly report.pdf");
    expect(html).toContain("PDF Document");
    expect(html).toContain("4 KiB");
    expect(html).toContain('aria-label="Close file detail panel"');
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("preserves file action labels, order, and destructive emphasis", () => {
    const html = renderPanel(file);
    const labels = ["Preview", "Download", "Rename", "Duplicate", "Move to...", "Open in new tab", "Delete"];

    let previousIndex = -1;
    for (const label of labels) {
      const index = html.indexOf(label);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(html).not.toContain("Show detail");
    expect(html).toContain('title="Delete"');
    expect(html).toContain('data-variant="danger"');
    expect(html).toContain("k2b-detail-panel__action");
  });

  test("keeps directory facts and commands conditional", () => {
    const directory: FileInfo = {
      name: "Invoices",
      path: "/Invoices",
      type: "directory",
      size: 0,
      mtime: "2026-08-09T10:00:00.000Z",
      isHidden: false,
    };
    const html = renderPanel(directory, { bases: [] });

    expect(html).toContain("Open folder");
    expect(html).toContain("Download .tar");
    expect(html).not.toContain("Open in new tab");
    expect(html).not.toContain("Move to...");
    expect(html).not.toContain("<dt>Size</dt>");
    expect(html).toContain("<dt>Kind</dt><dd>Folder</dd>");
  });

  test("renders the inherited German locale", () => {
    const html = renderPanel(file, {}, "de-DE");

    expect(html).toContain("PDF-Dokument");
    expect(html).toContain("Vorschau");
    expect(html).toContain("Herunterladen");
    expect(html).toContain("Umbenennen");
    expect(html).toContain("Duplizieren");
    expect(html).toContain("Verschieben nach…");
    expect(html).toContain("In neuem Tab öffnen");
    expect(html).toContain("Löschen");
    expect(html).toContain("<dt>Pfad</dt>");
    expect(html).toContain("<dt>Typ</dt>");
  });
});
