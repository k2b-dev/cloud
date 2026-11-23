import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { describeV2Page, measureV2Layout } from "./testing";
import { heights, textEdge, typeRoles } from "./tokens";

// The v2 foundation measured in a browser, and the layout measurement itself proved red and green on small pages
// built like the mockup: two columns with a 1 px line between them, rows, a grip on the line.
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const TEST_TIMEOUT = 20_000;

// Page structure for the fixtures only, on the v2 tokens; the primitives bring their own later.
const fixtureCss = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
.ws { position: relative; display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 400px; background: var(--k2-surface); }
.ws > .col + .col { border-left: var(--k2-hairline); }
.col { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.row { min-height: var(--k2-h-row); padding: 8px var(--k2-edge); border-bottom: var(--k2-hairline); font: var(--k2-t-row); }
.band { padding: 12px var(--k2-edge); border-bottom: var(--k2-hairline); font: var(--k2-t-row); }
.band.top { border-top: var(--k2-hairline); }
.tint { background: var(--k2-blue-tint); height: 52px; }
.padded { padding-inline: 8px; }
.seam { display: contents; }
.seam::after { content: ""; display: block; height: 1px; background: var(--k2-line); }
.grip { position: absolute; top: calc(50% - 10px); left: 248px; width: 11px; height: 20px; margin-left: -5px; z-index: 3;
  border-radius: var(--k2-r-mark); background: var(--k2-n100); box-shadow: inset 0 0 0 1px var(--k2-line-control); }
.grip.off { margin-left: -4px; }
`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (body: string, { width = 1440, scale = 1, dark = false } = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 600 }, deviceScaleFactor: scale });
  await page.setContent(
    `<!doctype html><html lang="en" class="${dark ? "dark" : ""}"><head><style>${css}</style><style>${fixtureCss}</style></head>` +
      `<body><div class="k2-ui" id="app">${body}</div></body></html>`,
  );
  await settled(page);
  return page;
};

const columns = (main: string, side = '<div class="row">Inbox</div><div class="row">Sent</div>') =>
  `<div class="ws"><nav class="col" data-k2-column>${side}</nav><main class="col" data-k2-column>${main}</main><span class="grip" data-k2-grip data-probe="grip"></span></div>`;

const clean = columns(
  [
    '<div class="row"><span class="k2-t-body k2-strong">Lackfabrik Nordhaus</span></div>',
    '<div class="band"><span class="k2-t-meta">seit 09:12</span></div>',
    '<div class="tint"></div>',
    // A line drawn by a pseudo-element under display: contents, which itself has no box.
    '<div class="seam"></div>',
    '<p class="k2-text k2-t-lead" style="margin:12px 0">3 offen</p>',
  ].join(""),
);

describe("v2.css in a browser", () => {
  for (const [width, edge] of [
    [1440, textEdge.wide],
    [390, textEdge.phone],
  ] as const)
    test(
      `${width} px: four type roles, text edge ${edge} px and ${edge + textEdge.afterIcon} px after an icon, one 1 px hairline`,
      async () => {
        const page = await open(
          `${Object.keys(typeRoles)
            .map((role) => `<span class="k2-t-${role}" data-role="${role}">${role}</span>`)
            .join(
              "",
            )}<p class="k2-text" data-probe="text">Text</p><p data-probe="icon" style="padding-left:var(--k2-edge-icon)">After an icon</p><div data-probe="line" style="border-bottom:var(--k2-hairline)"></div>`,
          { width },
        );
        try {
          const measured = await page.evaluate(() => {
            const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
            const roles = Object.fromEntries(
              Array.from(document.querySelectorAll("[data-role]")).map((element) => {
                const s = getComputedStyle(element);
                return [element.getAttribute("data-role"), { size: s.fontSize, lineHeight: s.lineHeight, weight: s.fontWeight }];
              }),
            );
            return {
              roles,
              text: style('[data-probe="text"]').paddingLeft,
              icon: style('[data-probe="icon"]').paddingLeft,
              line: [style('[data-probe="line"]').borderBottomWidth, style('[data-probe="line"]').borderBottomColor],
            };
          });
          for (const [role, { size, lineHeight, weight }] of Object.entries(typeRoles))
            expect(measured.roles[role]).toEqual({ size: `${size}px`, lineHeight: `${lineHeight}px`, weight: `${weight}` });
          expect(measured.text).toBe(`${edge}px`);
          expect(measured.icon).toBe(`${edge + textEdge.afterIcon}px`);
          expect(measured.line).toEqual(["1px", "rgb(228, 228, 231)"]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "dark mode changes colours only, never a measure",
    async () => {
      const read = async (dark: boolean) => {
        const page = await open('<div class="row" data-probe="row">Row</div>', { dark });
        try {
          return await page.evaluate(() => {
            const app = getComputedStyle(document.getElementById("app")!);
            const row = document.querySelector('[data-probe="row"]')!;
            return { color: app.color, surface: app.getPropertyValue("--k2-surface").trim(), height: row.getBoundingClientRect().height };
          });
        } finally {
          await page.close();
        }
      };
      const [light, dark] = [await read(false), await read(true)];
      expect(light.surface).toBe("#ffffff");
      expect(dark.surface).toBe("#11151b");
      expect(dark.color).not.toBe(light.color);
      expect(dark.height).toBe(light.height);
      expect(light.height).toBe(heights.row);
    },
    TEST_TIMEOUT,
  );

  test(
    "dark three ways, and a light island in a dark page stays light",
    async () => {
      const page = await open(
        // A light page with a dark scope by class, one by data-theme, and a dark part with a light island in it.
        '<div class="k2-ui dark" data-probe="class"></div><div class="k2-ui" data-theme="dark" data-probe="theme"></div>' +
          '<div class="dark"><div class="k2-ui" data-probe="page"></div><div class="k2-ui" data-theme="light" data-probe="island"></div></div>',
      );
      try {
        const surfaces = await page.evaluate(() =>
          Object.fromEntries(
            ["#app", '[data-probe="page"]', '[data-probe="class"]', '[data-probe="theme"]', '[data-probe="island"]'].map((selector) => [
              selector,
              getComputedStyle(document.querySelector(selector)!).getPropertyValue("--k2-surface").trim(),
            ]),
          ),
        );
        expect(surfaces).toEqual({
          "#app": "#ffffff",
          '[data-probe="page"]': "#11151b",
          '[data-probe="class"]': "#11151b",
          '[data-probe="theme"]': "#11151b",
          '[data-probe="island"]': "#ffffff",
        });
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("measureV2Layout", () => {
  for (const scale of [1, 2])
    test(
      `green at DPR ${scale}: lines reach their edges, no double line, roles only, the grip centred on its line`,
      async () => {
        const page = await open(clean, { scale });
        try {
          const before = await page.content();
          const result = await measureV2Layout(page);
          expect(result.problems).toEqual([]);
          // Lines: the column line, 4 row lines, 1 band line, the pseudo line, the grip's frame (4 sides).
          expect(result.measured.lines).toBeGreaterThanOrEqual(10);
          expect(result.measured.bands).toBe(1);
          expect(result.grips).toEqual([{ grip: '[data-probe="grip"]', dom: 0, pixels: 0, lineWidth: 1 }]);
          // The stand-ins for pseudo-elements are gone again.
          expect(await page.content()).toBe(before);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "red: a line in a padded wrapper stops short of its column edge (the flat build's 8 px)",
    async () => {
      const page = await open(
        columns('<div class="padded"><div class="row">Row</div></div><div class="padded"><div class="tint"></div></div>'),
      );
      try {
        const { edge } = await measureV2Layout(page);
        expect(edge).toHaveLength(2);
        expect(edge[0]).toMatch(/^line div\.row border-bottom at y 39 stops 8 px short of the left and 8 px short of the right edge/);
        expect(edge[1]).toMatch(/^band div\.tint at y 40 stops 8 px short of the left and 8 px short of the right edge/);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: two lines on top of each other, also when a pseudo-element under display: contents draws one",
    async () => {
      const page = await open(
        columns('<div class="band">One</div><div class="band top">Two</div><div class="row">Row</div><div class="seam"></div>'),
      );
      try {
        const { double, edge } = await measureV2Layout(page);
        expect(edge).toEqual([]);
        expect(double).toEqual([
          expect.stringMatching(/^double line: div\.band border-bottom and div\.band\.top border-top at \d+ px over 1191 px$/),
          expect.stringMatching(/^double line: div\.row border-bottom and div\.seam::after box at \d+ px over 1191 px$/),
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a pseudo line whose stand-in would change a :last-child neighbour is reported, not measured as a false double line",
    async () => {
      const page = await open(
        `<style>.grp > .row:last-child { border-bottom: 0; } .grp.end::after { content: ""; display: block; height: 1px; background: var(--k2-line); }</style>` +
          columns('<div class="grp end" data-probe="group"><div class="row">One</div><div class="row">Two</div></div>'),
      );
      try {
        const result = await measureV2Layout(page);
        expect(result.double).toEqual([]);
        expect(result.pseudo).toEqual([
          'pseudo-element [data-probe="group"]::after cannot be measured: in its place a real element changes div.row (a sibling selector such as :last-child depends on it)',
        ]);
        expect(result.problems).toEqual(result.pseudo);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "green: a :last-child rule beside a pseudo line its stand-in does not disturb",
    async () => {
      const page = await open(
        `<style>.grp > .row:last-child { border-bottom: 0; } .grp.start::before { content: ""; display: block; height: 1px; background: var(--k2-line); }</style>` +
          columns('<div class="grp start"><div class="row">One</div><div class="row">Two</div></div>'),
      );
      try {
        const result = await measureV2Layout(page);
        expect(result.problems).toEqual([]);
        expect(result.pseudo).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  // A head with tabs: the active tab's 2 px mark reaches 1 px below the tab box onto the head line and covers it.
  const head = (overflow: string) =>
    `<style>.head { display: flex; height: var(--k2-h-tabs); padding: 0 var(--k2-edge); border-bottom: var(--k2-hairline); font: var(--k2-t-row); }` +
    ` .tabs { display: flex; overflow: ${overflow}; } .tab { display: flex; align-items: center; border-bottom: 2px solid var(--k2-app, var(--k2-blue)); margin-bottom: -1px; }</style>` +
    columns('<div class="head"><div class="tabs"><span class="tab">Inbox</span></div></div>');

  test(
    "green: overflow: clip visible cuts only sideways, so the 2 px tab mark stays whole on the head line",
    async () => {
      const page = await open(head("clip visible"));
      try {
        expect((await measureV2Layout(page)).problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: overflow: hidden cuts the tab mark to 1 px beside the head line, a double line",
    async () => {
      const page = await open(head("hidden"));
      try {
        expect((await measureV2Layout(page)).double).toEqual([
          expect.stringMatching(/^double line: span\.tab border-bottom and div\.head border-bottom at \d+ px over [\d.]+ px$/),
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: text outside the four roles and three weights",
    async () => {
      const page = await open(
        columns(
          '<div class="row"><span style="font-size:11px">11 px</span> <b style="font-weight:700">bold</b></div><div class="k2-t-body" data-k2-prose><h3 style="font:600 16px/22px sans-serif">Prose heading</h3></div>',
        ),
      );
      try {
        expect((await measureV2Layout(page)).type).toEqual([
          "text outside the type roles: 11px/20px 400 in span",
          "text outside the type roles: 13px/20px 700 in b",
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  for (const scale of [1, 2])
    test(
      `red at DPR ${scale}: a grip 1 px beside its line, in the DOM and in the screenshot`,
      async () => {
        const page = await open(columns('<div class="row">Row</div>').replace('class="grip"', 'class="grip off"'), { scale });
        try {
          const result = await measureV2Layout(page);
          expect(result.grips).toEqual([{ grip: '[data-probe="grip"]', dom: 1, pixels: 1, lineWidth: 1 }]);
          expect(result.grip).toEqual([
            'grip [data-probe="grip"]: pill centre 1 px off its line (DOM)',
            `grip [data-probe="grip"]: pill centre 1 px off its line in the screenshot at DPR ${scale}`,
          ]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "red: the line a Canvas draws itself is a divider like any other (here on top of a band's line)",
    async () => {
      const page = await open(
        columns(
          '<div class="band">Band</div><div data-k2-canvas data-probe="canvas" style="height:80px;border-top:var(--k2-hairline)"><div class="padded"><div class="row">Drawn</div></div></div>',
        ),
      );
      try {
        const result = await measureV2Layout(page);
        expect(result.double).toEqual([
          expect.stringMatching(/^double line: div\.band border-bottom and \[data-probe="canvas"\] border-top at \d+ px over 1191 px$/),
        ]);
        // Inside the canvas everything stays free: the padded row's short line is not reported.
        expect(result.edge).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  // One band (rule 9): two parts told apart by spacing, or by a line between them.
  const band = (between: string) =>
    columns(
      `<section class="band" data-k2-part="Band"><div style="padding-bottom:12px;${between}">Holzwerk Brandt</div><div style="padding-top:12px">Guten Tag</div></section>`,
    );

  test(
    "green: the parts of one band are told apart by spacing; the band's own line at its end is fine",
    async () => {
      const page = await open(band(""));
      try {
        const result = await measureV2Layout(page);
        expect(result.inside).toEqual([]);
        expect(result.problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a line between the parts of one band, 12 px from any other line, is a finding of its own",
    async () => {
      const page = await open(band("border-bottom:var(--k2-hairline)"));
      try {
        const result = await measureV2Layout(page);
        expect(result.double).toEqual([]);
        expect(result.inside).toEqual([
          expect.stringMatching(/^line inside section\.band: div border-bottom at y \d+ separates parts of one thing/),
        ]);
        // Drawn inside the band's padding, the same line also stops short of the column edges.
        expect(result.problems).toEqual([...result.edge, ...result.inside]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  // A control with too little room for its label, and the lines of v2 rows: a row of three lines cuts each line with
  // "…" (its stylesheet does); `line` overrides that the way a broken rule would.
  const cutPage = (room: string, line: string) =>
    columns(
      `<div class="row"><button type="button" class="k2-btn" data-k2-part="Button" data-probe="remind" style="${room}">Mahnung senden</button></div>` +
        `<div class="k2-row" data-lines="3"><span class="k2-row-l1">Holzwerk Brandt</span><span class="k2-row-l2">Angebot</span>` +
        `<span class="k2-row-l3" data-probe="preview" style="max-width:120px;${line}">Guten Tag Frau Solberg, die Platten können wir liefern</span></div>` +
        // The title of a two-line row may wrap: it is what the row is about.
        `<div class="k2-row" data-lines="2"><span class="k2-row-l1" style="max-width:120px">Quittung Q-2611-00021 wartet auf Unterschrift</span><span class="k2-row-l2">seit 18. Nov.</span></div>`,
    );

  test(
    "green: a control with room for its label, a cut line of three, a wrapped title of two",
    async () => {
      const page = await open(cutPage("", ""));
      try {
        const result = await measureV2Layout(page);
        expect(result.cut).toEqual([]);
        expect(result.problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a control that clips its label, and a one-line text that wraps",
    async () => {
      const page = await open(cutPage("width:64px;overflow:hidden;white-space:nowrap", "white-space:normal"));
      try {
        expect((await measureV2Layout(page)).cut).toEqual([
          'control [data-probe="remind"] cuts its label "Mahnung senden"; it needs the room of its whole label',
          expect.stringMatching(
            /^\[data-probe="preview"\] "Guten Tag Frau Solberg, die Platten könn" wraps to \d lines; it stays on one line/,
          ),
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the outline names the same cut texts, before any picture",
    async () => {
      const green = await open(cutPage("", ""));
      const page = await open(cutPage("width:64px;overflow:hidden;white-space:nowrap", "white-space:normal"));
      try {
        const clean = await describeV2Page(green);
        expect(clean).not.toContain("cuts its label");
        expect(clean).not.toContain("wraps");
        const outline = await describeV2Page(page);
        expect(outline).toContain('- Button "Mahnung senden" cuts its label');
        expect(outline).toContain('- a line of a three-line Row wraps: "Guten Tag Frau Solberg');
      } finally {
        await green.close();
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a label that runs out of its control without being clipped",
    async () => {
      const page = await open(cutPage("width:64px;white-space:nowrap", ""));
      try {
        expect((await measureV2Layout(page)).cut).toEqual([
          'control [data-probe="remind"] cuts its label "Mahnung senden"; it needs the room of its whole label',
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "green: v2's own Band with a Canvas in it; the band's line closes both",
    async () => {
      const page = await open(
        columns(
          '<section class="k2-band" data-k2-part="Band"><div class="k2-canvas" data-k2-canvas style="height:80px"></div><span class="k2-text k2-t-row">Karte</span></section>',
        ),
      );
      try {
        expect((await measureV2Layout(page)).problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a line a Canvas draws with a pseudo-element counts like its border",
    async () => {
      const page = await open(
        '<style>.cv::before { content: ""; display: block; height: 1px; background: var(--k2-line); }</style>' +
          columns('<div class="band">Band</div><div class="cv" data-k2-canvas data-probe="canvas" style="height:80px"></div>'),
      );
      try {
        expect((await measureV2Layout(page)).double).toEqual([
          expect.stringMatching(/^double line: div\.band border-bottom and \[data-probe="canvas"\]::before box at \d+ px over 1191 px$/),
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "green at 390 px: v2's three-line row cuts a long title with …",
    async () => {
      const page = await open(
        columns(
          '<div class="k2-row" data-lines="3"><span class="k2-row-l1"><span class="k2-row-title">Architekturbüro Winter und Partner, Hamburg</span></span><span class="k2-row-l2">Re: Treppe Haus am Hang</span><span class="k2-row-l3">Danke für die Zeichnung</span></div>',
        ),
        { width: 390 },
      );
      try {
        expect((await measureV2Layout(page)).cut).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "red: a label cut by a parent that hides what overflows; a scroller does not cut",
    async () => {
      const page = await open(
        columns(
          '<div style="width:80px;overflow:hidden"><button type="button" class="k2-btn" data-probe="hidden" style="white-space:nowrap">Mahnung senden</button></div>' +
            '<div style="width:80px;overflow-x:auto"><button type="button" class="k2-btn" data-probe="scroller" style="white-space:nowrap">Mahnung senden</button></div>',
        ),
      );
      try {
        expect((await measureV2Layout(page)).cut).toEqual([
          'control [data-probe="hidden"] cuts its label "Mahnung senden"; it needs the room of its whole label',
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "green: a button in a one-line cell makes the cell taller, not a second line",
    async () => {
      const page = await open(
        columns(
          '<table class="k2-table" data-sized><tbody><tr><td><span class="k2-cell-line">RE-2611-0042 <button type="button" class="k2-btn">Mahnung</button></span></td></tr></tbody></table>',
        ),
      );
      try {
        expect((await measureV2Layout(page)).cut).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "free drawing in Canvas is never measured",
    async () => {
      const page = await open(
        columns('<div data-k2-canvas><div class="padded"><div class="row" style="font-size:9px">Drawn</div></div></div>'),
      );
      try {
        expect((await measureV2Layout(page)).problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
