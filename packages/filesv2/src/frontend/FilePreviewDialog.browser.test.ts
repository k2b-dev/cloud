import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// The frame's anchor, the fill heights, scrolling and the phone layout need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the dialog uses only its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./FilePreviewDialog.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-preview-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "File preview harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Invented demo files. */
const readme = [
  "# Summer party 2026",
  "",
  "Everything the organising team needs: the schedule, the posters and the shopping list.",
  "",
  "## Schedule",
  "",
  "| Stand | Team | Starts |",
  "| --- | --- | ---: |",
  "| Grill | Team A | 14:00 |",
  "| Drinks | Team B | 13:30 |",
  "",
  "> Please put your initials next to anything you buy.",
  "",
  "```",
  "doors: 13:00",
  "```",
  "",
  ...Array.from({ length: 40 }, (_, index) => `- Item ${index + 1} for the shopping list`),
].join("\n");
const files: Record<string, [string, string | Buffer]> = {
  "README.md": ["text/markdown", readme],
  "Notes.md": ["text/markdown", "Notes from the meeting on 24 September, still without a heading.\n\n- Posters go up on 1 July\n"],
  "Packing_list.txt": [
    "text/plain",
    `Packing list\n\nTent and stage\n- Pavilion 6 x 3 m with side walls and a very long description that has to wrap onto the next line in a narrow column\n- Stage platforms (4)\n`,
  ],
  "Poster.svg": [
    "image/svg+xml",
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#0e7490"/><text x="100" y="500" font-size="160" fill="#fff">Summer party</text></svg>`,
  ],
  "Flyer.svg": [
    "image/svg+xml",
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600"><rect width="800" height="1600" fill="#7c3aed"/></svg>`,
  ],
  "Report.pdf": ["application/pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"],
  "Archive.zip": ["application/zip", "PK"],
  "Long.md": ["text/markdown", "# Everything the organising team needs for the summer party in July\n\nBody text here.\n"],
  "Quarterly planning notes for the summer party organising committee 2026 final version.md": [
    "text/markdown",
    "# Planning\n\nBody text here.\n",
  ],
  "Only.md": ["text/markdown", "# Only a title\n"],
  "Table.csv": [
    "text/csv",
    [
      Array.from({ length: 20 }, (_, column) => `Column ${column + 1}`).join(","),
      ...Array.from({ length: 60 }, (_, row) => Array.from({ length: 20 }, (_, column) => `Stand ${row + 1}.${column + 1}`).join(",")),
    ].join("\n"),
  ],
  "Small.csv": ["text/csv", "Stand,Team\nGrill,Team A\nDrinks,Team B\n"],
  "data.json": ["application/json", JSON.stringify({ stand: "Grill", team: "Team A", starts: "14:00", helpers: 4 })],
};

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// A hold keeps back the Markdown file and the icon font, as a slow connection would: the dialog must not move when
// either arrives. Without a hold, a test measures the dialog with the icon font in place.
const open = async (options: BrowserContextOptions, theme: "light" | "dark" = "light", hold?: Promise<void>) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://preview.test/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, "en") });
    if (path === "/api/filesv2/bases/personal/download") {
      const name = (route.request().postDataJSON() as { path: string }).path.split("/").at(-1)!;
      return route.fulfill({
        json: { url: `http://preview.test/content/${encodeURIComponent(name)}`, method: "GET", expires: "2026-09-28T11:00:00.000Z" },
      });
    }
    if (path.startsWith("/content/")) {
      const file = files[path.slice("/content/".length)];
      if (!file) return route.fulfill({ status: 404 });
      if (hold && path.endsWith(".md")) await hold;
      return route.fulfill({ contentType: file[0], body: file[1], headers: { "access-control-allow-origin": "*" } });
    }
    if (hold && path.endsWith(".woff2")) await hold;
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://preview.test/");
  await tab.waitForFunction(() => !!window.preview);
  if (!hold)
    await tab.evaluate(async () => {
      await document.fonts.load("1em tabler-icons");
    });
  return tab;
};
const settle = (tab: Page) => tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60))));
const show = async (tab: Page, name: string, options: { editable?: boolean; readOnly?: boolean } = {}) => {
  const size = Buffer.byteLength(files[name]![1]);
  await tab.evaluate(([name, size, options]) => window.preview.open(name, size, options), [name, size, options] as const);
  await tab.waitForSelector(".filesv2-preview-dialog[open]");
  await settle(tab);
};
/** Whether the icon font is still on its way: a held test measures once before it arrives and once after. */
const iconFont = (tab: Page) =>
  tab.evaluate(() => {
    let status: string | undefined;
    document.fonts.forEach((face) => {
      if (face.family === "tabler-icons") status = face.status;
    });
    return status;
  });
