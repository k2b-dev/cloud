import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { clientFixture, type FixtureOptions, workspaceCss, workspaceFrames } from "../../test/workspace-host-fixture";

// K2, K3, K13: every column boundary of a workspace is one 1 px hairline in the
// one line colour, never a shadow, whatever DOM nesting the columns use:
// sidebar, panes, levels, Detail. A boundary that can be dragged carries a
// 5 x 32 px grip on that line. Hover, keyboard focus, and dragging move
// nothing; focus and drag turn grip and line blue.
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-hairlines-"));
registerSsrTestPlugin({ dev: true, rootDir: directory });

process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const script = await clientFixture();
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, options: FixtureOptions, dark: boolean, hideHandles = true) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" ${dark ? 'data-theme="dark"' : ""} style="margin:0">
        <script type="application/json" data-k2b-page-trail>{"title":"Messages","ancestors":[]}</script>
        <button id="park" style="position:fixed;left:0;bottom:0">Away</button>
        <div id="app" style="height:100vh;margin-inline:64px"></div>
      </body></html>`);
    await page.evaluate((options) => {
      document.body.dataset.options = JSON.stringify(options);
    }, options);
    await page.addScriptTag({ content: script });
    await workspaceFrames(page);
    // Only the columns' own paint stays, so pixels show the boundary alone.
    await page.addStyleTag({
      content: `.k2b-app-workspace__sidebar *, .k2b-app-workspace__main-primary *, .k2b-app-workspace__main-pane *,
        .k2b-app-workspace__detail *, .k2b-app-workspace__drawer * { visibility: hidden }
        ${hideHandles ? ".k2b-app-workspace__resize { visibility: hidden }" : ""}`,
    });
    await settled(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};

/** The left edge of every column that follows another column. */
const boundaries = (page: Page) =>
  page.evaluate(() => {
    const shown = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => getComputedStyle(element).display !== "none");
    return [
      ...shown(".k2b-app-workspace__content").map((element) => ({ name: "sidebar", x: element.getBoundingClientRect().left })),
      ...shown("[data-workspace-main-region]")
        .slice(1)
        .map((element) => ({ name: element.dataset.workspaceMainRegion!, x: element.getBoundingClientRect().left })),
      ...shown(".k2b-app-workspace__detail").map((element) => ({ name: "detail", x: element.getBoundingClientRect().left })),
    ].map(({ name, x }) => ({ name, x: Math.round(x) }));
  });

const pixels = (page: Page, png: Buffer, points: { x: number; y: number }[]) =>
  page.evaluate(
    async ({ src, points }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, points },
  );

/** The computed colour of `--k2b-border` and `--k2b-focus-ring` as the engine paints them. */
const tokens = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("i");
    document.querySelector(".k2b-app-workspace")!.append(probe);
    const read = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const result = { border: read("var(--k2b-border)"), focus: read("var(--k2b-focus-ring)") };
    probe.remove();
    return result;
  });

/** Every boundary line: its painted box and colour. */
const lineBoxes = (page: Page) =>
  page.evaluate(() => {
    const out: { width: string; color: string; shadow: string; mask: string }[] = [];
    const read = (element: Element, pseudo: string) => {
      const style = getComputedStyle(element, pseudo);
      if (style.content === "none" || style.content === "normal" || style.width === "0px" || style.width === "auto") return;
      out.push({ width: style.width, color: style.backgroundColor, shadow: style.boxShadow, mask: style.maskImage });
    };
    for (const element of document.querySelectorAll(".k2b-app-workspace__content")) {
      read(element, "::before");
      read(element, "::after");
    }
    for (const element of document.querySelectorAll("[data-workspace-main-region]")) read(element, "::before");
    return out;
  });

const scenarios: { label: string; options: FixtureOptions; expected: string[] }[] = [
  { label: "sidebar, list pane, reading area, and Detail", options: {}, expected: ["sidebar", "main", "detail"] },
  { label: "sidebar and three levels", options: { scenario: "levels" }, expected: ["sidebar", "messages", "reader"] },
];

for (const dark of [false, true])
  for (const { label, options, expected } of scenarios)
    test(`1440 ${dark ? "dark" : "light"}: ${label} share one hairline at every boundary and no shadow`, async () => {
      const page = await load(1440, options, dark);
      try {
        const edges = await boundaries(page);
        expect(edges.map((edge) => edge.name)).toEqual(expected);
        const { border } = await tokens(page);
        // Each line is 1 px of the one line colour, without shadow or fade.
        const boxes = await lineBoxes(page);
        expect(boxes.length).toBe(expected.length);
        for (const box of boxes) expect(box).toEqual({ width: "1px", color: border, shadow: "none", mask: "none" });
        // Painted: the pixel left of the boundary is the line; the pixels before it are the column's own paint.
        const y = 300;
        const shot = await pixels(
          page,
          await page.screenshot(),
          edges.flatMap(({ x }) => [-1, -2, -5, 1].map((offset) => ({ x: x + offset, y }))),
        );
        const expectedLine = border.match(/\d+/g)!.slice(0, 3).map(Number);
        edges.forEach((edge, index) => {
          const [line, near, far, right] = shot.slice(index * 4, index * 4 + 4);
          for (let channel = 0; channel < 3; channel++) expect(Math.abs(line![channel]! - expectedLine[channel]!)).toBeLessThanOrEqual(2);
          // No shade beside the line: the column before keeps one paint up to it, and so does the column after.
          expect(near).toEqual(far!);
          expect(right).not.toEqual(line!);
        });
        // No column draws a border of its own beside the line: one line per boundary (K2).
        expect(
          await page.evaluate(
            () =>
              [...document.querySelectorAll(".k2b-app-workspace__sidebar, [data-workspace-main-region], .k2b-app-workspace__detail")]
                .map((element) => getComputedStyle(element))
                .flatMap((style) => [
                  [style.borderLeftWidth, style.borderLeftColor],
                  [style.borderRightWidth, style.borderRightColor],
                ])
                .filter(([width, color]) => parseFloat(width!) > 0 && !/rgba\([^)]*, 0\)$/.test(color!)).length,
          ),
        ).toBe(0);
      } finally {
        await page.close();
      }
    });

type Edge = { index: number; name: string; handle: { x: number; y: number } };

/** Each visible column handle. */
const handles = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-app-workspace-resize]")]
      .map((handle, index) => ({ handle, index }))
      .filter(
        ({ handle }) =>
          handle.getClientRects().length > 0 &&
          getComputedStyle(handle).display !== "none" &&
          handle.dataset.appWorkspaceResize !== "drawer",
      )
      .map(({ handle, index }) => {
        const box = handle.getBoundingClientRect();
        return {
          index,
          name: `${handle.dataset.appWorkspaceResize} ${handle.getAttribute("aria-controls")}`,
          handle: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        };
      }),
  ) as Promise<Edge[]>;

/** Every column's and line's geometry plus each grip's box and colour: what must not move. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height].map((value) => Math.round(value * 10) / 10).join(",");
    };
    return {
      columns: [
        ...document.querySelectorAll(
          ".k2b-app-workspace__sidebar, .k2b-app-workspace__content, [data-workspace-main-region], .k2b-app-workspace__detail",
        ),
      ].map(rect),
      grips: [...document.querySelectorAll(".k2b-app-workspace__resize > span")].map(rect),
    };
  });

const away = async (page: Page) => {
  await page.mouse.move(1, 1);
  await page.locator("#park").focus();
  await settled(page);
};

for (const { label, options } of scenarios)
  test(`1440: ${label}: every draggable edge shows its grip at rest; hover, focus, and drag move nothing`, async () => {
    const page = await load(1440, options, false, false);
    try {
      await away(page);
      const shown = await handles(page);
      expect(shown.length).toBe(3);
      const { border, focus } = await tokens(page);
      // The grip: 5 x 32 px, round, grey, visible without hover, centred on its handle (K13).
      const grips = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".k2b-app-workspace__resize")]
          .filter((handle) => getComputedStyle(handle).display !== "none")
          .map((handle) => {
            const grip = handle.querySelector("span")!;
            const box = grip.getBoundingClientRect();
            const area = handle.getBoundingClientRect();
            const style = getComputedStyle(grip);
            const across = handle.getAttribute("aria-orientation") === "horizontal";
            return {
              size: across ? `${Math.round(box.height)}x${Math.round(box.width)}` : `${Math.round(box.width)}x${Math.round(box.height)}`,
              round: parseFloat(style.borderTopLeftRadius) >= Math.min(box.width, box.height) / 2,
              visible: style.opacity === "1" && style.visibility === "visible",
              centred: across
                ? Math.abs(box.top + box.height / 2 - (area.top + area.height / 2)) <= 0.5
                : Math.abs(box.left + box.width / 2 - (area.left + area.width / 2)) <= 0.5,
              area: Math.round(across ? area.height : area.width),
              role: handle.getAttribute("role"),
              aria: ["aria-orientation", "aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-controls", "aria-label"].every((name) =>
                handle.hasAttribute(name),
              ),
            };
          }),
      );
      for (const grip of grips)
        expect(grip).toEqual({ size: "5x32", round: true, visible: true, centred: true, area: 13, role: "separator", aria: true });
      const rest = await frame(page);
      const lineColour = () =>
        page.evaluate(() => {
          const colours = [] as string[];
          for (const element of document.querySelectorAll(".k2b-app-workspace__content")) {
            for (const pseudo of ["::before", "::after"]) {
              const style = getComputedStyle(element, pseudo);
              if (style.content !== "none" && style.content !== "normal") colours.push(style.backgroundColor);
            }
          }
          for (const element of document.querySelectorAll("[data-workspace-main-region]")) {
            const style = getComputedStyle(element, "::before");
            if (style.content !== "none" && style.content !== "normal") colours.push(style.backgroundColor);
          }
          return colours;
        });
      const states: { name: string; enter: (edge: Edge) => Promise<void>; leave: () => Promise<void>; blue: boolean }[] = [
        { name: "hover", enter: (edge) => page.mouse.move(edge.handle.x, edge.handle.y), leave: () => away(page), blue: false },
        {
          name: "keyboard focus",
          enter: async (edge) => {
            await page.keyboard.press("Tab");
            await page.locator("[data-app-workspace-resize]").nth(edge.index).focus();
          },
          leave: () => away(page),
          blue: true,
        },
        {
          name: "drag",
          enter: async (edge) => {
            await page.mouse.move(edge.handle.x, edge.handle.y);
            await page.mouse.down();
          },
          leave: async () => {
            await page.mouse.up();
            await away(page);
          },
          blue: true,
        },
      ];
      const found: unknown[] = [];
      const wanted: unknown[] = [];
      for (const edge of shown)
        for (const state of states) {
          await state.enter(edge);
          await settled(page);
          const during = await frame(page);
          const colours = await lineColour();
          const grip = await page
            .locator("[data-app-workspace-resize]")
            .nth(edge.index)
            .evaluate((handle) => getComputedStyle(handle.querySelector("span")!).backgroundColor);
          await state.leave();
          found.push({
            edge: edge.name,
            state: state.name,
            moved: JSON.stringify(during) !== JSON.stringify(rest),
            blueLine: colours.includes(focus),
            blueGrip: grip === focus,
          });
          wanted.push({ edge: edge.name, state: state.name, moved: false, blueLine: state.blue, blueGrip: state.blue });
        }
      expect(found).toEqual(wanted);
      // Back at rest, every line has the line colour again.
      for (const colour of await lineColour()) expect(colour).toBe(border);
    } finally {
      await page.close();
    }
  });

for (const width of [390, 900])
  test(`${width}: phones and tablets show no grip and no draggable edge`, async () => {
    const page = await load(width, {}, false, false);
    try {
      expect(
        await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>(".k2b-app-workspace__resize")].filter(
              (handle) => getComputedStyle(handle).display !== "none" && handle.getClientRects().length > 0,
            ).length,
        ),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });

for (const options of [{}, { scenario: "levels" }] as FixtureOptions[])
  test(`390: a phone shows one column at a time and no boundary line (${options.scenario ?? "panes"})`, async () => {
    const page = await load(390, options, false);
    try {
      const generated = await page.evaluate(
        () =>
          [
            ...[...document.querySelectorAll(".k2b-app-workspace__content")].flatMap((element) => [
              getComputedStyle(element, "::before"),
              getComputedStyle(element, "::after"),
            ]),
            ...[...document.querySelectorAll("[data-workspace-main-region]")].map((element) => getComputedStyle(element, "::before")),
          ].filter((style) => style.content !== "none" && style.content !== "normal").length,
      );
      expect(generated).toBe(0);
    } finally {
      await page.close();
    }
  });

/** For every shown column with rows: the space from its fill's side edges to each row and to its group title. */
const insets = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-workspace-main-region]")]
      .filter((column) => column.getClientRects().length > 0 && column.querySelector(".k2b-app-workspace__sidebar-item"))
      .map((column) => {
        const box = column.getBoundingClientRect();
        // A fill stops before the space at a pane's end, so its edge is the border's inner edge.
        const end = box.right - parseFloat(getComputedStyle(column).borderRightWidth);
        const round = (value: number) => Math.round(value * 10) / 10;
        const rows = [...column.querySelectorAll(".k2b-app-workspace__sidebar-item")].map((row) => {
          const { left, right } = row.getBoundingClientRect();
          return { start: round(left - box.left), end: round(end - right) };
        });
        const title = column.querySelector(".k2b-app-workspace__sidebar-section-header h2")!.getBoundingClientRect();
        // A back step lines up its icon, not its target, so only a head without one counts.
        const back = column.querySelector(".k2b-app-workspace__level-back");
        const head = back?.getClientRects().length ? null : column.querySelector(".k2b-app-workspace__level-title");
        return {
          name: column.dataset.workspaceMainRegion,
          rows,
          title: round(title.left - box.left),
          head: head ? round(head.getBoundingClientRect().left - box.left) : null,
        };
      }),
  );

// A line marks every column edge, so content that touches one edge reads as
// stuck to it: rows and group titles keep the same space from both side edges,
// whether a classic scrollbar takes room at the end or not.
for (const [width, options] of [
  [1440, { scenario: "levels", rows: true }],
  [1440, { rows: true }],
  [390, { scenario: "levels", rows: true }],
] as [number, FixtureOptions][])
  test(`${width}: rows in every ${options.scenario ?? "pane"} column keep the same space from both side edges`, async () => {
    const page = await load(width, options, false);
    try {
      await page.addStyleTag({ content: "* { visibility: visible !important }" });
      const columns = await insets(page);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        for (const row of column.rows) expect({ name: column.name, ...row }).toEqual({ name: column.name, start: 8, end: 8 });
        // A group title lines up with a level's head, 1rem from the edge.
        expect(column.title).toBe(16);
        if (column.head !== null) expect(column.head).toBe(16);
      }
      // Hover and focus paint only: every row keeps its place.
      const row = page.locator(".k2b-app-workspace__main .k2b-app-workspace__sidebar-item >> visible=true").nth(1);
      await hoverInPlace(row);
      await settled(page);
      expect(await insets(page)).toEqual(columns);
      await row.focus();
      await settled(page);
      expect(await insets(page)).toEqual(columns);
      // A column that starts to scroll keeps the same space: the end track is
      // there before anything overflows, also where no gutter is reserved.
      await page.evaluate(() => {
        for (const section of document.querySelectorAll(".k2b-app-workspace__main .k2b-app-workspace__sidebar-section"))
          for (let copy = 0; copy < 30; copy++) section.after(section.cloneNode(true));
      });
      await settled(page);
      const grown = await insets(page);
      expect(grown.map((column) => column.rows.length)).toEqual(columns.map((column) => column.rows.length * 31));
      for (const column of grown)
        for (const row of column.rows) expect({ name: column.name, ...row }).toEqual({ name: column.name, start: 8, end: 8 });
    } finally {
      await page.close();
    }
  });
