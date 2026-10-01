import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// Borders, rules and wrapping are layout, which happy-dom does not model, so a
// real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-single-frame-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Button } = await import("../actions/Button");
const { default: DetailPanel } = await import("../layout/DetailPanel");
const { SettingsField, SettingsPage, SettingsSection } = await import("../layout/Settings");
const { NoticeCard } = await import("./NoticeCard");
const { Paper } = await import("./Paper");
const { default: Placeholder } = await import("./Placeholder");
const { StatCell } = await import("./StatCell");
const { StatGrid } = await import("./StatGrid");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const viewports = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const field = (label: string) =>
  createComponent(SettingsField, { label, description: "Shown on the public page.", error: undefined, children: "Value" });

const markup = () =>
  renderToString(() => [
    createComponent(SettingsPage, {
      title: "Project settings",
      subtitle: "Identity and defaults",
      get children() {
        return [
          createComponent(SettingsSection, {
            title: "Identity",
            subtitle: "Name and contact details that people see in every message.",
            icon: "ti ti-id",
            get actions() {
              return createComponent(Button, { size: "sm", variant: "secondary", children: "Test connection" });
            },
            get children() {
              return [
                createComponent(NoticeCard, { tone: "warning", title: "Review needed", detail: "Two records have no owner." }),
                field("Name"),
                field("Contact"),
              ];
            },
          }),
          createComponent(SettingsSection, {
            title: "Webhooks",
            get children() {
              return createComponent(Placeholder, { surface: "paper", description: "No webhooks yet", class: "nested-placeholder" });
            },
          }),
        ];
      },
    }),
    createComponent(Placeholder, { surface: "paper", description: "No projects yet", class: "standalone-placeholder" }),
    createComponent(Paper, {
      get children() {
        return createComponent(Placeholder, { surface: "paper", description: "No members yet", class: "paper-placeholder" });
      },
    }),
    createComponent(DetailPanel, {
      get children() {
        return createComponent(DetailPanel.Body, {
          get children() {
            return [
              createComponent(DetailPanel.Summary, { title: "Planning", children: "Due tomorrow" }),
              createComponent(DetailPanel.Group, {
                label: "Work",
                get children() {
                  return [
                    createComponent(DetailPanel.Section, { title: "Checklist", children: "Three items" }),
                    createComponent(DetailPanel.Section, { title: "Attachments", children: "None" }),
                  ];
                },
              }),
            ];
          },
        });
      },
    }),
    createComponent(StatGrid, {
      columns: 2,
      get children() {
        return createComponent(StatCell, { label: "Expiring in 30 days", value: 4 });
      },
    }),
  ]);

const open = async (viewport: { width: number; height: number }, theme: "light" | "dark") => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}" style="margin:0;padding:1rem;background:var(--k2b-surface-muted)">` +
      `<div style="display:flex;height:40rem;flex-direction:column">${markup()}</div></body></html>`,
  );
  return page;
};

/** The frame each surface draws and where the section heading and its actions sit. */
const measure = () => {
  const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const frame = (selector: string) => {
    const value = style(selector);
    return { border: value.borderTopStyle === "none" ? "none" : value.borderTopColor, background: value.backgroundColor };
  };
  const sections = Array.from(document.querySelectorAll(".k2b-detail-panel__group > .k2b-detail-panel__section"));
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    section: { ...frame(".k2b-settings-section"), shadow: style(".k2b-settings-section").boxShadow },
    sectionHeaderRule: style(".k2b-settings-section__header").borderBottomStyle,
    fieldRules: Array.from(document.querySelectorAll(".k2b-settings-field")).map((element) => getComputedStyle(element).borderTopStyle),
    heading: box(".k2b-settings-section__heading").bottom,
    actions: box(".k2b-settings-section__actions").top,
    notice: frame(".k2b-notice-card"),
    noticeDetailSize: style(".k2b-notice-card__description").fontSize,
    noticeDetailOpacity: style(".k2b-notice-card__description").opacity,
    nestedPlaceholder: frame(".nested-placeholder"),
    paperPlaceholder: { ...frame(".paper-placeholder"), shadow: style(".paper-placeholder").boxShadow },
    standalonePlaceholder: frame(".standalone-placeholder"),
    group: frame(".k2b-detail-panel__group"),
    groupedSections: sections.map((element) => getComputedStyle(element).backgroundColor),
    groupGap: sections[1]!.getBoundingClientRect().top - sections[0]!.getBoundingClientRect().bottom,
    statLabel: { transform: style(".k2b-stat-cell__label").textTransform, tracking: style(".k2b-stat-cell__label").letterSpacing },
  };
};

const transparent = "rgba(0, 0, 0, 0)";

describe("@k2b/ui one frame per surface", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      test(`settings sections, notices, placeholders and detail groups draw no second frame on a ${name} in ${theme} mode`, async () => {
        const page = await open(viewport, theme);
        try {
          const result = await page.evaluate(measure);
          expect(result.overflow).toBeLessThanOrEqual(0);

          expect(result.section).toEqual({ border: "none", background: transparent, shadow: "none" });
          expect(result.sectionHeaderRule).toBe("none");
          expect(result.fieldRules).toEqual(["none", "none"]);

          expect(result.notice.border).toBe(transparent);
          expect(result.notice.background).not.toBe(transparent);
          expect(result.noticeDetailSize).toBe("12px");
          expect(result.noticeDetailOpacity).toBe("1");

          expect(result.nestedPlaceholder).toEqual({ border: transparent, background: transparent });
          expect(result.paperPlaceholder).toEqual({ border: transparent, background: transparent, shadow: "none" });
          expect(result.standalonePlaceholder.border).not.toBe(transparent);
          expect(result.standalonePlaceholder.background).not.toBe(transparent);

          expect(result.group.border).toBe("none");
          expect(result.groupedSections).toEqual([transparent, transparent]);
          expect(result.groupGap).toBe(0);

          expect(result.statLabel).toEqual({ transform: "none", tracking: "normal" });

          // Actions share the heading row on a desktop and wrap below it on a phone.
          if (name === "phone") expect(result.actions).toBeGreaterThanOrEqual(result.heading);
          else expect(result.actions).toBeLessThan(result.heading);
        } finally {
          await page.close();
        }
      });
    }
  }
});
