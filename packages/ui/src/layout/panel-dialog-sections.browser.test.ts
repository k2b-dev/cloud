import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// Tints, insets and where a title sits are layout, which happy-dom does not
// model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-panel-dialog-sections-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: PanelDialog } = await import("./PanelDialog");
const { TextInput } = await import("../inputs/TextInput");
const { Switch } = await import("../inputs/Switch");

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

const text = (label: string) => createComponent(TextInput, { label, value: "Autumn market" });
const section = (title: string, children: () => JSX.Element, hideable?: { defaultOpen: boolean }) =>
  hideable
    ? createComponent(PanelDialog.Section, {
        title,
        subtitle: "Shown to every member.",
        icon: "ti ti-adjustments",
        hideable: true,
        defaultOpen: hideable.defaultOpen,
        get children() {
          return children();
        },
      })
    : createComponent(PanelDialog.Section, {
        title,
        subtitle: "Shown to every member.",
        icon: "ti ti-info-circle",
        get children() {
          return children();
        },
      });

const dialog = (id: string, body: () => JSX.Element, surface: "contained" | "floating" = "contained") =>
  `<div id="${id}" style="display:flex;height:44rem;margin-bottom:1rem">${renderToString(() =>
    createComponent(PanelDialog, {
      surface,
      get children() {
        return [
          createComponent(PanelDialog.Header, { title: "Edit space", subtitle: "Club group", icon: "ti ti-folder", close: () => {} }),
          createComponent(PanelDialog.Body, {
            get children() {
              return body();
            },
          }),
          createComponent(PanelDialog.Footer, { children: "Save" }),
        ];
      },
    }),
  )}</div>`;

const markup = () =>
  [
    dialog("grouped", () => [
      text("Loose"),
      section("General", () => [text("Name"), text("Identifier")]),
      section("Visibility", () => createComponent(Switch, { label: "Visible to all members", value: true })),
      section("Closed", () => text("Hidden"), { defaultOpen: false }),
      section("Open", () => text("Shown"), { defaultOpen: true }),
    ]),
    dialog("lone", () => section("Name", () => text("Title"))),
    dialog("lone-form", () => section("Name", () => text("Title"))),
    dialog("wrapped", () => [text("Search"), section("Message", () => text("Id")), section("Source", () => text("Size"))]),
    dialog("floating", () => [section("Trigger", () => text("Event")), section("Action", () => text("Target"))], "floating"),
  ].join("");

const open = async (viewport: { width: number; height: number }) => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" data-theme="light" style="margin:0"><i id="muted" style="background:var(--k2b-surface-muted)"></i>` +
      `<i id="surface" style="background:var(--k2b-surface)"></i>${markup()}</body></html>`,
  );
  // A form that is the body's only child holds one section, and a grid wraps
  // each section in its own column, as the Mail inspector does.
  await page.evaluate(() => {
    const body = document.querySelector("#lone-form .k2b-panel-dialog__body")!;
    const form = document.createElement("form");
    form.append(...Array.from(body.children));
    body.append(form);
    const wrapped = document.querySelector("#wrapped .k2b-panel-dialog__body")!;
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:1rem";
    for (const element of Array.from(wrapped.querySelectorAll(":scope > .k2b-panel-dialog__section"))) {
      const column = document.createElement("div");
      column.append(element);
      grid.append(column);
    }
    wrapped.append(grid);
  });
  return page;
};

