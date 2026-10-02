import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-detail-panel-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: DetailPanel } = await import("./DetailPanel");

describe("DetailPanel", () => {
  test("renders a compact header, one scroll owner, and semantic flat sections", () => {
    const html = renderToString(() =>
      createComponent(DetailPanel, {
        get children() {
          return [
            createComponent(DetailPanel.Header, {
              leading: "Avatar",
              title: "Invoice review",
              subtitle: "Conversation details",
              meta: "Needs action",
              actions: "Close",
              primaryActions: "Reply",
            }),
            createComponent(DetailPanel.Body, {
              scrollPreserveKey: "mail-detail",
              get children() {
                return [
                  createComponent(DetailPanel.Summary, {
                    title: "Overview",
                    actions: "Edit",
                    children: "Status and assignee",
                  }),
                  createComponent(DetailPanel.Section, {
                    title: "Workflow",
                    description: "No workflow context yet",
                    meta: "0",
                    actions: "Edit",
                  }),
                  createComponent(DetailPanel.Section, {
                    title: "Technical details",
                    collapsible: true,
                    defaultOpen: true,
                    children: "Message ID",
                  }),
                ];
              },
            }),
          ];
        },
      }),
    );

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Invoice review</h2>");
    expect(html).toContain('class="k2b-detail-panel__header-leading"');
    expect(html).toContain('class="k2b-detail-panel__supporting"');
    expect(html).toContain('class="k2b-detail-panel__meta"');
    expect(html).toContain('class="k2b-detail-panel__primary-actions"');
    expect(html).not.toContain("k2b-detail-panel__icon");
    expect(html).toContain('data-scroll-preserve="mail-detail"');
    expect(html).toMatch(/<section class="k2b-detail-panel__summary"[^>]+aria-labelledby="k2b-detail-panel-summary-[^"]+"/);
    expect(html).toContain("<h3 id=");
    expect(html).toMatch(/<section[^>]+aria-labelledby="k2b-detail-panel-section-[^"]+"/);
    expect(html).toContain("No workflow context yet");
    expect(html).toContain('class="k2b-detail-panel__section-meta">0</div>');
    expect(html).toContain('data-open="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="k2b-detail-panel-section-');
    expect(html).not.toContain("paper");
  });

  test("keeps the panel and its sections free of card-per-group styling", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const panelRule = css.match(/\.k2b-ui \.k2b-detail-panel \{([^}]*)\}/)?.[1];
    const headerRule = css.match(/\.k2b-ui \.k2b-detail-panel__header \{([^}]*)\}/)?.[1];
    const sectionRule = css.match(/\.k2b-ui section\.k2b-detail-panel__section \{([^}]*)\}/)?.[1];
    const summaryRule = css.match(/\.k2b-ui \.k2b-detail-panel__summary \{([^}]*)\}/)?.[1];
    const bodyRule = css.match(/\.k2b-ui \.k2b-detail-panel__body \{([^}]*)\}/)?.[1];

    expect(panelRule).not.toContain("background");
    expect(sectionRule).not.toContain("border");
    expect(sectionRule).not.toContain("background");
    expect(sectionRule).not.toContain("box-shadow");
    expect(summaryRule).toContain("background: var(--k2b-surface)");
    expect(summaryRule).not.toContain("box-shadow");
    expect(headerRule).toContain("padding: 0.875rem 0 0.75rem");
    expect(bodyRule).toContain("overflow-y: auto");
    expect(bodyRule).toContain("scrollbar-gutter: stable");
    expect(bodyRule).toContain("padding: 0.5rem 0 1rem");
  });

  test("absorbs its stable scrollbar gutter into the workspace trailing inset", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const layoutCss = await Bun.file(resolve(import.meta.dir, "../styles/layout-parity.css")).text();
    const panelRule = css.match(/\.k2b-ui \.k2b-detail-panel \{([^}]*)\}/)?.[1];
    const headerRule = css.match(/\.k2b-ui \.k2b-detail-panel__header \{([^}]*)\}/)?.[1];
    const bodyRule = css.match(/\.k2b-ui \.k2b-detail-panel__body \{([^}]*)\}/)?.[1];
    const workspaceDetailRule = layoutCss.match(/\.k2b-ui \.k2b-app-workspace__detail \{([^}]*)\}/)?.[1];

    expect(workspaceDetailRule).toContain("--k2b-detail-panel-scroll-inset: 0.75rem");
    expect(panelRule).toContain("width: calc(100% + var(--k2b-detail-panel-scroll-inset, 0rem))");
    expect(panelRule).toContain("margin-inline-end: calc(-1 * var(--k2b-detail-panel-scroll-inset, 0rem))");
    expect(headerRule).toContain("padding-inline-end: var(--k2b-detail-panel-scroll-inset, 0rem)");
    expect(bodyRule).toContain("scrollbar-gutter: stable");
  });

  test("keeps the host inset on touch devices whose overlay scrollbars reserve no gutter", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const coarseRule = css.match(/@media \(pointer: coarse\) \{\s*\.k2b-ui \.k2b-detail-panel \{([^}]*)\}/)?.[1];

    expect(coarseRule).toContain("--k2b-detail-panel-scroll-inset: 0rem");
  });

  test("groups related sections and keeps semantic section icons color-only", async () => {
    const html = renderToString(() =>
      createComponent(DetailPanel, {
        get children() {
          return [
            createComponent(DetailPanel.Header, {
              icon: "ti ti-notes",
              title: "Welcome",
            }),
            createComponent(DetailPanel.Body, {
              get children() {
                return createComponent(DetailPanel.Group, {
                  label: "Document context",
                  get children() {
                    return [
                      createComponent(DetailPanel.Section, {
                        title: "Contents",
                        icon: "ti ti-list-tree",
                        tone: "accent",
                        children: "Outline",
                      }),
                      createComponent(DetailPanel.Section, {
                        title: "Versions",
                        icon: "ti ti-history",
                        tone: "warning",
                        meta: "12",
                        collapsible: true,
                        children: "History",
                      }),
                    ];
                  },
                });
              },
            }),
          ];
        },
      }),
    );
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const groupRule = css.match(/\.k2b-ui \.k2b-detail-panel__group \{([^}]*)\}/)?.[1];
    const groupedSectionRule = css.match(/\.k2b-ui \.k2b-detail-panel__group > \.k2b-detail-panel__section \{([^}]*)\}/)?.[1];
    const summaryRule = css.match(/\.k2b-ui \.k2b-detail-panel__summary \{([^}]*)\}/)?.[1];
    const sectionIconRule = css.match(/\.k2b-ui \.k2b-detail-panel__section-icon \{([^}]*)\}/)?.[1];

    expect(html).toContain('class="k2b-detail-panel__header-icon"');
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Document context"');
    expect(html).toContain('class="k2b-detail-panel__section-icon" data-tone="accent"');
    expect(html).toContain('class="k2b-detail-panel__section-icon" data-tone="warning"');
    // One quiet surface like the summary: no border, no 1px rules between sections.
    expect(groupRule).not.toContain("gap: 1px");
    expect(groupRule).not.toContain("border:");
    expect(groupRule?.match(/background: ([^;]+);/)?.[1]).toBe(summaryRule?.match(/background: ([^;]+);/)?.[1]);
    expect(groupedSectionRule).not.toContain("background");
    expect(sectionIconRule).not.toContain("background");
  });

  test("renders shared actions with native link and button semantics", () => {
    const html = renderToString(() =>
      createComponent(DetailPanel, {
        get children() {
          return [
            createComponent(DetailPanel.Action, {
              href: "/files/invoice.pdf",
              target: "_blank",
              rel: "noopener noreferrer",
              download: "invoice.pdf",
              leading: "PDF",
              title: "invoice.pdf",
              trailing: "Download",
              menuLabel: "More actions for invoice.pdf",
              menuItems: [{ label: "Open folder", href: "/files", external: true }],
            }),
            createComponent(DetailPanel.Action, {
              onClick: () => undefined,
              title: "Open resources",
              description: "18 items",
            }),
          ];
        },
      }),
    );

    expect(html).toMatch(/<a[^>]+href="\/files\/invoice\.pdf"/);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("download");
    expect(html).toContain('<button type="button"');
    expect(html.match(/class="k2b-button k2b-detail-panel__action ?"/g)).toHaveLength(2);
    expect(html).toContain('class="k2b-detail-panel__action-row"');
    expect(html).toContain('aria-label="More actions for invoice.pdf"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toMatch(/<a[^>]*>[^<]*<button/s);
    expect(html).toContain('class="k2b-detail-panel__action-leading"');
    expect(html).toContain('class="k2b-detail-panel__action-description"');
    expect(html).toContain('class="k2b-detail-panel__action-trailing"');
  });

  test("renders a secondary action as a named sibling button before the menu", () => {
    const html = renderToString(() =>
      createComponent(DetailPanel.Action, {
        onClick: () => undefined,
        title: "report.pdf",
        secondaryAction: { icon: "ti ti-trash", label: "Delete report.pdf", variant: "danger", onClick: () => undefined },
        menuLabel: "More actions for report.pdf",
        menuItems: [{ label: "Download", action: () => undefined }],
      }),
    );

    const row = html.match(/<div class="k2b-detail-panel__action-row">([\s\S]*)<\/div>/)?.[1] ?? "";
    const secondary = row.match(/<button[^>]*k2b-detail-panel__action-secondary[^>]*>/)?.[0] ?? "";
    expect(secondary).toContain('aria-label="Delete report.pdf"');
    expect(secondary).toContain('data-tone="danger"');
    expect(row).toContain('<i class="ti ti-trash" aria-hidden="true"');
    expect(row.indexOf("k2b-detail-panel__action-secondary")).toBeLessThan(row.indexOf("k2b-detail-panel__action-menu-trigger"));
    // The main row button closes before the secondary button starts: no nested controls.
    expect(row.indexOf("k2b-detail-panel__action-secondary")).toBeGreaterThan(row.indexOf("</button>"));
  });

  test("owns action interaction states and compact description typography", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();

    expect(css).toContain(".k2b-ui .k2b-detail-panel__action {");
    const actionRule = css.match(/\.k2b-ui \.k2b-button\.k2b-detail-panel__action \{([^}]*)\}/)?.[1] ?? "";
    expect(actionRule).toContain("color: var(--k2b-text-muted);");
    expect(actionRule).toContain("background: transparent;");
    const actionHoverRule = css.match(/\.k2b-ui \.k2b-button\.k2b-detail-panel__action:not\(:disabled\):hover,[^{]+\{([^}]*)\}/)?.[1] ?? "";
    expect(actionHoverRule).toContain("color: var(--k2b-detail-panel-accent, var(--k2b-action));");
    expect(actionHoverRule).toContain("background: transparent;");
    const menuHoverRule =
      css.match(/\.k2b-ui \.k2b-button\.k2b-detail-panel__action-menu-trigger:not\(:disabled\):hover,[^{]+\{([^}]*)\}/)?.[1] ?? "";
    expect(menuHoverRule).toContain("color: var(--k2b-detail-panel-accent, var(--k2b-action));");
    expect(menuHoverRule).toContain("background: transparent;");
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.k2b-detail-panel__action-menu-trigger \{[^}]*opacity: 0/);
    expect(css).toContain(".k2b-detail-panel__action-row:focus-within .k2b-detail-panel__action-menu-trigger");
    expect(css).toContain('.k2b-detail-panel__action-menu-trigger[aria-expanded="true"]');
    // The secondary action shares the progressive reveal; touch devices without hover always see it.
    const fineHidden =
      css.match(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.k2b-ui \.k2b-detail-panel__action-secondary,[^{]+\{([^}]*)\}/)?.[1] ??
      "";
    expect(fineHidden).toContain("opacity: 0;");
    expect(css).toContain(".k2b-detail-panel__action-row:hover .k2b-detail-panel__action-secondary");
    expect(css).toContain(".k2b-detail-panel__action-row:focus-within .k2b-detail-panel__action-secondary");
    expect(css).not.toMatch(/\.k2b-detail-panel__action-secondary[^{]*\{[^}]*transform/);
    const dangerRule =
      css.match(
        /\.k2b-ui \.k2b-button\.k2b-detail-panel__action-secondary\[data-tone="danger"\]:not\(:disabled\):hover,[^{]+\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(dangerRule).toContain("color: var(--k2b-danger-text);");
    const leadingRule = css.match(/\.k2b-ui \.k2b-detail-panel__action-leading \{([^}]*)\}/)?.[1] ?? "";
    expect(leadingRule).toContain("width: 1rem;");
    expect(leadingRule).toContain("justify-content: flex-start;");
    expect(leadingRule).toContain("color: inherit;");
    const titleRule = css.match(/\.k2b-ui \.k2b-detail-panel__action-title \{([^}]*)\}/)?.[1] ?? "";
    expect(titleRule).toContain("color: inherit;");
    expect(titleRule).toContain("font-size: 0.75rem;");
    expect(css).toContain('.k2b-ui .k2b-description-list[data-size="sm"] .k2b-description-list__item dt');
    expect(css).toContain('.k2b-description-list[data-action-visibility="progressive"]');
    expect(css).toContain(".k2b-description-list__item:focus-within");
    expect(css).toContain('grid-template-areas: "term description action";');
    expect(css).toContain("grid-template-columns: subgrid;");
    expect(css).toContain("grid-template-rows: minmax(2.25rem, auto);");
    expect(css).toContain("align-content: stretch;");
    expect(css).toContain("grid-template-columns: minmax(5.75rem, 7rem) minmax(0, 1fr) auto;");
    expect(css).toContain("text-transform: uppercase;");
    expect(css).toContain("var(--k2b-detail-panel-accent, var(--k2b-accent-600))");
    expect(css).toContain("font-weight: 400;");
  });
});
