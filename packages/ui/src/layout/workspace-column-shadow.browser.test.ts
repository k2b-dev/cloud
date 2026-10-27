import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { clientFixture, type FixtureOptions, workspaceCss, workspaceFrames } from "../../test/workspace-host-fixture";

// Every column boundary of a workspace carries the same quiet shadow and no
// line, whatever DOM nesting the columns use: sidebar, panes, levels, Detail.
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-column-shadow-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const script = await clientFixture();
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const shades = [".k2b-app-workspace__content::before", ".k2b-app-workspace__content::after", "[data-workspace-main-region]::before"].join(
  ",",
);

const load = async (width: number, options: FixtureOptions, dark: boolean) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" ${dark ? 'data-theme="dark"' : ""} style="margin:0">
        <script type="application/json" data-k2b-page-trail>{"title":"Messages","ancestors":[]}</script>
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
        .k2b-app-workspace__detail *, .k2b-app-workspace__resize, .k2b-app-workspace__drawer * { visibility: hidden }`,
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

const luminance = (page: Page, png: Buffer, points: { x: number; y: number }[]) =>
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
      return points.map(({ x, y }) => {
        const data = context.getImageData(x, y, 1, 1).data;
        return (data[0]! + data[1]! + data[2]!) / 3;
      });
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, points },
  );

/** How much darker the shade makes a point: the same frame with and without it. */
const shadeAt = async (page: Page, points: { x: number; y: number }[]) => {
  const shaded = await luminance(page, await page.screenshot(), points);
  const suppress = await page.addStyleTag({ content: `${shades} { content: none !important }` });
  await settled(page);
  const plain = await luminance(page, await page.screenshot(), points);
  await suppress.evaluate((element) => element.parentNode?.removeChild(element));
  await settled(page);
  return { shade: plain.map((value, index) => value - shaded[index]!), plain };
};

const scenarios: { label: string; options: FixtureOptions; expected: string[] }[] = [
  { label: "sidebar, list pane, reading area, and Detail", options: {}, expected: ["sidebar", "main", "detail"] },
  { label: "sidebar and three levels", options: { scenario: "levels" }, expected: ["sidebar", "messages", "reader"] },
];

for (const dark of [false, true])
  for (const { label, options, expected } of scenarios)
    test(`1440 ${dark ? "dark" : "light"}: ${label} share one quiet shadow at every boundary and no line`, async () => {
      const page = await load(1440, options, dark);
      try {
        const edges = await boundaries(page);
        expect(edges.map((edge) => edge.name)).toEqual(expected);
        const y = 300;
        const points = edges.flatMap(({ x }) => [-1, -12, -23, -30, 1].map((offset) => ({ x: x + offset, y })));
        const { shade, plain } = await shadeAt(page, points);
        const rows = edges.map((edge, index) => {
          const [edgeShade, mid, start, outside, right] = shade.slice(index * 5, index * 5 + 5);
          return {
            name: edge.name,
            edgeShade,
            mid,
            start,
            outside,
            right,
            edgePlain: plain[index * 5]!,
            innerPlain: plain[index * 5 + 1]!,
          };
        });
        const strongest = Math.max(...rows.map((row) => row.edgeShade!));
        for (const row of rows) {
          // Darkest at the boundary, fading over 24 px into the column before it.
          expect(row.edgeShade!).toBeGreaterThanOrEqual(dark ? 0.9 : 4);
          expect(row.edgeShade!).toBeLessThanOrEqual(dark ? 3 : 8);
          expect(row.mid!).toBeLessThan(row.edgeShade!);
          expect(row.start!).toBeLessThanOrEqual(dark ? 1 : 1.5);
          expect(row.outside!).toBe(0);
          // The column on the right is untouched: the shade falls to the left.
          expect(row.right!).toBe(0);
          // One shadow everywhere, not a stronger one at a single boundary.
          expect(strongest - row.edgeShade!).toBeLessThanOrEqual(1.5);
        }
        // Without the shade, the column before a boundary keeps its own paint up
        // to the edge: no line. A raised last level brings its own frame, which
        // the level styling owns.
        const raised = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-workspace-main-region]")]
            .filter((element) => getComputedStyle(element).boxShadow !== "none")
            .map((element) => element.dataset.workspaceMainRegion),
        );
        for (const row of rows.filter((row) => !raised.includes(row.name)))
          expect(Math.abs(row.edgePlain - row.innerPlain)).toBeLessThanOrEqual(0.5);
        // The shade is paint only and lighter at the bottom.
        const paints = await page.evaluate(() =>
          [
            getComputedStyle(document.querySelector(".k2b-app-workspace__content")!, "::before"),
            ...[...document.querySelectorAll("[data-workspace-main-region]")]
              .map((element) => getComputedStyle(element, "::before"))
              .filter((style) => style.content !== "none"),
          ].map((style) => ({ width: style.width, pointerEvents: style.pointerEvents, mask: style.maskImage !== "none" })),
        );
        expect(paints.length).toBe(expected.filter((name) => name !== "detail").length);
        for (const paint of paints) expect(paint).toEqual({ width: "24px", pointerEvents: "none", mask: true });
        // Main draws no side shadow of its own, and no column draws a line.
        expect(
          await page.evaluate(() => {
            const main = getComputedStyle(document.querySelector(".k2b-app-workspace__main")!).boxShadow;
            const lines = [
              ...document.querySelectorAll(".k2b-app-workspace__sidebar, [data-workspace-main-region], .k2b-app-workspace__detail"),
            ]
              .map((element) => getComputedStyle(element))
              .flatMap((style) => [
                [style.borderLeftWidth, style.borderLeftColor],
                [style.borderRightWidth, style.borderRightColor],
              ])
              .filter(([width, color]) => parseFloat(width!) > 0 && !/rgba\([^)]*, 0\)$/.test(color!));
            return { main, lines: lines.length };
          }),
        ).toEqual({ main: "none", lines: 0 });
      } finally {
        await page.close();
      }
    });

test("1440: the bottom 96 px of a boundary shade fade to 45 %", async () => {
  const page = await load(1440, { scenario: "levels" }, false);
  try {
    const [, level] = await boundaries(page);
    const bottom = await page
      .locator('[data-workspace-main-region="messages"]')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    const { shade } = await shadeAt(page, [
      { x: level!.x - 1, y: 300 },
      { x: level!.x - 1, y: Math.floor(bottom) - 2 },
    ]);
    expect(shade[1]!).toBeGreaterThan(0);
    expect(shade[1]!).toBeLessThan(shade[0]!);
  } finally {
    await page.close();
  }
});

for (const options of [{}, { scenario: "levels" }] as FixtureOptions[])
  test(`390: a phone shows one column at a time and no boundary shade (${options.scenario ?? "panes"})`, async () => {
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
