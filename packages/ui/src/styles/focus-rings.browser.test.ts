import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium, type Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// Whether a ring is clipped depends on layout, overflow, and paint, which
// happy-dom does not model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-focus-rings-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Button, IconButton } = await import("../actions/Button");
const { Disclosure } = await import("../actions/Disclosure");
const { Dropdown } = await import("../actions/Dropdown");
const { RemoveButton } = await import("../actions/RemoveButton");
const { SpotlightButton } = await import("../actions/SpotlightSearch");
const { Tabs } = await import("../actions/Tabs");
const { default: DataTable } = await import("../content/DataTable");
const { Pagination } = await import("../content/Pagination");
const { Checkbox } = await import("../inputs/Checkbox");
const { DateRangePicker } = await import("../inputs/DatePicker");
const { Switch } = await import("../inputs/Switch");
const { default: TextInput } = await import("../inputs/TextInput");
const { default: AppWorkspace } = await import("../layout/AppWorkspace");
const { default: DetailPanel } = await import("../layout/DetailPanel");
const { ScrollArea } = await import("../layout/ScrollArea");
const { SettingsGroup } = await import("../layout/Settings");
const { default: SettingsModal } = await import("../layout/SettingsModal");
const { StatCell } = await import("../surfaces/StatCell");
const { StatGrid } = await import("../surfaces/StatGrid");
const { Widget } = await import("../widgets/Widget");
const { WidgetList } = await import("../widgets/WidgetList");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/**
 * Application markup that no component renders, such as a plain link in a
 * table cell. Components receive a placeholder, and the rendered HTML gets the
 * markup back, so the browser sees exactly what an application ships.
 */
const raw: string[] = [];
const markup = (html: string) => `⁣${raw.push(html) - 1}⁣`;
const html = (view: () => JSX.Element) => renderToString(view).replace(/⁣(\d+)⁣/g, (_, index: string) => raw[Number(index)] ?? "");

const text = (label: string, variant: "primary" | "secondary" | "danger" = "secondary") =>
  createComponent(Button, { size: "sm", variant, children: label });
const icon = (label: string) => createComponent(IconButton, { label, size: "sm", variant: "ghost", children: "×" });
const menu = (label: string) =>
  createComponent(Dropdown.Root, {
    items: [{ label: "Export", action: () => {} }],
    get children() {
      return createComponent(Dropdown.Trigger, { size: "sm", variant: "secondary", children: label });
    },
  });

/** Sidebar rows whose actions, chevrons, and preview buttons appear on hover or keyboard focus, beside visible actions. */
const sidebarRows = () => [
  createComponent(AppWorkspace.SidebarItem, {
    icon: "ti ti-history",
    preview: { label: "Recent", trigger: "row", content: "Recent files" },
    children: "Recent",
  }),
  createComponent(AppWorkspace.SidebarItem, {
    href: "#retro",
    preview: { label: "Chat details", content: "Details" },
    get children() {
      return [
        createComponent(AppWorkspace.SidebarItemLabel, { children: "Retrospective notes for the launch" }),
        createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-arrow-back-up", label: "Reopen chat", visibility: "hover" }),
      ];
    },
  }),
  createComponent(AppWorkspace.SidebarItem, {
    href: "#inbox",
    icon: "ti ti-inbox",
    meta: "12",
    get children() {
      return [
        createComponent(AppWorkspace.SidebarItemLabel, { children: "Inbox" }),
        createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label: "Inbox actions", visibility: "hover" }),
      ];
    },
  }),
  createComponent(AppWorkspace.SidebarItem, {
    icon: "ti ti-share",
    preview: { label: "Shared", trigger: "row", content: "Shared files" },
    get children() {
      return [
        createComponent(AppWorkspace.SidebarItemLabel, { children: "Shared" }),
        createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label: "Shared actions", visibility: "hover" }),
      ];
    },
  }),
  createComponent(AppWorkspace.SidebarItem, {
    href: "#checklist",
    preview: { label: "Checklist details", content: "Details" },
    get children() {
      return [
        createComponent(AppWorkspace.SidebarItemLabel, { children: "Release checklist" }),
        createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-check", label: "Mark checklist done" }),
      ];
    },
  }),
  createComponent(AppWorkspace.SidebarItem, {
    href: "#review",
    preview: { label: "Review details", content: "Details" },
    get actions() {
      return createComponent(AppWorkspace.SidebarItemActions, {
        get children() {
          return [icon("Pin review"), icon("Share review")];
        },
      });
    },
    children: "Design review",
  }),
];

