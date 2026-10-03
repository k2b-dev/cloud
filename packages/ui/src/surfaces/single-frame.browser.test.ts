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

const { Button, IconButton } = await import("../actions/Button");
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
            subtitle: "Endpoints that receive project events.",
            icon: "ti ti-webhook",
            get actions() {
              return createComponent(IconButton, { size: "sm", label: "Webhook documentation", children: "?" });
            },
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

const open = async (viewport: { width: number; height: number }, theme: "light" | "dark", rootFontSize = 16) => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html style="font-size:${rootFontSize}px"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
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
    sectionGap: box(".k2b-settings-section + .k2b-settings-section").top - box(".k2b-settings-section").bottom,
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
          expect(result.sectionGap).toBe(32);

          // Actions share the heading row on a desktop and wrap below it on a phone.
          if (name === "phone") expect(result.actions).toBeGreaterThanOrEqual(result.heading);
          else expect(result.actions).toBeLessThan(result.heading);
        } finally {
          await page.close();
        }
      });
    }
  }

  /** Where each section's icon, heading and actions sit relative to each other. */
  const headerRows = () =>
    Array.from(document.querySelectorAll(".k2b-settings-section__header")).map((header) => {
      const box = (selector: string) => header.querySelector(selector)!.getBoundingClientRect();
      const heading = box(".k2b-settings-section__heading");
      return {
        iconBesideHeading: heading.top < box(":scope > i").bottom,
        actionsBesideHeading: box(".k2b-settings-section__actions").top < heading.bottom,
      };
    });

  // 320px is the WCAG reflow width; a 20px root font is a common low-vision default.
  for (const [name, viewport, rootFontSize] of [
    ["a 320px phone", { width: 320, height: 640 }, 16],
    ["a 390px phone with a 20px root font", { width: 390, height: 844 }, 20],
  ] as const) {
    test(`a section icon and its heading share a line on ${name}`, async () => {
      const page = await open(viewport, "light", rootFontSize);
      try {
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const rows = await page.evaluate(headerRows);
        expect(rows.map((row) => row.iconBesideHeading)).toEqual([true, true]);
        expect(rows[0]!.actionsBesideHeading).toBe(false);
      } finally {
        await page.close();
      }
    });
  }

  test("a single icon action stays on the heading row of a 390px phone", async () => {
    const page = await open(viewports.phone, "light");
    try {
      expect(await page.evaluate(headerRows)).toEqual([
        { iconBesideHeading: true, actionsBesideHeading: false },
        { iconBesideHeading: true, actionsBesideHeading: true },
      ]);
    } finally {
      await page.close();
    }
  });

  test("actions wider than a 320px phone wrap onto further rows inside the section", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    try {
      const section = renderToString(() =>
        createComponent(SettingsSection, {
          title: "Profile and contact",
          subtitle: "Details that other people see.",
          get actions() {
            return [
              createComponent(Button, { size: "sm", variant: "secondary", children: "Edit the public profile" }),
              createComponent(Button, { size: "sm", variant: "secondary", children: "Contact, phone and SSH details" }),
            ];
          },
          children: "Value",
        }),
      );
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0;padding:1rem">${section}</body></html>`,
      );
      const result = await page.evaluate(() => {
        const header = document.querySelector(".k2b-settings-section__header")!.getBoundingClientRect();
        const actions = document.querySelector(".k2b-settings-section__actions")!.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll(".k2b-button")).map((button) => button.getBoundingClientRect());
        return {
          past: Math.max(0, actions.right - header.right),
          wrapped: buttons[1]!.top > buttons[0]!.top,
          // Wrapped rows start at the heading's edge.
          start: Math.round(buttons[1]!.left - header.left),
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(result).toEqual({ past: 0, wrapped: true, start: 0, overflow: 0 });
    } finally {
      await page.close();
    }
  });
});
