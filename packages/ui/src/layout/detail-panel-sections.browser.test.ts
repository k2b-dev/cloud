import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// Frames, insets and where a heading sits are layout, which happy-dom does not
// model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-detail-panel-sections-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: DetailPanel } = await import("./DetailPanel");
const { default: Discussion } = await import("./Discussion");
const { Button } = await import("../actions/Button");

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

type Comments = "loading" | "one" | "two";

const section = (title: string, icon: string, meta?: string, children: () => JSX.Element = () => "Content") =>
  createComponent(DetailPanel.Section, {
    title,
    icon,
    meta,
    get children() {
      return children();
    },
  });

const comment = (author: string, text: string) =>
  createComponent(Discussion.Item, {
    author,
    timestamp: "Aug 9",
    get children() {
      return text;
    },
  });

const discussion = (comments: Comments, composer: boolean) =>
  createComponent(Discussion, {
    label: "Comments",
    icon: "ti ti-message",
    count: comments === "two" ? 2 : comments === "one" ? 1 : 0,
    actions: composer ? undefined : createComponent(Button, { variant: "ghost", size: "xs", children: "Add comment" }),
    get children() {
      return [
        composer ? createComponent(Discussion.Composer, { label: "Add comment", onSubmit: () => {} }) : null,
        createComponent(Discussion.List, {
          loading: comments === "loading",
          loadingLabel: "Loading comments",
          get children() {
            return comments === "loading"
              ? []
              : [comment("Mara Klein", "Ready for review"), ...(comments === "two" ? [comment("Valentin Kolb", "Shipped")] : [])];
          },
        }),
      ];
    },
  });

// The order of a real inspector: a summary, a group, a section placed directly
// in the body, the comments, and a closing group.
const panel = (id: string, comments: Comments, composer = false) =>
  `<div id="${id}" class="k2b-app-workspace__detail" style="height:60rem">${renderToString(() =>
    createComponent(DetailPanel, {
      get children() {
        return [
          createComponent(DetailPanel.Header, { title: "Migration plan", subtitle: "Collaborative note", meta: "Edited today" }),
          createComponent(DetailPanel.Body, {
            get children() {
              return [
                createComponent(DetailPanel.Summary, { title: "Overview", children: "Two of three tasks done" }),
                createComponent(DetailPanel.Group, {
                  get children() {
                    return [section("Contents", "ti ti-list"), section("Attachments", "ti ti-paperclip", "1")];
                  },
                }),
                section("Conversation summary", "ti ti-sparkles"),
                discussion(comments, composer),
                createComponent(DetailPanel.Group, {
                  get children() {
                    return section("Info", "ti ti-info-circle");
                  },
                }),
              ];
            },
          }),
        ];
      },
    }),
  )}</div>`;

// A discussion placed in a group is one of its sections; inside a section the section frames it.
const nested = () =>
  `<div id="nested" class="k2b-app-workspace__detail" style="height:40rem">${renderToString(() =>
    createComponent(DetailPanel, {
      get children() {
        return createComponent(DetailPanel.Body, {
          get children() {
            return [
              createComponent(DetailPanel.Group, {
                get children() {
                  return [section("Contents", "ti ti-list"), discussion("one", false), section("Info", "ti ti-info-circle")];
                },
              }),
              section("Notes", "ti ti-notes", undefined, () => discussion("one", false)),
            ];
          },
        });
      },
    }),
  )}</div>`;

// Outside a detail panel the discussion keeps its own card, and `bare` stays bare.
const standalone = () =>
  `<div id="standalone" style="padding:1rem">${renderToString(() => discussion("one", false))}</div>` +
  `<div id="bare" style="padding:1rem">${renderToString(() =>
    createComponent(Discussion, {
      label: "Notes",
      as: "h2",
      surface: "bare",
      get children() {
        return createComponent(Discussion.List, {});
      },
    }),
  )}</div>`;