/** A workspace whose main area starts its controls flush at the edge, as board and table views do. */
const workspace = () =>
  html(() =>
    createComponent(AppWorkspace, {
      resizable: false,
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return [
                    createComponent(AppWorkspace.SidebarBody, {
                      get children() {
                        return [
                          createComponent(SpotlightButton, { variant: "sidebar", label: "Search", onClick: () => {} }),
                          createComponent(AppWorkspace.SidebarSection, {
                            title: "Views",
                            get children() {
                              return ["Tasks", "Calendar", "Archive"].map((label, index) =>
                                createComponent(AppWorkspace.SidebarItem, {
                                  href: `#${label.toLowerCase()}`,
                                  active: index === 0,
                                  icon: "ti ti-list",
                                  children: label,
                                }),
                              );
                            },
                          }),
                          createComponent(AppWorkspace.SidebarSection, {
                            title: "Chats",
                            get children() {
                              return sidebarRows();
                            },
                          }),
                        ];
                      },
                    }),
                    createComponent(AppWorkspace.SidebarFooter, {
                      get children() {
                        return createComponent(AppWorkspace.SidebarItem, {
                          href: "#settings",
                          icon: "ti ti-settings",
                          children: "Settings",
                        });
                      },
                    }),
                  ];
                },
              });
            },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return [
                createComponent(AppWorkspace.Main, {
                  get children() {
                    return [
                      markup('<div style="display:flex;gap:0.5rem;justify-content:space-between">'),
                      text("Add task", "primary"),
                      menu("Actions"),
                      markup("</div>"),
                      markup('<p style="margin:0;padding:1rem"><a href="#help">Board help</a></p>'),
                    ];
                  },
                }),
                createComponent(AppWorkspace.Detail, {
                  id: "record",
                  open: true,
                  get children() {
                    return detail();
                  },
                }),
              ];
            },
          }),
        ];
      },
    }),
  );

const detail = () =>
  createComponent(DetailPanel, {
    get children() {
      return [
        createComponent(DetailPanel.Header, {
          title: "Flyer.pdf",
          get actions() {
            return icon("Close panel");
          },
          get primaryActions() {
            return [text("Preview", "primary"), text("Download"), text("Delete", "danger")];
          },
        }),
        createComponent(DetailPanel.Body, {
          get children() {
            return [
              createComponent(DetailPanel.Section, {
                title: "Actions",
                get children() {
                  return [
                    createComponent(DetailPanel.Action, { title: "Open in new tab", href: "#open" }),
                    createComponent(DetailPanel.Action, { title: "Move to…", onClick: () => {} }),
                  ];
                },
              }),
              // Standalone collapsible sections sit flush with the scrolling body, closed and open.
              createComponent(DetailPanel.Section, {
                title: "Recent activity",
                icon: "ti ti-history",
                collapsible: true,
                children: "Edited",
              }),
              createComponent(DetailPanel.Section, {
                title: "Information",
                icon: "ti ti-info-circle",
                collapsible: true,
                defaultOpen: true,
                children: "Created yesterday",
              }),
            ];
          },
        }),
      ];
    },
  });

const table = () =>
  html(() =>
    createComponent(DataTable<{ id: string; name: string }>, {
      ariaLabel: "Members",
      rows: [
        { id: "ada", name: "Ada Lovelace" },
        { id: "grace", name: "Grace Hopper" },
      ],
      columns: [
        { id: "name", header: "Name", value: "name" },
        { id: "remove", header: "", value: "id" },
      ],
      renderCell: ({ row, col }) =>
        col.id === "name"
          ? markup(`<a href="#${row.id}">${row.name}</a>`)
          : createComponent(RemoveButton, { ariaLabel: `Remove ${row.name}` }),
    }),
  );

