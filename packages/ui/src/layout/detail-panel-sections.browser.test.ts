import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Frames, insets and where a heading sits are layout, which happy-dom does not
// model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-detail-panel-sections-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: DetailPanel } = await import("./DetailPanel");
const { default: Discussion } = await import("./Discussion");
const { Button } = await import("../actions/Button");
const { TextInput } = await import("../inputs/TextInput");
const { Avatar } = await import("../surfaces/Avatar");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const viewports = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
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
  `<div class="k2b-app-workspace" style="height:60rem;--k2b-detail-size:416px;--k2b-detail-min:320px;--k2b-detail-max:640px"><div class="k2b-app-workspace__content"><div class="k2b-app-workspace__main"></div><aside id="${id}" class="k2b-app-workspace__detail" style="--k2b-workspace-panel-size:416px;--k2b-workspace-panel-min:320px;--k2b-workspace-panel-max:640px">${renderToString(
    () =>
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
  )}</aside></div></div>`;

// A discussion placed in a group is one of its sections; inside a section the section frames it.
const nested = () =>
  `<div class="k2b-app-workspace" style="height:40rem;--k2b-detail-size:416px;--k2b-detail-min:320px;--k2b-detail-max:640px"><div class="k2b-app-workspace__content"><div class="k2b-app-workspace__main"></div><aside id="nested" class="k2b-app-workspace__detail" style="--k2b-workspace-panel-size:416px;--k2b-workspace-panel-min:320px;--k2b-workspace-panel-max:640px">${renderToString(
    () =>
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
  )}</aside></div></div>`;

// A panel reused inside a tinted dialog group: that group turns field wells white
// for its tint, but every frame of the panel paints its own surface again.
const hosted = () =>
  `<div id="hosted" class="k2b-panel-dialog__section-body">${renderToString(() =>
    createComponent(DetailPanel, {
      get children() {
        return createComponent(DetailPanel.Body, {
          get children() {
            return [
              createComponent(DetailPanel.Group, {
                get children() {
                  return section("Contents", "ti ti-list", undefined, () => createComponent(TextInput, { label: "Grouped", value: "" }));
                },
              }),
              section("Notes", "ti ti-notes", undefined, () => createComponent(TextInput, { label: "Lone", value: "" })),
              discussion("one", true),
            ];
          },
        });
      },
    }),
  )}</div>`;

// The narrowest panel with a wide three-part header meta, like a read-only recurring event.
const narrow = () =>
  `<div class="k2b-app-workspace" style="height:20rem;--k2b-detail-size:320px;--k2b-detail-min:320px;--k2b-detail-max:640px"><div class="k2b-app-workspace__content"><div class="k2b-app-workspace__main"></div><aside id="narrow" class="k2b-app-workspace__detail" style="--k2b-workspace-panel-size:320px;--k2b-workspace-panel-min:320px;--k2b-workspace-panel-max:640px">${renderToString(
    () =>
      createComponent(DetailPanel, {
        get children() {
          return createComponent(DetailPanel.Header, {
            title: "Weekly planning",
            subtitle: "Event",
            get meta() {
              return ["Blocked by 3", "Read only", "This event only"].map((label) =>
                createComponent(Button, { variant: "ghost", size: "xs", children: label }),
              );
            },
          });
        },
      }),
  )}</aside></div></div>`;

// A section outside a panel, such as a form section in an editor dialog, keeps its full width.
const loose = () =>
  `<div id="loose" style="padding:1rem;width:20rem">${renderToString(() => section("Appearance", "ti ti-palette"))}</div>`;

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