const measure = () => {
  const color = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
  const style = (element: Element) => getComputedStyle(element);
  const scope = (id: string) => document.getElementById(id)!;
  const well = (container: Element) => style(container.querySelector(".k2b-input-shell")!).backgroundColor;
  const box = (element: Element) => element.getBoundingClientRect();
  const sectionTitle = (element: Element) => {
    const title = Array.from(element.querySelectorAll("h3, .k2b-panel-dialog__section-title")).find(
      (candidate) => (candidate as HTMLElement).offsetParent !== null,
    )!;
    const trailing = Array.from(element.querySelectorAll(".k2b-button")).find(
      (candidate) => (candidate as HTMLElement).offsetParent !== null,
    )!;
    const eye = trailing.querySelector(".ti-eye, .ti-eye-off")!;
    return {
      left: box(title).left - box(element).left,
      top: box(title).top - box(element).top,
      eyeCenter: [box(eye).left + box(eye).width / 2 - box(element).left, box(eye).top + box(eye).height / 2 - box(element).top],
    };
  };
  const grouped = scope("grouped");
  const sections = Array.from(grouped.querySelectorAll(".k2b-panel-dialog__section"));
  const visibleBodies = Array.from(grouped.querySelectorAll(".k2b-panel-dialog__section-body:not([hidden])"));
  const header = grouped.querySelector(".k2b-panel-dialog__header")!;
  const footer = grouped.querySelector(".k2b-panel-dialog__footer")!;
  const lone = (id: string) => {
    const element = scope(id).querySelector(".k2b-panel-dialog__section")!;
    const body = element.querySelector(".k2b-panel-dialog__section-body")!;
    return {
      tint: style(body).backgroundColor,
      well: well(body),
      titleAlignedWithField: box(element.querySelector("h3")!).left === box(body.querySelector(".k2b-input-shell")!).left,
    };
  };
  return {
    muted: color("muted"),
    surface: color("surface"),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    chrome: [header, footer].map((element) => ({
      background: style(element).backgroundColor,
      rules: [style(element).borderTopStyle, style(element).borderBottomStyle],
    })),
    inset: box(grouped.querySelector(".k2b-panel-dialog__header > i")!).left - box(grouped).left,
    bodyInset: box(grouped.querySelector(".k2b-panel-dialog__section")!).left - box(grouped).left,
    sections: sections.map((element) => ({ border: style(element).borderTopStyle, background: style(element).backgroundColor })),
    tints: visibleBodies.map((element) => style(element).backgroundColor),
    titleAboveGroup: visibleBodies.every(
      (element) => box(element.parentElement!.querySelector(":scope > header:not([hidden])")!).bottom <= box(element).top,
    ),
    icons: Array.from(grouped.querySelectorAll(".k2b-panel-dialog__section-icon")).map((element) => style(element).display),
    groupedWells: visibleBodies.flatMap((element) =>
      Array.from(element.querySelectorAll(".k2b-input-shell")).map((input) => style(input).backgroundColor),
    ),
    looseWell: well(grouped.querySelector(".k2b-panel-dialog__body > .k2b-field")!),
    sectionGap: box(sections[1]!).top - box(sections[0]!).bottom,
    closed: sectionTitle(grouped.querySelector('.k2b-panel-dialog__section[data-open="false"]')!),
    opened: sectionTitle(grouped.querySelector('.k2b-panel-dialog__section[data-open="true"]')!),
    lone: lone("lone"),
    loneForm: lone("lone-form"),
    wrapped: Array.from(scope("wrapped").querySelectorAll(".k2b-panel-dialog__section-body")).map(
      (element) => style(element).backgroundColor,
    ),
    floating: Array.from(scope("floating").querySelectorAll(".k2b-panel-dialog__section")).map((element) => ({
      border: style(element).borderTopStyle,
      background: style(element).backgroundColor,
      icon: style(element.querySelector(".k2b-panel-dialog__section-icon")!).display !== "none",
      tint: style(element.querySelector(".k2b-panel-dialog__section-body")!).backgroundColor,
    })),
  };
};

const transparent = "rgba(0, 0, 0, 0)";

describe("@k2b/ui PanelDialog sections are titled groups without frames", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    test(`grouped sections, lone sections and flat chrome on a ${name}`, async () => {
      const page = await open(viewport);
      try {
        const result = await page.evaluate(measure);
        expect(result.overflow).toBeLessThanOrEqual(0);

        // Flat header and footer: no band, no line.
        expect(result.chrome).toEqual([
          { background: transparent, rules: ["none", "none"] },
          { background: transparent, rules: ["none", "none"] },
        ]);
        expect(result.inset).toBe(name === "phone" ? 16 : 24);
        expect(result.bodyInset).toBe(result.inset);

        // No card: the title sits above one tinted group, without an icon.
        expect(result.sections.every((section) => section.border === "none" && section.background === transparent)).toBe(true);
        expect(result.tints).toEqual([result.muted, result.muted, result.muted]);
        expect(result.titleAboveGroup).toBe(true);
        expect(new Set(result.icons)).toEqual(new Set(["none"]));
        expect(result.sectionGap).toBe(24);

        // Wells turn white inside a group and stay muted outside one.
        expect(new Set(result.groupedWells)).toEqual(new Set([result.surface]));
        expect(result.looseWell).toBe(result.muted);

        // Opening a hideable section keeps its title and eye button in place.
        expect(result.opened).toEqual(result.closed);

        // A lone section drops its group, also inside a form that fills the body.
        for (const lone of [result.lone, result.loneForm]) {
          expect(lone).toEqual({ tint: transparent, well: result.muted, titleAlignedWithField: true });
        }

        // Sections wrapped one per column keep their groups.
        expect(result.wrapped).toEqual([result.muted, result.muted]);

        // Floating placement keeps white cards with their icons.
        for (const section of result.floating) {
          expect(section).toEqual({ border: "solid", background: result.surface, icon: true, tint: transparent });
        }
      } finally {
        await page.close();
      }
    });
  }
});
