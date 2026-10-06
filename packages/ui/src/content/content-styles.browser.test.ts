import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Which rule wins is decided by the built stylesheet: the build rewrites some
// selectors, so a real engine computes styles from the shipped files.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "content-styles.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { FileView, MarkdownView, PdfPreview, renderSafeMarkdown } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const code = Array.from({ length: 3 }, (_, index) => "const value" + index + " = " + index + ";").join("\\n");
const file = (id, previewLines) => {
  const box = document.createElement("section");
  box.id = id;
  box.style.cssText = "display:flex;flex-direction:column;height:240px";
  render(
    () =>
      createComponent(FileView, {
        file: { path: "src/main.ts", size: code.length },
        load: async () => ({ encoding: "utf8", content: code, mediaType: "text/plain" }),
        previewLines,
      }),
    box,
  );
  return box;
};

const markdown = [
  "Read [the guide](https://example.com) and run \`bun test\`.",
  "",
  "\`\`\`ts",
  "const answer = 42;",
  "\`\`\`",
  "",
  "> Bring a jacket.",
  "",
  "> Token " + "x".repeat(400),
  "",
  "| Name | Count | Status | Price |",
  "| --- | --- | :-: | --: |",
  "| Apples | 3 | ok | 1.20 |",
  "| Pears | 5 | ok | 2.40 |",
  "| Plums | 8 | late | 0.90 |",
].join("\\n");