const avatarPanel = () =>
  `<div class="k2b-app-workspace" style="height:40rem;--k2b-detail-size:416px;--k2b-detail-min:320px;--k2b-detail-max:640px"><div class="k2b-app-workspace__content"><div class="k2b-app-workspace__main"></div><aside class="k2b-app-workspace__detail" style="--k2b-workspace-panel-size:416px;--k2b-workspace-panel-min:320px;--k2b-workspace-panel-max:640px">${renderToString(
    () =>
      createComponent(DetailPanel, {
        get children() {
          return createComponent(DetailPanel.Body, {
            get children() {
              return [
                // Without a section icon, so the avatar sits on the body's content edge, as close to the scrollport as
                // panel content gets.
                section("Working", "", undefined, () =>
                  createComponent(Avatar, { name: "Grace Hopper", size: "xs", ring: "success", alt: "Grace Hopper is working on it" }),
                ),
                section("Online", "", undefined, () =>
                  createComponent(Avatar, {
                    name: "Ada Lovelace",
                    size: "xs",
                    ring: { color: "#7c3aed" },
                    src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="skyblue"/></svg>')}`,
                    loading: "eager",
                  }),
                ),
              ];
            },
          });
        },
      }),
  )}</aside></div></div>`;

const open = async (viewport: { width: number; height: number }, theme: "light" | "dark", content?: string) => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>*, *::before, *::after { transition: none !important }</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}" style="margin:0">` +
      (content ??
        panel("loading", "loading") +
          panel("one", "one") +
          panel("two", "two") +
          panel("composer", "one", true) +
          nested() +
          hosted() +
          narrow() +
          loose() +
          standalone()) +
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
      const meta = header.querySelector(":is(.k2b-detail-panel__section-meta, .k2b-count-chip, .k2b-detail-panel__none)");
      const titleStyle = style(title);
      return {
        title: title.textContent,
        iconLeft: box(icon).left,
        iconColor: style(icon).color,
        titleLeft: box(title).left,
        height: box(header).height,
        type: [titleStyle.fontSize, titleStyle.fontWeight, titleStyle.textTransform, titleStyle.letterSpacing, titleStyle.color].join(" "),
        metaGap: meta ? Math.round(box(meta).left - box(title).right) : null,
        metaType: meta ? [style(meta).fontSize, style(meta).color, meta.className].join(" ") : null,
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
    const [r, g, b] = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const action = document.querySelector("#one .k2b-discussion__actions .k2b-button")!;
  // The column and panel sections are transparent. Follow their painted ancestors
  // to the workspace surface, rather than reading transparent rgba as black.
  let frame: Element | null = action;
  while (frame && style(frame).backgroundColor === "rgba(0, 0, 0, 0)") frame = frame.parentElement;
  if (!frame) throw new Error("Comment action has no painted background");
  const actionColor = style(action).color;
  const actionBackground = style(frame).backgroundColor;
  const [light, dark] = [luminance(actionColor), luminance(actionBackground)].sort((a, b) => b - a);
  return {
    actionContrast: (light! + 0.05) / (dark! + 0.05),
    actionColor,
    actionBackground,
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
      return [style(meta).fontSize, style(subtitle).fontSize, box(meta).top === box(subtitle).top ? "one line" : "wrapped"];
    })(),
    narrowHeader: (() => {
      const header = box(document.querySelector("#narrow .k2b-detail-panel__header")!);
      const subtitle = box(document.querySelector("#narrow .k2b-detail-panel__supporting > p")!);
      const meta = box(document.querySelector("#narrow .k2b-detail-panel__meta")!);
      return {
        subtitleWidth: subtitle.width,
        metaInside: meta.left >= header.left && meta.right <= header.right,
        metaBelow: meta.top >= subtitle.bottom,
        metaBeside: meta.left >= subtitle.right - 0.5,
      };
    })(),
    looseIndent: style(document.querySelector("#loose .k2b-detail-panel__section-body")!).paddingInlineStart,
    standalone: card("standalone"),
    bare: card("bare"),
    hosted: (() => {
      const well = (selector: string) => style(document.querySelector(`#hosted ${selector}`)!).backgroundColor;
      return {
        tint: style(document.querySelector("#hosted")!).backgroundColor,
        frame: style(document.querySelector("#hosted .k2b-detail-panel__body > .k2b-detail-panel__section")!).backgroundColor,
        grouped: well(".k2b-detail-panel__group .k2b-input-shell"),
        lone: well(".k2b-detail-panel__body > .k2b-detail-panel__section .k2b-input-shell"),
        composer: well(".k2b-discussion__composer-field .k2b-markdown-editor"),
      };
    })(),
  };
};