type Box = { left: number; top: number; width: number; height: number };
const box = (tab: Page, selector: string): Promise<Box> =>
  tab.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
const actionNames = (tab: Page) =>
  tab.$$eval(".k2b-panel-dialog__actions :is(button, a), .k2b-dialog__close", (controls) =>
    controls.map((control) => control.getAttribute("aria-label") ?? (control as HTMLElement).innerText.trim()),
  );

describe("file preview dialog in a browser", () => {
  test("a README shows its heading as the title, the file name small below, and the document once", async () => {
    let release = () => {};
    const tab = await open(
      desktop,
      "light",
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    try {
      await show(tab, "README.md", { editable: true });
      // While the file and the icon font load, the title line is held and the facts wait invisibly for it.
      expect(await iconFont(tab)).toBe("loading");
      const pendingHeader = await box(tab, ".k2b-panel-dialog__header");
      const pendingTitle = await box(tab, ".k2b-panel-dialog__heading h2");
      expect(await tab.getAttribute(".filesv2-preview-dialog", "aria-labelledby")).toBeTruthy();
      expect(await tab.$eval(".k2b-panel-dialog__heading h2", (title) => title.textContent)).toBe("README.md");
      expect(await tab.$eval(".filesv2-preview-facts", (facts) => getComputedStyle(facts).visibility)).toBe("hidden");
      release();
      await tab.waitForSelector(".k2b-content-markdown");
      await tab.evaluate(() => document.fonts.ready);
      await settle(tab);

      expect(await iconFont(tab)).toBe("loaded");
      expect(await tab.$eval(".k2b-panel-dialog__heading h2", (title) => title.textContent)).toBe("Summer party 2026");
      expect(await tab.$eval(".filesv2-preview-facts", (facts) => getComputedStyle(facts).visibility)).toBe("visible");
      expect(await box(tab, ".k2b-panel-dialog__header")).toEqual(pendingHeader);
      expect(await box(tab, ".k2b-panel-dialog__heading h2")).toEqual(pendingTitle);
      expect(await tab.$eval(".filesv2-preview-facts", (facts) => facts.textContent)).toMatch(/^README\.md·1\.53 KiB·Sep 28, 2026/);
      // The heading is the title, so the document starts below it; no second frame around it.
      expect(await tab.$$eval(".k2b-panel-dialog__body h1", (headings) => headings.length)).toBe(0);
      expect(await tab.$eval(".k2b-content-file-view__preview", (preview) => getComputedStyle(preview).borderTopWidth)).toBe("0px");
      expect(await actionNames(tab)).toEqual(["Edit", "Download", "close dialog"]);

      // A reading frame anchored near the top: 40rem wide, and only the body scrolls.
      const { left, top, width } = await box(tab, ".filesv2-preview-dialog");
      expect(width).toBe(640);
      expect(left).toBe((1440 - 640) / 2);
      expect(top).toBe(45);
      const focused = await tab.evaluate(() => document.activeElement?.className);
      expect(focused).toContain("filesv2-preview-dialog__content");
      await tab.keyboard.press("PageDown");
      await settle(tab);
      expect(await tab.$eval(".k2b-panel-dialog__body", (body) => body.scrollTop)).toBeGreaterThan(0);
      expect(await box(tab, ".k2b-panel-dialog__header")).toEqual(pendingHeader);

      await tab.click("text=Edit");
      expect(await tab.evaluate(() => window.preview.edits)).toEqual(["README.md"]);
      expect(await tab.$(".filesv2-preview-dialog[open]")).toBeNull();
    } finally {
      await tab.context().close();
    }
  });

  test("Markdown without a heading and read-only Markdown keep the file name as the title", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Notes.md", { editable: true, readOnly: true });
      await tab.waitForSelector(".k2b-content-markdown");
      await settle(tab);
      expect(await tab.$eval(".k2b-panel-dialog__heading h2", (title) => title.textContent)).toBe("Notes.md");
      expect(await tab.$$eval(".filesv2-preview-facts__name", (names) => names.length)).toBe(0);
      expect(await actionNames(tab)).toEqual(["Open read-only", "Download", "close dialog"]);
    } finally {
      await tab.context().close();
    }
  });

  for (const [label, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const)
    test(`a title that wraps arrives without moving anything visible, and reads in full (${label})`, async () => {
      let release = () => {};
      const tab = await open(
        options,
        "light",
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      try {
        await show(tab, "Long.md", { editable: true });
        const visible = () =>
          tab.$$eval(".k2b-panel-dialog__header :is(h2, button, a, .filesv2-preview-facts)", (elements) =>
            elements
              .filter((element) => getComputedStyle(element).visibility === "visible")
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return [element.className, Math.round(rect.left), Math.round(rect.top)];
              }),
          );
        const pending = await visible();
        expect(pending.some(([name]) => String(name).includes("filesv2-preview-facts"))).toBe(false);
        release();
        await tab.waitForSelector(".k2b-content-markdown");
        await tab.evaluate(() => document.fonts.ready);
        await settle(tab);
        // Everything that was visible before the title and the icon font arrived stays where it was.
        const loaded = await visible();
        for (const element of pending) expect(loaded).toContainEqual(element);
        const title = await tab.$eval(".k2b-panel-dialog__heading h2", (heading) => ({
          text: heading.textContent,
          clipped: heading.scrollHeight > heading.clientHeight + 1,
          lines: Math.round(heading.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(heading).lineHeight)),
        }));
        expect(title.text).toBe("Everything the organising team needs for the summer party in July");
        expect(title.clipped).toBe(false);
        expect(title.lines).toBeGreaterThan(1);
        // The facts line sits below the whole title.
        const heading = await box(tab, ".k2b-panel-dialog__heading h2");
        expect((await box(tab, ".filesv2-preview-facts")).top).toBeGreaterThanOrEqual(heading.top + heading.height);
      } finally {
        await tab.context().close();
      }
    });

  for (const [label, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const)
    test(`a long file name gives way in the facts line, so the size and date stay (${label})`, async () => {
      const tab = await open(options);
      try {
        await show(tab, "Quarterly planning notes for the summer party organising committee 2026 final version.md");
        await tab.waitForSelector(".k2b-content-markdown");
        await settle(tab);
        const facts = await box(tab, ".filesv2-preview-facts");
        const size = await box(tab, ".filesv2-preview-facts__size");
        const date = await box(tab, ".filesv2-preview-facts__date");
        expect(size.left + size.width).toBeLessThanOrEqual(facts.left + facts.width);
        expect(date.left + date.width).toBeLessThanOrEqual(facts.left + facts.width);
        expect(await tab.$eval(".filesv2-preview-facts__date", (element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(
          await tab.$eval(".filesv2-preview-facts__name", (name) => [
            name.scrollWidth > name.clientWidth,
            getComputedStyle(name).textOverflow,
          ]),
        ).toEqual([true, "ellipsis"]);
      } finally {
        await tab.context().close();
      }
    });

  test("a Markdown file that is only its heading keeps the heading in the document", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Only.md");
      await tab.waitForSelector(".k2b-content-markdown h1");
      await settle(tab);
      expect(await tab.$eval(".k2b-panel-dialog__heading h2", (title) => title.textContent)).toBe("Only.md");
      expect(await tab.$eval(".k2b-content-markdown h1", (heading) => heading.textContent)).toBe("Only a title");
    } finally {
      await tab.context().close();
    }
  });

  for (const [label, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const)
    test(`a table scrolls inside the frame with its header row and settings in view (${label})`, async () => {
      const tab = await open(options);
      try {
        await show(tab, "Table.csv");
        await tab.waitForSelector(".k2b-content-file-view__table tbody tr");
        await settle(tab);
        const settings = await box(tab, '[aria-label="CSV preview settings"]');
        const scrolled = await tab.evaluate(() => {
          const body = document.querySelector<HTMLElement>(".k2b-panel-dialog__body")!;
          const preview = document.querySelector<HTMLElement>(".k2b-content-file-view__preview")!;
          preview.scrollTop = 600;
          preview.scrollLeft = 2000;
          // The header row sticks to the top edge of the scrolling area, so no scrolled row shows above it.
          const header = document.querySelector(".k2b-content-file-view__table thead")!.getBoundingClientRect();
          return {
            scrolled: preview.scrollTop > 0 && preview.scrollLeft > 0,
            bodyScrolls: body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth,
            header: Math.round(header.top - preview.getBoundingClientRect().top),
          };
        });
        expect(scrolled).toEqual({ scrolled: true, bodyScrolls: false, header: 0 });
        expect(await box(tab, '[aria-label="CSV preview settings"]')).toEqual(settings);
      } finally {
        await tab.context().close();
      }
    });

  test("a short table keeps the frame as small as its rows", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Small.csv");
      await tab.waitForSelector(".k2b-content-file-view__table tbody tr");
      await settle(tab);
      const frame = await box(tab, ".filesv2-preview-dialog");
      const table = await box(tab, ".k2b-content-file-view__table");
      expect(frame.top + frame.height).toBeLessThan(900 / 2);
      expect(frame.top + frame.height).toBeGreaterThan(table.top + table.height);
    } finally {
      await tab.context().close();
    }
  });

  test("JSON sits on the dialog surface without its own card", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "data.json");
      await tab.waitForSelector(".k2b-content-structured-data__surface");
      await settle(tab);
      const surface = await tab.$eval(".k2b-content-structured-data__surface", (element) => {
        const style = getComputedStyle(element);
        return [style.borderTopWidth, style.backgroundColor];
      });
      expect(surface).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
    } finally {
      await tab.context().close();
    }
  });

  test("a text file is the content: copy in the header, no code box, wrapped lines", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Packing_list.txt");
      await tab.waitForSelector(".k2b-content-code-display__line");
      await settle(tab);
      expect(await actionNames(tab)).toEqual(["Copy", "Download", "close dialog"]);
      expect(await tab.isEnabled(".k2b-panel-dialog__actions button >> nth=0")).toBe(true);
      expect(await tab.$$eval(".k2b-content-code-display__header", (headers) => headers.length)).toBe(0);
      const code = await tab.$eval(".k2b-content-code-display", (display) => {
        const style = getComputedStyle(display);
        return [style.backgroundColor, style.boxShadow, style.marginTop];
      });
      expect(code).toEqual(["rgba(0, 0, 0, 0)", "none", "0px"]);
      // The long line wraps inside the column instead of scrolling sideways.
      expect(await tab.$eval(".k2b-panel-dialog__body", (body) => body.scrollWidth <= body.clientWidth && body.scrollHeight > 0)).toBe(
        true,
      );
      await tab.click(".k2b-panel-dialog__actions button >> nth=0");
      await tab.click(".k2b-panel-dialog__actions button >> nth=1");
      expect(await tab.evaluate(() => window.preview.downloads)).toEqual(["Packing_list.txt"]);
    } finally {
      await tab.context().close();
    }
  });

  test("an image fills the wide frame and opens full screen, and Escape closes one layer at a time", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Poster.svg");
      await tab.waitForSelector(".k2b-content-file-view img");
      await tab.waitForFunction(() => (document.querySelector(".k2b-content-file-view img") as HTMLImageElement).complete);
      await settle(tab);
      expect(await actionNames(tab)).toEqual(["Full screen", "Download", "close dialog"]);
      const { top, width, height } = await box(tab, ".filesv2-preview-dialog");
      expect(width).toBe(1024);
      expect(top + height).toBe(900 - 12);
      const body = await box(tab, ".k2b-panel-dialog__body");
      const image = await box(tab, ".k2b-content-file-view img");
      // As large as the body allows: the image reaches the body's width or height.
      expect(image.width >= body.width - 2 * 24 - 1 || image.height >= body.height - 24 - 1 - 4).toBe(true);
      expect(await tab.$eval(".k2b-panel-dialog__body", (element) => element.scrollHeight <= element.clientHeight)).toBe(true);
      // Centred in the body, without the old cap at half the window height.
      expect(Math.abs(image.top - body.top + (image.top + image.height - body.top - body.height))).toBeLessThanOrEqual(24 + 4 + 2);

      await tab.click('[aria-label="Full screen"]');
      await tab.waitForSelector(".k2b-content-lightbox[open]");
      await tab.keyboard.press("Escape");
      await settle(tab);
      expect(await tab.$(".k2b-content-lightbox")).toBeNull();
      expect(await tab.$(".filesv2-preview-dialog[open]")).not.toBeNull();
      expect(await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Full screen");
      await tab.keyboard.press("Escape");
      await settle(tab);
      expect(await tab.$(".filesv2-preview-dialog[open]")).toBeNull();
    } finally {
      await tab.context().close();
    }
  });

  test("a tall image fits the frame's height instead of scrolling", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Flyer.svg");
      await tab.waitForFunction(() => (document.querySelector(".k2b-content-file-view img") as HTMLImageElement | null)?.complete);
      await settle(tab);
      const body = await box(tab, ".k2b-panel-dialog__body");
      const image = await box(tab, ".k2b-content-file-view img");
      expect(image.height).toBeGreaterThan(900 / 2);
      expect(image.top + image.height).toBeLessThanOrEqual(body.top + body.height);
      expect(await tab.$eval(".k2b-panel-dialog__body", (element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    } finally {
      await tab.context().close();
    }
  });

  test("a PDF puts its actions in the header and fills the frame with the document", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Report.pdf");
      await tab.waitForSelector(".k2b-content-pdf-preview__frame");
      await settle(tab);
      expect(await actionNames(tab)).toEqual(["Open in new tab", "Download", "close dialog"]);
      expect(await tab.getAttribute('[aria-label="Open in new tab"]', "href")).toBe("/app/filesv2/pdf/personal/Summer%20party/Report.pdf");
      expect(await tab.$$eval(".k2b-panel-dialog__body .k2b-button", (buttons) => buttons.length)).toBe(0);
      const body = await box(tab, ".k2b-panel-dialog__body");
      const frame = await box(tab, ".k2b-content-pdf-preview__frame");
      expect(frame.height).toBeGreaterThan(body.height - 2 * 24);
    } finally {
      await tab.context().close();
    }
  });

  test("a file without a preview offers its download", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Archive.zip");
      expect(await tab.$eval(".k2b-panel-dialog__heading h2", (title) => title.textContent)).toBe("Archive.zip");
      expect(await actionNames(tab)).toEqual(["Download", "close dialog"]);
    } finally {
      await tab.context().close();
    }
  });

  for (const theme of ["light", "dark"] as const)
    test(`fills a phone edge to edge, with Edit as an icon that keeps its name (${theme})`, async () => {
      const tab = await open(phone, theme);
      try {
        await show(tab, "README.md", { editable: true });
        await tab.waitForSelector(".k2b-content-markdown");
        await settle(tab);
        expect(await box(tab, ".filesv2-preview-dialog")).toEqual({ left: 0, top: 0, width: 390, height: 844 });
        expect(await tab.$eval(".filesv2-preview-dialog", (frame) => getComputedStyle(frame).borderTopWidth)).toBe("0px");
        const edit = await box(tab, ".filesv2-preview-dialog__edit");
        expect(edit.width).toBeLessThanOrEqual(40);
        expect(await tab.$eval(".filesv2-preview-dialog__edit", (button) => (button as HTMLElement).innerText.trim())).toBe("Edit");
        const text = await box(tab, ".k2b-content-markdown p");
        expect(text.width).toBeGreaterThanOrEqual(350);
        // Too narrow for one facts line: the name keeps its own line, the size and day follow below it.
        expect(await tab.$eval(".filesv2-preview-facts__name", (name) => name.scrollWidth <= name.clientWidth)).toBe(true);
        const name = await box(tab, ".filesv2-preview-facts__name");
        expect((await box(tab, ".filesv2-preview-facts__size")).top).toBeGreaterThan(name.top);
      } finally {
        await tab.context().close();
      }
    });
});