const open = async (viewport: { width: number; height: number }, theme: "light" | "dark") => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>*, *::before, *::after { transition: none !important }</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}" style="margin:0">` +
      panel("loading", "loading") +
      panel("one", "one") +
      panel("two", "two") +
      panel("composer", "one", true) +
      nested() +
      standalone() +
      `</body></html>`,
  );
  return page;
};

const measure = () => {
  const box = (element: Element) => element.getBoundingClientRect();
  const style = (element: Element) => getComputedStyle(element);
  const blocks = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} .k2b-detail-panel__body > *`)).map((element) => ({
      kind: element.className.split(" ")[0],
      left: box(element).left,
      width: box(element).width,
      top: box(element).top,
      background: style(element).backgroundColor,
      border: style(element).borderTopWidth,
      radius: style(element).borderTopLeftRadius,
    }));
  // Every heading row with an icon: the grouped and the lone sections, and the discussion.
  const headings = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} :is(.k2b-detail-panel__section-header, .k2b-discussion__header)`)).map((header) => {
      const title = header.querySelector("h3")!;
      const icon = header.querySelector(":is(.k2b-detail-panel__section-icon, .k2b-discussion__icon)")!;
      const meta = header.querySelector(":is(.k2b-detail-panel__section-meta, .k2b-discussion__count)");
      const titleStyle = style(title);
      return {
        title: title.textContent,
        iconLeft: box(icon).left,
        iconColor: style(icon).color,
        titleLeft: box(title).left,
        height: box(header).height,
        type: [titleStyle.fontSize, titleStyle.fontWeight, titleStyle.textTransform, titleStyle.letterSpacing, titleStyle.color].join(" "),
        metaRight: meta ? box(meta).right : null,
        metaType: meta ? [style(meta).fontSize, style(meta).color].join(" ") : null,
      };
    });
  const discussionHeader = (id: string) => box(document.querySelector(`#${id} .k2b-discussion__header`)!).top;
  const card = (id: string) => {
    const element = document.querySelector(`#${id} .k2b-discussion`)!;
    return { border: style(element).borderTopWidth, background: style(element).backgroundColor, padding: style(element).paddingTop };
  };
  const grouped = Array.from(document.querySelectorAll("#nested .k2b-detail-panel__group > *")).map((element) => {
    const icon = element.querySelector(":is(.k2b-detail-panel__section-icon, .k2b-discussion__icon)")!;
    const header = element.querySelector(":is(.k2b-detail-panel__section-header, .k2b-discussion__header)")!;
    return { iconLeft: box(icon).left, headerOffset: box(header).top - box(element).top, background: style(element).backgroundColor };
  });
  const inSection = document.querySelector("#nested .k2b-detail-panel__section-body > .k2b-discussion")!;
  const sectionBody = inSection.parentElement!;
  // WCAG relative luminance contrast of the comment action against the frame it sits on.
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const action = document.querySelector("#one .k2b-discussion__actions .k2b-button")!;
  const frame = document.querySelector("#one .k2b-discussion")!;
  const [light, dark] = [luminance(style(action).color), luminance(style(frame).backgroundColor)].sort((a, b) => b - a);
  return {
    actionContrast: (light! + 0.05) / (dark! + 0.05),
    grouped,
    inSection: {
      left: box(inSection).left - box(sectionBody).left,
      padding: style(inSection).paddingTop + " " + style(inSection).paddingLeft,
      background: style(inSection).backgroundColor,
      border: style(inSection).borderTopWidth,
    },
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    blocks: { loading: blocks("loading"), one: blocks("one"), two: blocks("two"), composer: blocks("composer") },
    headings: headings("one"),
    composerHeadings: headings("composer"),
    discussionHeader: {
      loading: discussionHeader("loading"),
      one: discussionHeader("one"),
      two: discussionHeader("two"),
      composer: discussionHeader("composer"),
    },
    headerMeta: (() => {
      const meta = document.querySelector("#one .k2b-detail-panel__meta")!;
      const subtitle = document.querySelector("#one .k2b-detail-panel__heading p")!;
      return [style(meta).fontSize, style(subtitle).fontSize];
    })(),
    standalone: card("standalone"),
    bare: card("bare"),
  };
};