/** A narrow rail like Cloud's app switcher: square links with side clearance but none at the top. */
const rail = () =>
  html(() =>
    createComponent(ScrollArea, {
      class: "rail-fixture",
      get children() {
        return [
          ...["Assistant", "Files", "Grids"].map((label) =>
            markup(
              `<a href="#${label.toLowerCase()}" aria-label="${label}" style="display:grid;place-items:center;width:2rem;height:2rem;flex:none">${label[0]}</a>`,
            ),
          ),
          icon("More apps"),
        ];
      },
    }),
  );

const widgets = () =>
  html(() => [
    createComponent(Widget, {
      title: "Today",
      href: "#today",
      get children() {
        return createComponent(WidgetList, {
          items: [
            { label: "Stand-up", sub: "09:00", href: "#standup" },
            { label: "Review", sub: "14:00", href: "#review" },
          ],
        });
      },
    }),
    createComponent(StatGrid, {
      title: "Usage",
      get children() {
        return [
          createComponent(StatCell, { label: "Files", value: 12, href: "#files" }),
          createComponent(StatCell, { label: "Shares", value: 3, href: "#shares" }),
        ];
      },
    }),
  ]);

const settings = () =>
  html(() =>
    createComponent(SettingsModal, {
      title: "Board settings",
      onClose: () => {},
      get children() {
        return createComponent(SettingsModal.Tab, {
          id: "general",
          title: "General",
          get children() {
            return createComponent(SettingsGroup, {
              title: "Board",
              get children() {
                return [
                  createComponent(TextInput, { label: "Name", value: "Launch" }),
                  createComponent(Checkbox, { label: "Show archived", value: false }),
                  createComponent(Checkbox, { label: "Notify members", value: true }),
                  createComponent(Switch, { label: "Public board", value: true }),
                  text("Save", "primary"),
                ];
              },
            });
          },
        });
      },
    }),
  );

const panels = () =>
  html(() => [
    createComponent(Disclosure, {
      summary: "Advanced",
      defaultValue: true,
      get children() {
        return text("Reset");
      },
    }),
    createComponent(Pagination, { currentPage: 2, totalPages: 5, baseUrl: "/members" }),
  ]);

/** The selected tab rests on the list's border with its underline, where that list clips it. */
const tabs = () =>
  html(() =>
    (["horizontal", "vertical"] as const).flatMap((orientation) =>
      (["line", "pill"] as const).map((variant) =>
        createComponent(Tabs, {
          value: "tasks",
          onValueChange: () => {},
          ariaLabel: `${orientation} ${variant} views`,
          orientation,
          variant,
          options: [
            { value: "tasks", label: "Tasks", panel: "Open tasks", onClose: () => {} },
            { value: "calendar", label: "Calendar", onClose: () => {} },
          ],
        }),
      ),
    ),
  );

/** A `.k2b-ui` root nested flush in a clipping container, as a page embedding a workspace renders one. */
const nested = () =>
  `<div class="k2b-focus-inset" style="overflow:hidden"><div class="k2b-ui" style="display:flex;overflow:hidden">${html(() => [
    text("Save", "primary"),
    text("Cancel"),
  ])}</div></div>`;

const scenes: Record<string, { markup: () => string; frame: string }> = {
  workspace: { markup: workspace, frame: "height:36rem" },
  tabs: { markup: tabs, frame: "display:grid;gap:1rem" },
  table: { markup: table, frame: "height:12rem" },
  rail: { markup: rail, frame: "width:3rem;height:9rem" },
  widgets: { markup: widgets, frame: "display:grid;gap:1rem" },
  "detail panel": { markup: () => html(detail), frame: "height:24rem;display:flex" },
  settings: { markup: settings, frame: "height:30rem" },
  "disclosure and pagination": { markup: panels, frame: "display:grid;gap:1rem" },
  "nested root": { markup: nested, frame: "display:grid" },
};

const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
  // Transitions only delay the settled state that is measured here.
  `<style>solid-client,solid-island{display:contents}*,*::before,*::after{transition:none!important}` +
  `.rail-fixture{display:flex;flex-direction:column;align-items:center;gap:0.25rem;height:100%}</style>` +
  `</head><body class="k2b-ui" style="margin:0"><main style="padding:1.5rem">${body}</main></body></html>`;

type Problem = string;