describe("DetailPanel sections and Discussion share one frame", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      test(`${name} ${theme} avatar rings stay inside the scrollport without changing size`, async () => {
        const page = await open(viewport, theme, avatarPanel());
        try {
          await page.locator("img.k2b-avatar").evaluate((image: HTMLImageElement) => image.decode());
          const result = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".k2b-detail-panel__body")!;
            const bodyRect = body.getBoundingClientRect();
            const left = bodyRect.left + body.clientLeft;
            // The body keeps a gutter for row hover fills; content starts after it.
            const contentLeft = left + parseFloat(getComputedStyle(body).paddingLeft);
            const top = bodyRect.top + body.clientTop;
            const probe = document.createElement("span");
            probe.style.color = "var(--k2b-success-text)";
            body.append(probe);
            const success = getComputedStyle(probe).color;
            probe.remove();
            return Array.from(body.querySelectorAll<HTMLElement>(".k2b-avatar")).map((avatar) => {
              const rect = avatar.getBoundingClientRect();
              const style = getComputedStyle(avatar);
              const ring = avatar.getAttribute("data-ring")!;
              // Include outside paint: an outline can be clipped even when its border box fits.
              const outline =
                style.outlineStyle === "none" ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
              const outset = { left: outline, right: outline, top: outline, bottom: outline };
              for (const shadow of style.boxShadow.split(/,(?![^()]*\))/)) {
                if (shadow === "none" || shadow.includes("inset")) continue;
                const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
                outset.left = Math.max(outset.left, spread + blur - x);
                outset.right = Math.max(outset.right, spread + blur + x);
                outset.top = Math.max(outset.top, spread + blur - y);
                outset.bottom = Math.max(outset.bottom, spread + blur + y);
              }
              const inside = (paint: { left: number; right: number; top: number; bottom: number }) =>
                paint.left >= left - 0.5 &&
                paint.right <= left + body.clientWidth + 0.5 &&
                paint.top >= top - 0.5 &&
                paint.bottom <= top + body.clientHeight + 0.5;
              const painted = {
                left: rect.left - outset.left,
                right: rect.right + outset.right,
                top: rect.top - outset.top,
                bottom: rect.bottom + outset.bottom,
              };
              avatar.removeAttribute("data-ring");
              const without = avatar.getBoundingClientRect();
              avatar.setAttribute("data-ring", ring);
              const restored = avatar.getBoundingClientRect();
              return {
                ring,
                expectedColor: ring === "success" ? success : "rgb(124, 58, 237)",
                outline: style.outlineStyle,
                shadow: style.boxShadow,
                border: style.borderTopWidth,
                color: style.borderTopColor,
                flush: Math.abs(rect.left - contentLeft) <= 0.5,
                inside: inside(rect),
                paintedInside: inside(painted),
                size: [rect.width, rect.height],
                without: [without.width, without.height],
                restored: [restored.width, restored.height],
              };
            });
          });
          expect(result.map((avatar) => avatar.ring)).toEqual(["success", "color"]);
          for (const avatar of result) {
            expect(avatar.flush).toBe(true);
            expect(avatar.inside).toBe(true);
            expect(avatar.paintedInside).toBe(true);
            expect(avatar.outline).toBe("none");
            expect(avatar.shadow).toBe("none");
            expect(avatar.border).toBe("2px");
            expect(avatar.color).toBe(avatar.expectedColor);
            expect(avatar.size).toEqual([24, 24]);
            expect(avatar.without).toEqual(avatar.size);
            expect(avatar.restored).toEqual(avatar.size);
          }
        } finally {
          await page.close();
        }
      }, 30_000);

      test(`${name} ${theme}`, async () => {
        const page = await open(viewport, theme);
        try {
          const result = await page.evaluate(measure);
          expect(result.overflow).toBe(0);

          for (const blocks of Object.values(result.blocks)) {
            // Summary, groups, lone sections, and discussion align inside the raised host.
            // Their transparent surfaces leave the host as the one frame.
            expect(new Set(blocks.map((block) => block.left)).size).toBe(1);
            expect(new Set(blocks.map((block) => block.width)).size).toBe(1);
            expect(blocks.every((block) => block.background === "rgba(0, 0, 0, 0)")).toBe(true);
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
            // A count sits right after its title, in one chip style, whether in a section or a discussion.
            const counted = headings.filter((heading) => heading.metaGap !== null);
            expect(counted.length).toBeGreaterThan(1);
            expect(new Set(counted.map((heading) => heading.metaGap))).toEqual(new Set([8]));
            const chips = counted.filter((heading) => heading.metaType?.includes("k2b-count-chip"));
            expect(new Set(chips.map((heading) => heading.metaType)).size).toBeLessThanOrEqual(1);
          }

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
          // A meta that fits stays on the subtitle's line.
          expect(result.headerMeta[2]).toBe("one line");

          // The comment action is text, so it keeps 4.5:1 on its frame in both themes.
          expect(result.actionContrast, `${result.actionColor} on ${result.actionBackground}`).toBeGreaterThanOrEqual(4.5);

          // In a group, the discussion's icon sits in the sections' column and the spacing between
          // neighbours matches; inside a section it adds no frame or inset of its own.
          expect(new Set(result.grouped.map((entry) => entry.iconLeft)).size).toBe(1);
          // In the floating host, one gap separates every block, so no section carries padding of its own.
          expect(result.grouped.map((entry) => entry.headerOffset)).toEqual([0, 0, 0]);
          expect(result.grouped.every((entry) => entry.background === "rgba(0, 0, 0, 0)")).toBe(true);
          // Inside a section it starts on the section's text edge, after the icon column, and adds no inset of its own.
          expect(result.inSection).toEqual({ left: 30, padding: "0px 0px", background: "rgba(0, 0, 0, 0)", border: "0px" });

          // Hosted in a tinted dialog group, the lone section and the discussion are frames like a
          // group: their field wells are recessed again instead of white on the white frame.
          expect(result.hosted.tint).not.toBe(result.hosted.frame);
          expect(result.hosted.grouped).not.toBe(result.hosted.frame);
          expect(result.hosted.lone).toBe(result.hosted.grouped);
          expect(result.hosted.composer).toBe(result.hosted.grouped);

          // The subtitle keeps its text and the meta stays inside the header: beside the subtitle while
          // both fit (font metrics differ between engines), below it once they do not.
          expect(result.narrowHeader.subtitleWidth).toBeGreaterThanOrEqual(90);
          expect(result.narrowHeader.metaInside).toBe(true);
          expect(result.narrowHeader.metaBelow || result.narrowHeader.metaBeside).toBe(true);

          // The one text edge belongs to panels: a section outside one keeps its full width.
          expect(result.looseIndent).toBe("0px");

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

// The public surface option must work outside the workspace host that first
// owned the flat styles. The default remains a separate quiet surface.
test("plain panels reuse the workspace rhythm in an independent host", async () => {
  const page = await browser.newPage({ viewport: viewports.desktop });
  const markup = (surface?: "plain") =>
    renderToString(() =>
      createComponent(DetailPanel, {
        surface,
        get children() {
          return createComponent(DetailPanel.Body, {
            get children() {
              return [
                createComponent(DetailPanel.Group, {
                  get children() {
                    return section("Context", "ti ti-info-circle");
                  },
                }),
                section("Results", "ti ti-file"),
              ];
            },
          });
        },
      }),
    );
  try {
    await page.setContent(
      `<html><head><style>${css}</style></head><body class="k2b-ui"><div id="plain">${markup("plain")}</div><div id="default">${markup()}</div></body></html>`,
    );
    const painted = await page.evaluate(() => {
      const values = (id: string) =>
        Array.from(
          document.querySelectorAll(`#${id} .k2b-detail-panel__group,#${id} .k2b-detail-panel__body > .k2b-detail-panel__section`),
        ).map((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, radius: style.borderRadius, padding: style.padding };
        });
      return {
        plain: values("plain"),
        default: values("default"),
        gap: getComputedStyle(document.querySelector("#plain .k2b-detail-panel__body")!).gap,
      };
    });
    expect(painted.plain).toHaveLength(2);
    expect(
      painted.plain.every((value) => value.background === "rgba(0, 0, 0, 0)" && value.radius === "0px" && value.padding === "0px"),
    ).toBe(true);
    expect(painted.default.every((value) => value.background !== "rgba(0, 0, 0, 0)" && value.radius !== "0px")).toBe(true);
    expect(painted.gap).toBe("24px");
  } finally {
    await page.close();
  }
});