describe("DetailPanel sections and Discussion share one frame", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      test(`${name} ${theme}`, async () => {
        const page = await open(viewport, theme);
        try {
          const result = await page.evaluate(measure);
          expect(result.overflow).toBe(0);

          for (const blocks of Object.values(result.blocks)) {
            // The summary, groups, a lone section and the discussion are one column of equal frames:
            // the same edges, surface and radius, and no border anywhere.
            expect(new Set(blocks.map((block) => block.left)).size).toBe(1);
            expect(new Set(blocks.map((block) => block.width)).size).toBe(1);
            expect(new Set(blocks.map((block) => block.background)).size).toBe(1);
            expect(new Set(blocks.map((block) => block.radius)).size).toBe(1);
            expect(blocks.every((block) => block.border === "0px")).toBe(true);
            expect(blocks.map((block) => block.kind)).toContain("k2b-discussion");
          }

          // Every heading uses the same icon column, title column, row height and type.
          for (const headings of [result.headings, result.composerHeadings]) {
            expect(headings.map((heading) => heading.title)).toEqual([
              "Contents",
              "Attachments",
              "Conversation summary",
              "Comments",
              "Info",
            ]);
            for (const key of ["iconLeft", "iconColor", "titleLeft", "height", "type"] as const)
              expect(new Set(headings.map((heading) => heading[key])).size, key).toBe(1);
            expect(headings[0]!.type).toContain(" none normal ");
            // The count sits at the trailing edge of the heading like a section's meta.
            const counted = headings.filter((heading) => heading.metaRight !== null);
            expect(new Set(counted.map((heading) => heading.metaType)).size).toBe(1);
          }
          expect(result.headings.find((heading) => heading.title === "Attachments")!.metaRight).toBe(
            result.composerHeadings.find((heading) => heading.title === "Comments")!.metaRight,
          );

          // Loading, a first comment, a second comment, or an open composer move nothing above the comments.
          const reference = result.blocks.loading;
          for (const id of ["one", "two", "composer"] as const) {
            const blocks = result.blocks[id];
            const before = reference.findIndex((block) => block.kind === "k2b-discussion");
            expect(blocks.slice(0, before + 1).map((block) => block.top - blocks[0]!.top)).toEqual(
              reference.slice(0, before + 1).map((block) => block.top - reference[0]!.top),
            );
            expect(result.discussionHeader[id] - blocks[0]!.top).toBe(result.discussionHeader.loading - reference[0]!.top);
          }

          // Plain header meta reads like the subtitle beside it.
          expect(result.headerMeta[0]).toBe(result.headerMeta[1]);

          // The comment action is text, so it keeps 4.5:1 on its frame in both themes.
          expect(result.actionContrast).toBeGreaterThanOrEqual(4.5);

          // In a group, the discussion's icon sits in the sections' column and the spacing between
          // neighbours matches; inside a section it adds no frame or inset of its own.
          expect(new Set(result.grouped.map((entry) => entry.iconLeft)).size).toBe(1);
          expect(result.grouped.map((entry) => entry.headerOffset)).toEqual([8, 12, 12]);
          expect(result.grouped.every((entry) => entry.background === "rgba(0, 0, 0, 0)")).toBe(true);
          expect(result.inSection).toEqual({ left: 0, padding: "0px 0px", background: "rgba(0, 0, 0, 0)", border: "0px" });

          // Outside a detail panel the default discussion is its own card; bare draws nothing.
          expect(result.standalone.border).toBe("1px");
          expect(result.bare).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)", padding: "0px" });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