/**
 * Tabs through the page. For every stop it compares the focused state with the
 * same scroll position unfocused: every box must keep its size and position,
 * and every ring that focus paints must lie inside each ancestor that clips it
 * and inside the viewport, in a colour that contrasts with what it is drawn on.
 */
const walk = async (target: Page): Promise<Problem[]> => {
  await target.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value) || 0;
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24)}"`;
    const all = () => Array.from(document.querySelectorAll("main *"));
    const geometry = () =>
      all().map((element) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      });
    const paint = () =>
      all().map((element) => {
        const style = getComputedStyle(element);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor} | ${style.boxShadow}`;
      });

    /** Paints one colour on a canvas and reads it back, which resolves every CSS colour syntax to sRGB. */
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = "#000";
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255] as const;
    };
    /** The opaque colour behind `element`'s own paint: its background composited over its ancestors'. */
    const backdrop = (element: Element | null) => {
      const layers: (readonly [number, number, number, number])[] = [];
      for (let node = element; node; node = node.parentElement) {
        const layer = rgba(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      let color: [number, number, number] = [255, 255, 255];
      for (const [r, g, b, a] of layers.reverse())
        color = [r * a + color[0] * (1 - a), g * a + color[1] * (1 - a), b * a + color[2] * (1 - a)];
      return color;
    };
    const luminance = ([r, g, b]: readonly number[]) => {
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const contrast = (a: readonly number[], b: readonly number[]) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };

    const topLayer = (element: Element) => element.matches(":modal, :popover-open");
    const establishesFixed = (style: CSSStyleDeclaration) =>
      style.transform !== "none" ||
      style.filter !== "none" ||
      style.perspective !== "none" ||
      /paint|layout|strict|content/.test(style.contain);
    /** Every ancestor whose overflow clips `element`, following containing blocks like the browser does. */
    const clippers = (element: Element) => {
      const found: { element: Element; x: boolean; y: boolean }[] = [];
      let current: Element | null = element;
      while (current && !topLayer(current)) {
        const position = getComputedStyle(current).position;
        let parent: Element | null = current.parentElement;
        const skips = (style: CSSStyleDeclaration) =>
          position === "fixed"
            ? !establishesFixed(style)
            : position === "absolute"
              ? style.position === "static" && !establishesFixed(style)
              : false;
        while (parent && skips(getComputedStyle(parent))) parent = parent.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        const style = getComputedStyle(parent);
        const contained = /paint|strict|content/.test(style.contain);
        const x = style.overflowX !== "visible" || contained;
        const y = style.overflowY !== "visible" || contained;
        if (x || y) found.push({ element: parent, x, y });
        current = parent;
      }
      return found;
    };

    /** The outer edge of the ring `element` paints: its outline, or an outer shadow; inset shadows stay inside. */
    const ring = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      let reach = Number.NEGATIVE_INFINITY;
      let outline = "";
      if (style.outlineStyle !== "none" && px(style.outlineWidth) > 0) {
        // Each engine paints the browser's `auto` ring at its own width, but none more than 2px beyond the offset.
        reach = (style.outlineStyle === "auto" ? 2 : px(style.outlineWidth)) + px(style.outlineOffset);
        outline = style.outlineColor;
      }
      for (const shadow of style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
        const lengths = (shadow.replace(/[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, "").match(/-?[\d.]+px/g) ?? []).map(px);
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
        reach = Math.max(reach, /\binset\b/.test(shadow) ? 0 : blur + spread + Math.max(Math.abs(x), Math.abs(y)));
      }
      // A ring drawn deeper than its own width ends inside the box.
      const edge = Number.isFinite(reach) ? reach : 0;
      return {
        rect: { left: box.left - edge, top: box.top - edge, right: box.right + edge, bottom: box.bottom + edge },
        /** The colour of an outline drawn inside the control, where it sits on the control's own fill. */
        insetOutline: outline && reach <= 0 ? outline : "",
      };
    };

    let rest: { geometry: number[][]; paint: string[] } | null = null;
    const state = {
      /** Measures the focused state, then the same scroll position without focus, then focuses again. */
      measure(): { done: boolean; problems: string[] } {
        const focused = document.activeElement;
        if (!focused || focused === document.body || !focused.closest("main")) return { done: true, problems: [] };
        const problems: string[] = [];
        const label = name(focused);
        const elements = all();
        const withFocus = { geometry: geometry(), paint: paint() };
        (focused as HTMLElement).blur();
        rest = { geometry: geometry(), paint: paint() };
        (focused as HTMLElement).focus({ preventScroll: true, focusVisible: true } as FocusOptions);

        elements.forEach((element, index) => {
          const before = rest!.geometry[index]!;
          const after = withFocus.geometry[index]!;
          if (before.some((value, axis) => Math.abs(value - after[axis]!) > 0.01)) {
            problems.push(
              `${label}: focus moves or resizes ${name(element)} from ${before.map((v) => v.toFixed(2))} to ${after.map((v) => v.toFixed(2))}`,
            );
          }
        });

        const hosts = elements.filter((_, index) => rest!.paint[index] !== withFocus.paint[index]);
        if (hosts.length === 0) problems.push(`${label}: no visible focus ring`);
        for (const host of hosts) {
          const painted = ring(host);
          const edges = painted.rect;
          for (const clipper of clippers(host)) {
            const element = clipper.element;
            const box = element.getBoundingClientRect();
            const border = getComputedStyle(element);
            const left = px(border.borderLeftWidth);
            const top = px(border.borderTopWidth);
            const right = px(border.borderRightWidth);
            const bottom = px(border.borderBottomWidth);
            // Client sizes round to whole pixels, so they only measure the scrollbars.
            const [outerWidth, outerHeight] = element instanceof HTMLElement ? [element.offsetWidth, element.offsetHeight] : [0, 0];
            const clip = {
              left: box.left + left,
              top: box.top + top,
              right: box.right - right - Math.max(0, Math.round(outerWidth - element.clientWidth - left - right)),
              bottom: box.bottom - bottom - Math.max(0, Math.round(outerHeight - element.clientHeight - top - bottom)),
            };
            const cut = [
              clipper.x && edges.left < clip.left - 0.01 ? `left ${(clip.left - edges.left).toFixed(2)}px` : "",
              clipper.y && edges.top < clip.top - 0.01 ? `top ${(clip.top - edges.top).toFixed(2)}px` : "",
              clipper.x && edges.right > clip.right + 0.01 ? `right ${(edges.right - clip.right).toFixed(2)}px` : "",
              clipper.y && edges.bottom > clip.bottom + 0.01 ? `bottom ${(edges.bottom - clip.bottom).toFixed(2)}px` : "",
            ].filter(Boolean);
            if (cut.length) problems.push(`${label}: ring cut by ${name(clipper.element)} (${cut.join(", ")})`);
          }
          const width = document.documentElement.clientWidth;
          const height = document.documentElement.clientHeight;
          if (edges.left < 0 || edges.top < 0 || edges.right > width || edges.bottom > height) {
            problems.push(`${label}: ring leaves the viewport`);
          }
          // A ring drawn inside a filled control sits on that fill, so it needs a colour of its own.
          if (painted.insetOutline && rgba(getComputedStyle(host).backgroundColor)[3] >= 0.5) {
            const fill = backdrop(host);
            const [r, g, b, a] = rgba(painted.insetOutline);
            const ratio = contrast([r * a + fill[0] * (1 - a), g * a + fill[1] * (1 - a), b * a + fill[2] * (1 - a)], fill);
            if (ratio < 3) problems.push(`${label}: inset ring contrast ${ratio.toFixed(2)}:1 on its own fill`);
          }
        }
        return { done: false, problems };
      },
    };
    Object.assign(window, { __focusRings: state });
  });

  const problems: Problem[] = [];
  const visited = new Set<string>();
  for (let step = 0; step < 120; step += 1) {
    await target.keyboard.press("Tab");
    const id = await target.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return "";
      active.dataset.focusRingStop ||= String(Math.random());
      return active.dataset.focusRingStop;
    });
    if (!id || visited.has(id)) break;
    visited.add(id);
    const result = await target.evaluate(() =>
      (window as unknown as { __focusRings: { measure(): { done: boolean; problems: string[] } } }).__focusRings.measure(),
    );
    if (result.done) break;
    problems.push(...result.problems);
  }
  if (visited.size === 0) problems.push("no focusable element was reached");
  return problems;
};

describe("@k2b/ui focus rings inside clipping containers", () => {
  for (const options of Object.values(viewports)) {
    for (const [scene, { markup: render, frame }] of Object.entries(scenes)) {
      test(`${scene} at ${options.viewport.width} px: every ring stays visible and focus never moves a box`, async () => {
        const target = await browser.newPage(options);
        try {
          await target.setContent(page(`<div style="${frame}">${render()}</div>`));
          expect(await walk(target)).toEqual([]);
        } finally {
          await target.close();
        }
      });
    }
  }
});

describe("@k2b/ui focus ring colours inside clipping containers", () => {
  test("only filled controls draw their ring in their label colour", async () => {
    const target = await browser.newPage(viewports.desktop);
    try {
      const picker = html(() =>
        createComponent(ScrollArea, {
          get children() {
            return createComponent(DateRangePicker, {
              label: "Window",
              clearable: true,
              withTime: true,
              value: { start: "2026-07-27T07:00:00.000Z", end: "2026-07-27T08:00:00.000Z" },
              dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
              durationPresets: [
                { label: "30 min", minutes: 30 },
                { label: "1 hour", minutes: 60 },
              ],
            });
          },
        }),
      );
      await target.setContent(page(picker));
      await target.evaluate(() => document.querySelector<HTMLElement>(".k2b-date-popover")?.showPopover());
      // A key press first, so focus from script shows its ring like focus from the keyboard.
      await target.keyboard.press("Shift");
      const rings = await target.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(document.body).getPropertyValue("--k2b-focus-ring").trim();
        document.body.append(probe);
        const focusColour = getComputedStyle(probe).color;
        probe.remove();
        return [
          ".k2b-date-trigger__clear",
          ".k2b-date-durations button",
          ".k2b-date-durations button[aria-pressed='true']",
          ".k2b-date-apply",
        ].map((selector) => {
          const control = document.querySelector<HTMLElement>(selector)!;
          control.focus();
          const style = getComputedStyle(control);
          const colour =
            style.outlineColor === focusColour ? "focus colour" : style.outlineColor === style.color ? "label colour" : style.outlineColor;
          return [control.textContent?.trim() || control.getAttribute("aria-label"), control.matches(":focus-visible"), colour];
        });
      });
      expect(rings).toEqual([
        ["Clear date", true, "focus colour"],
        ["30 min", true, "focus colour"],
        ["1 hour", true, "focus colour"],
        ["Apply", true, "label colour"],
      ]);
    } finally {
      await target.close();
    }
  });
});

describe("@k2b/ui focus rings outside clipping containers", () => {
  test("keep today's outside ring in the focus colour", async () => {
    const target = await browser.newPage(viewports.desktop);
    try {
      const controls = html(() => [
        text("Cancel"),
        text("Save", "primary"),
        text("Delete", "danger"),
        createComponent(Checkbox, { label: "Notify members", value: true }),
        createComponent(Switch, { label: "Public board", value: true }),
      ]);
      await target.setContent(page(`<div style="display:flex;gap:1rem;align-items:center">${controls}</div>`));
      const rings: string[][] = [];
      for (let step = 0; step < 5; step += 1) {
        await target.keyboard.press("Tab");
        rings.push(
          await target.evaluate(() => {
            const focused = document.activeElement as HTMLElement;
            const host = focused.matches("input") ? (focused.nextElementSibling as HTMLElement) : focused;
            const style = getComputedStyle(host);
            const ring = getComputedStyle(document.body).getPropertyValue("--k2b-focus-ring").trim();
            const probe = document.createElement("span");
            probe.style.color = ring;
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return [
              (focused.getAttribute("aria-label") ?? focused.closest("label")?.textContent ?? focused.textContent ?? "").trim(),
              `${style.outlineWidth} ${style.outlineStyle} ${style.outlineOffset}`,
              style.outlineColor === expected ? "focus colour" : style.outlineColor,
            ];
          }),
        );
      }
      expect(rings).toEqual([
        ["Cancel", "2px solid 2px", "focus colour"],
        ["Save", "2px solid 2px", "focus colour"],
        ["Delete", "2px solid 2px", "focus colour"],
        ["Notify members", "2px solid 2px", "focus colour"],
        ["Public board", "2px solid 2px", "focus colour"],
      ]);
    } finally {
      await target.close();
    }
  });
});
