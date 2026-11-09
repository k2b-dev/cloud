import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-section-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Field, Section } = await import("./Section");
const { LocaleProvider } = await import("../intl/locale");

const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1];
};

describe("Section", () => {
  test("is a named region with a heading; a page section is one level up and draws a neutral tile", () => {
    const panel = renderToString(() => createComponent(Section, { title: "Customer", icon: "ti ti-user", children: "K-10482" }));
    const page = renderToString(() => createComponent(Section, { title: "Details", icon: "ti ti-id", size: "md", children: "Born 1961" }));

    expect(panel).toMatch(
      /<section class="k2b-section[^"]*" data-size="sm" data-frame="line" data-icon="true" aria-labelledby="(k2b-section-[^"]+-title)"/,
    );
    expect(panel).toMatch(/<h3[^>]*id="k2b-section-[^"]+-title"[^>]*>Customer<\/h3>/);
    expect(page).toContain('data-size="md"');
    expect(page).toMatch(/<h2[^>]*>Details<\/h2>/);
    expect(rule('.k2b-ui .k2b-section[data-size="md"] > .k2b-section__header .k2b-section__icon')).toContain(
      "background: var(--k2b-surface-muted)",
    );
  });

  test("names tones after the status tokens and marks restricted visibility with a lock and words", () => {
    const html = renderToString(() =>
      createComponent(Section, {
        title: "Reports",
        icon: "ti ti-chart-bar",
        restricted: "Only with permission",
        tone: "ai",
        children: "…",
      }),
    );

    expect(html).toContain('data-tone="ai"');
    // The marker is part of the region's name, so a screen reader hears "Reports, Only with permission".
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(" ");
    expect(labelledBy).toHaveLength(2);
    expect(html).toContain(
      `<span class="k2b-section__restricted" id="${labelledBy?.[1]}"><i class="ti ti-lock" aria-hidden="true"></i>Only with permission</span>`,
    );
    for (const [tone, token] of [
      ["success", "--k2b-success-text"],
      ["warning", "--k2b-warning-text"],
      ["danger", "--k2b-danger-text"],
      ["info", "--k2b-info-text"],
      ["ai", "--k2b-ai-accent"],
    ]) {
      expect(rule(`.k2b-ui .k2b-section[data-tone="${tone}"]`)).toContain(`--k2b-section-tone: var(${token})`);
    }
    // A tone colours the frame, never the fill.
    expect(rule('.k2b-ui .k2b-section[data-tone][data-frame="line"]')).toContain("border-color");
    expect(css).not.toMatch(/\.k2b-section\[data-tone[^{]*\{[^}]*background:/);
  });

  test("is a card on a page, flat in a detail panel, and never a card inside another frame", async () => {
    const { default: DetailPanel } = await import("../layout/DetailPanel");
    const page = renderToString(() => createComponent(Section, { title: "Details", size: "md", children: "…" }));
    const panel = renderToString(() =>
      createComponent(DetailPanel, {
        get children() {
          return createComponent(Section, { title: "Customer", children: "…" });
        },
      }),
    );
    const feedbackCss = await Bun.file(resolve(import.meta.dir, "../styles/feedback-parity.css")).text();
    const flatten = css.match(/\.k2b-ui\s*:is\(\s*(\.k2b-section,[^)]*)\)\s*\.k2b-section\[data-frame="line"\] \{([^}]*)\}/);
    const paperBorder = (await Bun.file(resolve(import.meta.dir, "../styles/surfaces-widgets-parity.css")).text()).match(
      /\.k2b-ui \.k2b-paper \{[^}]*?(border: [^;]+);/,
    )?.[1];

    expect(page).toContain('data-frame="line"');
    expect(panel).toContain('data-frame="none"');
    // The card is Paper's light frame and an island: shadow and surface come only from the layer hooks.
    expect(rule('.k2b-ui .k2b-section[data-frame="line"]')).toContain(paperBorder!);
    expect(rule('.k2b-ui .k2b-section[data-frame="line"]')).toContain("box-shadow: var(--k2b-island-shadow)");
    expect(rule('.k2b-ui .k2b-section[data-frame="line"]')).toContain("background: var(--k2b-island-surface)");
    for (const host of [
      ".k2b-section",
      ".k2b-detail-panel__group",
      ".k2b-detail-panel__summary",
      ".k2b-paper",
      ".k2b-panel-dialog",
      ".k2b-settings-section",
    ]) {
      expect(flatten?.[1]).toContain(host);
    }
    expect(flatten?.[2]).toContain("border: 0;");
    expect(feedbackCss).toMatch(/\.k2b-ui \.k2b-dialog \.k2b-section\[data-frame="line"\] \{[^}]*border: 0;/);
  });

  test("collapses as one disclosure button inside the heading; closed, the body is hidden", () => {
    const html = renderToString(() =>
      createComponent(Section, {
        title: "Activity",
        icon: "ti ti-history",
        collapsible: true,
        summary: "Paul uploaded a new version",
        children: "Rows",
      }),
    );

    expect(html).toMatch(
      /<h3[^>]*class="k2b-section__header[^"]*"[^>]*><button type="button" class="k2b-section__toggle" aria-expanded="false" aria-controls="(k2b-section-[^"]+-body)"/,
    );
    expect(html).toMatch(/<div id="k2b-section-[^"]+-body" class="k2b-section__body" hidden/);
    expect(html).toContain('class="k2b-section__summary k2b-truncate-fade">Paul uploaded a new version');
    expect(html).toContain('data-open="false"');
  });

  test("loading and error take the body's place with a way out; the heading stays", () => {
    const loading = renderToString(() =>
      createComponent(Section, { title: "Customer", state: "loading", loadingRows: 4, children: "never" }),
    );
    const error = renderToString(() =>
      createComponent(Section, {
        title: "Files",
        state: "error",
        errorMessage: "Files could not load.",
        onRetry: () => {},
        children: "never",
      }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(loading.match(/k2b-section__skeleton-row/g)).toHaveLength(4);
    expect(loading).not.toContain("never");
    expect(error).toContain('role="alert"');
    expect(error).toContain("Files could not load.");
    expect(error).toContain("ti-refresh");
    expect(error).not.toContain("never");
    // A placeholder row is as tall as a loaded row.
    expect(rule(".k2b-ui .k2b-section__skeleton-row")).toContain("height: 2.25rem");
    expect(rule(".k2b-ui .k2b-field-row")).toContain("min-height: 2.25rem");
  });

  test("parts are sub-topics one heading level down without a frame, and the footer ends the body", () => {
    const html = renderToString(() =>
      createComponent(Section, {
        title: "Details",
        size: "md",
        footer: "Edit all",
        get children() {
          return [
            createComponent(Section.Part, { title: "Person", children: "Born" }),
            createComponent(Section.Part, { title: "Contact", children: "Mobile" }),
          ];
        },
      }),
    );

    expect(html.match(/<div class="k2b-section__part[^"]*" role="group" aria-labelledby="[^"]+"><h3/g)).toHaveLength(2);
    // A panel section is an h3, so its parts are h4: the level reaches the parts before they are built.
    const small = renderToString(() =>
      createComponent(Section, {
        title: "Customer",
        get children() {
          return createComponent(Section.Part, { title: "Contact", children: "Mobile" });
        },
      }),
    );
    expect(small).toMatch(/role="group" aria-labelledby="[^"]+"><h4/);
    expect(html).toMatch(/Mobile<\/div><div class="k2b-section__footer">Edit all<\/div>/);
  });
});

describe("Field", () => {
  test("puts the label left and the value right, breaks an address only after its @, and copies", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return [
            createComponent(Field, { label: "E-Mail", value: "marlene.hofbauer@posteo.de", kind: "email", copy: true }),
            createComponent(Field, { label: "Datei-ID", value: "fl_8KQ2M7…", copy: "fl_8KQ2M7XW4N9PT6" }),
            createComponent(Field, { label: "Hinweis", layout: "stack", children: "Holt samstags selbst ab." }),
          ];
        },
      }),
    );

    expect(html).toContain(
      '<a href="mailto:marlene.hofbauer@posteo.de"><span class="k2b-field-row__nowrap">marlene.hofbauer@</span><wbr><span class="k2b-field-row__nowrap">posteo.de</span></a>',
    );
    expect(html).toContain('aria-label="E-Mail kopieren"');
    // A shortened value shows its full form in the hint.
    expect(html).toContain('title="fl_8KQ2M7XW4N9PT6"');
    expect(html).toContain('data-layout="stack"');
    expect(rule('.k2b-ui .k2b-field-row[data-layout="stack"] .k2b-field-row__text')).toContain("white-space: normal");
  });
});