const app = document.getElementById("app");
app.append(file("full"), file("excerpt", 2));
render(() => createComponent(MarkdownView, { markdown }), app.appendChild(document.createElement("article")));
// A clipping host, like a dialog body, moves rings of controls inside it.
const inset = app.appendChild(document.createElement("div"));
inset.id = "inset";
inset.className = "k2b-focus-inset";
inset.style.cssText = "overflow:auto;padding:16px";
render(() => createComponent(MarkdownView, { markdown: "| Name | Price |\\n| --- | --: |\\n| Apples | 1.20 |" }), inset);
const plain = app.appendChild(document.createElement("section"));
plain.id = "plain";
render(
  () =>
    createComponent(FileView, {
      file: { path: "README.md", size: 400 },
      load: async () => ({ encoding: "utf8", content: "Lorem ipsum ".repeat(40), mediaType: "text/markdown" }),
      variant: "plain",
    }),
  plain,
);
// A plain text preview in a host that bounds its height: the host scrolls, not the preview.
const plainText = app.appendChild(document.createElement("section"));
plainText.id = "plain-text";
plainText.style.cssText = "display:flex;flex-direction:column;height:60px;overflow:auto;width:320px";
render(
  () =>
    createComponent(FileView, {
      file: { path: "notes.txt", size: 400 },
      load: async () => ({ encoding: "utf8", content: code + "\\n" + "word ".repeat(80), mediaType: "text/plain" }),
      variant: "plain",
    }),
  plainText,
);
const pdf = app.appendChild(document.createElement("section"));
pdf.id = "pdf";
render(
  () =>
    createComponent(FileView, {
      file: { path: "reports/q3.pdf" },
      load: async () => ({ encoding: "utf8", content: "%PDF-1.4\\n%%EOF", mediaType: "application/pdf" }),
    }),
  pdf,
);
// A plain excerpt with its expander, plain JSON, and a plain table in a host that bounds and stretches it.
const plainExcerpt = app.appendChild(document.createElement("section"));
plainExcerpt.id = "plain-excerpt";
render(
  () =>
    createComponent(FileView, {
      file: { path: "notes.txt", size: 80 },
      load: async () => ({ encoding: "utf8", content: "one\\ntwo\\nthree\\nfour\\nfive", mediaType: "text/plain" }),
      variant: "plain",
      previewLines: 2,
      onExpandPreview: () => {},
    }),
  plainExcerpt,
);
const plainJson = app.appendChild(document.createElement("section"));
plainJson.id = "plain-json";
render(
  () =>
    createComponent(FileView, {
      file: { path: "data.json", size: 40 },
      load: async () => ({ encoding: "utf8", content: JSON.stringify({ team: "Grill", members: 4 }), mediaType: "application/json" }),
      variant: "plain",
    }),
  plainJson,
);
const plainSheet = app.appendChild(document.createElement("section"));
plainSheet.id = "plain-sheet";
plainSheet.style.cssText = "display:flex;flex-direction:column;height:160px;width:320px";
const sheetRows = Array.from({ length: 30 }, (_, row) => Array.from({ length: 12 }, (_, column) => "Cell " + row + "." + column).join(","));
render(
  () =>
    createComponent(FileView, {
      file: { path: "table.csv", size: 4000 },
      load: async () => ({
        encoding: "utf8",
        content: [Array.from({ length: 12 }, (_, column) => "Column " + column).join(","), ...sheetRows].join("\\n"),
        mediaType: "text/csv",
      }),
      variant: "plain",
      class: "stretched",
    }),
  plainSheet,
);
// An info block in MarkdownView, and its HTML in a host with its own prose margins, like the assistant chat.
const notice = app.appendChild(document.createElement("section"));
notice.id = "notice";
render(() => createComponent(MarkdownView, { markdown: ":::warning\\n## Check\\nRun the **migration** first.\\n:::", headingScale: "compact" }), notice);
const noticeHost = app.appendChild(document.createElement("div"));
noticeHost.id = "notice-host";
noticeHost.className = "notice-host";
noticeHost.innerHTML = renderSafeMarkdown(":::warning\\nRun the **migration** first.\\n:::");
const standalone = app.appendChild(document.createElement("section"));
standalone.id = "standalone-pdf";
render(() => createComponent(PdfPreview, { title: "Report", request: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }) }), standalone);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the content fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>#plain-sheet .stretched{flex:1 1 auto;min-height:0}.notice-host :where(p){margin-block:14px}</style></head>` +
      `<body class="k2b-ui"><button id="before">Before</button><main id="app" style="padding:24px"></main><span id="action" style="color:var(--k2b-action)"></span><span id="text" style="color:var(--k2b-text)"></span>` +
      `<span id="fill" style="background:var(--k2b-surface-muted)"></span>` +
      `<span id="border" style="border-left:1px solid var(--k2b-border)"></span><span id="strong" style="border-left:1px solid var(--k2b-border-strong)"></span></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#excerpt .k2b-content-code-display").waitFor();
  await page.locator("#plain .k2b-content-markdown").waitFor();
  await page.locator("#plain-text .k2b-content-code-display").waitFor();
  await page.locator("#pdf iframe").waitFor();
  await page.locator("#plain-excerpt .k2b-content-file-view__truncated button").waitFor();
  await page.locator("#plain-json .k2b-content-structured-data").waitFor();
  await page.locator("#plain-sheet thead").waitFor();
  await page.locator("#notice .k2b-notice-card").waitFor();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("@k2b/ui content previews apply their own styles", () => {
  for (const id of ["full", "excerpt"]) {
    test(`a ${id} FileView code preview has no second frame inside the preview frame`, async () => {
      const styles = await page.evaluate((id) => {
        const preview = document.querySelector(`#${id} .k2b-content-file-view__preview`)!;
        const code = preview.querySelector(".k2b-content-code-display")!;
        const style = getComputedStyle(code);
        return {
          margin: style.margin,
          boxShadow: style.boxShadow,
          // The preview frame clips its content to its own rounded corners.
          radius: style.borderRadius === getComputedStyle(code.parentElement!).borderRadius,
          clipped: getComputedStyle(preview).overflow !== "visible",
          top: code.getBoundingClientRect().top - preview.getBoundingClientRect().top - preview.clientTop,
        };
      }, id);
      expect(styles).toEqual({ margin: "0px", boxShadow: "none", radius: true, clipped: true, top: 0 });
    });
  }

  test("a complete FileView code preview fills the preview frame", async () => {
    const { code, frame } = await page.evaluate(() => {
      const preview = document.querySelector("#full .k2b-content-file-view__preview")!;
      return { code: preview.querySelector(".k2b-content-code-display")!.getBoundingClientRect().height, frame: preview.clientHeight };
    });
    expect(code).toBe(frame);
  });

  test("an info block's body adds no space inside the card, whatever prose margins the host sets", async () => {
    const margins = await page.evaluate(() =>
      [...document.querySelectorAll("#notice .k2b-notice-card__body, #notice-host .k2b-notice-card__body")].map((body) => [
        getComputedStyle(body.firstElementChild!).marginTop,
        getComputedStyle(body.lastElementChild!).marginBottom,
      ]),
    );
    expect(margins).toEqual([
      ["0px", "0px"],
      ["0px", "0px"],
    ]);
  });

  test("MarkdownView underlines links and sets code as text on a fill without a frame", async () => {
    const styles = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const link = style("article a");
      const inline = style("article p code");
      const block = style("article pre");
      return {
        link: [link.color, link.textDecorationLine],
        inline: [inline.color, inline.backgroundColor],
        fenced: [style("article pre code").color, style("article pre code").backgroundColor],
        block: [block.color, block.backgroundColor, block.borderTopColor],
        action: style("#action").color,
        text: style("#text").color,
        fill: style("#fill").backgroundColor,
      };
    });
    expect(styles.link).toEqual([styles.action, "underline"]);
    expect(styles.inline).toEqual([styles.text, styles.fill]);
    expect(styles.block).toEqual([styles.text, styles.fill, "rgba(0, 0, 0, 0)"]);
    expect(styles.fenced).toEqual([styles.text, "rgba(0, 0, 0, 0)"]);
  });

  test("MarkdownView sets a quote off by a rule at its start edge, not a box", async () => {
    const quote = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector("article blockquote")!);
      return [style.backgroundColor, style.borderTopWidth, style.borderLeftWidth, style.borderLeftColor];
    });
    const strong = await page.evaluate(() => getComputedStyle(document.querySelector("#strong")!).borderLeftColor);
    expect(quote).toEqual(["rgba(0, 0, 0, 0)", "0px", "3px", strong]);
  });

  test("MarkdownView tables are hairlines without a frame, fill or zebra, flush with the prose", async () => {
    const table = await page.evaluate(() => {
      const style = (element: Element) => getComputedStyle(element);
      const wrapper = document.querySelector("article .k2b-content-markdown__table")!;
      const rows = Array.from(document.querySelectorAll("article tbody tr"));
      const cells = (row: Element) => Array.from(row.children);
      const header = document.querySelector("article thead th")!;
      const paragraph = document.querySelector("article p")!.getBoundingClientRect();
      const lastHeader = document.querySelector("article thead th:last-child")!.getBoundingClientRect();
      return {
        frame: [style(wrapper).borderTopWidth, style(wrapper).borderLeftWidth],
        head: [
          style(document.querySelector("article thead")!).backgroundColor,
          style(header).backgroundColor,
          style(header).borderBottomColor,
        ],
        rowFills: rows.map((row) => style(row).backgroundColor),
        rowLines: rows.map((row) => style(cells(row)[0]!).borderTopWidth),
        lineColor: style(cells(rows[1]!)[0]!).borderTopColor,
        start: header.getBoundingClientRect().left + Number.parseFloat(style(header).paddingLeft) - paragraph.left,
        end:
          paragraph.right -
          (lastHeader.right - Number.parseFloat(style(document.querySelector("article thead th:last-child")!).paddingRight)),
      };
    });
    const tokens = await page.evaluate(() => ({
      border: getComputedStyle(document.querySelector("#border")!).borderLeftColor,
      strong: getComputedStyle(document.querySelector("#strong")!).borderLeftColor,
    }));
    expect(table.frame).toEqual(["0px", "0px"]);
    expect(await page.locator("article .k2b-content-markdown__table").getAttribute("tabindex")).toBe("0");
    expect(table.head).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", tokens.strong]);
    expect(new Set(table.rowFills)).toEqual(new Set(["rgba(0, 0, 0, 0)"]));
    expect(table.rowLines).toEqual(["0px", "1px", "1px"]);
    expect(table.lineColor).toBe(tokens.border);
    expect(table.start).toBe(0);
    expect(table.end).toBe(0);
  });

  for (const host of ["article", "#inset"]) {
    test(`a focused Markdown table in ${host === "article" ? "a plain host" : "a clipping host"} draws its ring outside its flush columns`, async () => {
      const wrapper = page.locator(`${host} .k2b-content-markdown__table`);
      await page.focus("#before");
      for (let step = 0; step < 10 && !(await wrapper.evaluate((element) => element === document.activeElement)); step++) {
        await page.keyboard.press("Tab");
      }
      const ring = await wrapper.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(element.querySelector("th")!);
        return {
          visible: element.matches(":focus-visible"),
          outline: [style.outlineStyle, style.outlineWidth],
          offset: Number.parseFloat(style.outlineOffset),
          // The columns stay flush with the wrapper, so an inside ring would cover their text.
          flush: Math.round(text.getBoundingClientRect().left - box.left),
        };
      });
      expect(ring).toEqual({ visible: true, outline: ["solid", "2px"], offset: 2, flush: 0 });
    });
  }

  test("MarkdownView quotes sit on the prose edge and wrap long tokens", async () => {
    const quote = await page.evaluate(() => {
      const quotes = document.querySelectorAll("article blockquote");
      const long = quotes[quotes.length - 1]!;
      const article = document.querySelector("article")!;
      return {
        // `@k2b/ui` does not reset the page, so the browser's quote indent must not apply.
        margin: [getComputedStyle(long).marginLeft, getComputedStyle(long).marginRight],
        fits: long.scrollWidth <= long.clientWidth && article.scrollWidth <= article.clientWidth,
      };
    });
    expect(quote).toEqual({ margin: ["0px", "0px"], fits: true });
  });

  test("MarkdownView right-aligned cells wrap like any other cell", async () => {
    const wrapping = await page.evaluate(() =>
      Array.from(document.querySelectorAll('article :is(th, td)[align="right"]'), (cell) => getComputedStyle(cell).whiteSpace),
    );
    expect(wrapping.length).toBeGreaterThan(0);
    expect(new Set(wrapping)).toEqual(new Set(["normal"]));
  });

  test("a plain FileView keeps Markdown at a reading measure", async () => {
    const { width, host, ch } = await page.evaluate(() => {
      const markdown = document.querySelector("#plain .k2b-content-markdown")!;
      const probe = markdown.appendChild(document.createElement("span"));
      probe.style.cssText = "position:absolute;width:72ch";
      const ch = probe.getBoundingClientRect().width;
      probe.remove();
      return { width: markdown.getBoundingClientRect().width, host: document.querySelector("#plain")!.getBoundingClientRect().width, ch };
    });
    expect(host).toBeGreaterThan(ch);
    expect(width).toBeCloseTo(ch, 0);
  });

  test("a plain FileView shows text without a code box and leaves scrolling to its host", async () => {
    const result = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#plain-text")!;
      const view = host.querySelector<HTMLElement>(".k2b-content-file-view")!;
      const preview = host.querySelector<HTMLElement>(".k2b-content-file-view__preview")!;
      const code = getComputedStyle(host.querySelector(".k2b-content-code-display")!);
      return {
        header: host.querySelector(".k2b-content-code-display__header") !== null,
        fill: code.backgroundColor,
        ring: code.boxShadow,
        previewScrolls: preview.scrollHeight > preview.clientHeight + 1,
        natural: view.getBoundingClientRect().height > host.clientHeight,
        hostScrolls: host.scrollHeight > host.clientHeight,
        wraps: host.scrollWidth <= host.clientWidth,
      };
    });
    expect(result).toEqual({
      header: false,
      fill: "rgba(0, 0, 0, 0)",
      ring: "none",
      previewScrolls: false,
      natural: true,
      hostScrolls: true,
      wraps: true,
    });
  });

  test("a PDF from loaded bytes has no visible heading or toolbar line, and neither has a standalone PDF toolbar", async () => {
    const result = await page.evaluate(() => {
      const viewer = document.querySelector("#pdf .k2b-content-file-view__pdf-viewer")!;
      return {
        headings: document.querySelectorAll("#pdf h2").length,
        frameTitle: document.querySelector("#pdf iframe")!.getAttribute("title"),
        frame: getComputedStyle(viewer).borderTopWidth,
        actionsLine: getComputedStyle(viewer.querySelector(".k2b-content-pdf-preview__actions")!).borderBottomWidth,
        toolbarLine: getComputedStyle(document.querySelector("#standalone-pdf .k2b-content-pdf-preview__toolbar")!).borderBottomWidth,
      };
    });
    expect(result).toEqual({ headings: 0, frameTitle: "q3.pdf", frame: "1px", actionsLine: "0px", toolbarLine: "0px" });
  });

  test("a plain excerpt lines its expander up with the content", async () => {
    const [content, label] = await page.evaluate(() => {
      const host = document.querySelector("#plain-excerpt")!;
      const range = document.createRange();
      range.selectNodeContents(host.querySelector(".k2b-content-file-view__truncated button")!);
      return [host.querySelector(".k2b-content-code-display")!.getBoundingClientRect().left, range.getBoundingClientRect().left];
    });
    expect(Math.abs(label - content)).toBeLessThanOrEqual(1);
  });

  test("plain JSON sits on the host surface without its own card", async () => {
    const surface = await page.$eval("#plain-json .k2b-content-structured-data__surface", (element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.backgroundColor, style.paddingLeft];
    });
    expect(surface).toEqual(["0px", "rgba(0, 0, 0, 0)", "0px"]);
  });

  test("a stretched plain table scrolls in itself and keeps its header row and actions in view", async () => {
    const result = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#plain-sheet")!;
      const preview = host.querySelector<HTMLElement>(".k2b-content-file-view__preview")!;
      const overlay = host.querySelector<HTMLElement>(".k2b-content-file-view__overlay")!;
      const before = overlay.getBoundingClientRect().toJSON();
      preview.scrollTop = 200;
      preview.scrollLeft = 400;
      return {
        scrolled: preview.scrollTop > 0 && preview.scrollLeft > 0,
        hostScrolls: host.scrollHeight > host.clientHeight,
        header: Math.round(host.querySelector("thead")!.getBoundingClientRect().top - preview.getBoundingClientRect().top),
        overlay: JSON.stringify(overlay.getBoundingClientRect().toJSON()) === JSON.stringify(before),
      };
    });
    expect(result).toEqual({ scrolled: true, hostScrolls: false, header: 0, overlay: true });
  });

  test("a Markdown code block keeps its edge in forced colours", async () => {
    await page.emulateMedia({ forcedColors: "active" });
    try {
      const edge = await page.evaluate(() => getComputedStyle(document.querySelector("article pre")!).borderTopColor);
      expect(edge).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await page.emulateMedia({ forcedColors: "none" });
    }
  });

  test("MarkdownView table headers align with their columns", async () => {
    const alignment = await page.evaluate(() =>
      Array.from(document.querySelectorAll("article thead th"), (header, index) => {
        const cell = document.querySelectorAll("article tbody td")[index]!;
        return [getComputedStyle(header).textAlign, getComputedStyle(cell).textAlign];
      }),
    );
    // Engines report the `align` attribute as their own keyword, such as `-webkit-center`.
    expect(alignment.map(([header]) => header)).toEqual([
      "start",
      "start",
      expect.stringContaining("center"),
      expect.stringContaining("right"),
    ]);
    for (const [header, cell] of alignment) expect(header).toBe(cell!);
  });
});
