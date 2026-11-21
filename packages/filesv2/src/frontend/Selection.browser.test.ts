import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page, Route } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";

// The real Browser with its status row, selection and PDF actions, on invented files; the layout, the dialogs and the rows of
// files in the making need a layout engine and pdf.js.
const ui = new URL("../../../ui/", import.meta.url).pathname;

/** An ES module build with chunks, as in an app, so pdf.js and its worker arrive as files next to the entry. */
const buildHarness = async (): Promise<Map<string, [string, Buffer]>> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./Selection.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { entry: "harness.js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "solid-selection-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Selection harness build failed");
  return new Map(
    await Promise.all(
      build.outputs.map(
        async (output): Promise<[string, [string, Buffer]]> => [
          `/${output.path.split("/").at(-1)}`,
          [output.path.endsWith(".js") ? "text/javascript; charset=utf-8" : output.type, Buffer.from(await output.arrayBuffer())],
        ],
      ),
    ),
  );
};

/** A real PDF with these page titles, so pdf.js draws its pages in the dialogs. */
const pdf = (titles: readonly string[]) => {
  const kids = titles.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${titles.length} >>`];
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [page, title] of titles.entries()) {
    const stream = `BT /F1 28 Tf 72 740 Td (${title}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  return `${body}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
};
const page = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="226" height="320"><rect width="100%" height="100%" fill="#fff"/><rect x="24" y="30" width="120" height="10" fill="${fill}"/><rect x="24" y="60" width="170" height="5" fill="#d4d4d8"/><rect x="24" y="72" width="150" height="5" fill="#d4d4d8"/></svg>`;
const photo = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="${fill}"/><rect x="110" y="70" width="100" height="120" fill="#7c2d12"/></svg>`;

const folder = "Angebote 2026";
type Item = { name: string; size: number; body?: string; fill: string };
const initialItems = (): Item[] => [
  {
    name: "Angebot-0412-Sekretär-Biedermeier.pdf",
    size: 412_000,
    body: pdf(["Angebot 0412", "Positionen", "Bedingungen"]),
    fill: "#b91c1c",
  },
  { name: "Expertise-Sekretär.pdf", size: 1_800_000, body: pdf(["Expertise", "Befund", "Fotos", "Wert"]), fill: "#1e3a8a" },
  { name: "Angebot-0413-Vitrine-Gründerzeit.pdf", size: 388_000, body: pdf(["Angebot 0413", "Positionen"]), fill: "#b91c1c" },
  { name: "Rechnung-2026-0388.pdf", size: 96_000, body: pdf(["Rechnung 0388"]), fill: "#047857" },
  { name: "Angebot-0414-Esstisch-Eiche.docx", size: 58_000, fill: "#1d4ed8" },
  { name: "Sekretär-vorher.jpg", size: 4_600_000, fill: "#a8a29e" },
  { name: "Sekretär-nachher.jpg", size: 5_100_000, fill: "#d6d3d1" },
];
const entry = (item: Item) => ({
  name: item.name,
  path: `${folder}/${item.name}`,
  directory: false,
  size: item.size,
  modified: "2026-11-09T10:15:00.000Z",
  revision: `r-${item.name}`,
  actions: { write: true, move: true, share: true },
});

// pdf.js draws the dialogs' pages and the server answers in steps; a flow takes a few seconds.
setDefaultTimeout(30_000);
/** Set FILES_SHOTS to a folder to keep screenshots of the states the tests reach. */
const shots = process.env.FILES_SHOTS;
const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
let assets: Map<string, [string, Buffer]>;
let css: string;
beforeAll(async () => {
  [assets, css] = await Promise.all([buildHarness(), appHostCss(resolve(import.meta.dir, "../styles/app.css"))]);
  browser = await launchBrowser();
}, 90_000);
afterAll(async () => {
  await browser?.close();
});

const html = (lang: string, theme = "light") =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
  `<body class="k2b-ui" data-theme="${theme}" style="margin:0;height:100vh"><div id="root" style="height:100vh;display:flex"></div>` +
  `<script type="module" src="/harness.js"></script></body></html>`;

type PdfAnswer = { hold?: Promise<void>; fail?: { code: string; message: string; path?: string } };
type Session = {
  tab: Page;
  errors: string[];
  items: Item[];
  posts: { paths: string[]; pages?: number[]; revisions?: string[]; name: string; operation: string }[];
  deleted: string[][];
  /** The trash refuses the next deletion, as for a missing right. */
  refuseDelete?: boolean;
  /** The answer to the next PDF action; the first entry is used and removed. */
  answers: PdfAnswer[];
};

const open = async (options: BrowserContextOptions, query = "", lang = "en", items = initialItems()): Promise<Session> => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  // A step that waits fails well inside the test's own timeout, so its report names the step.
  tab.setDefaultTimeout(12_000);
  const session: Session = { tab, errors: pageErrors(tab), items, posts: [], deleted: [], answers: [] };
  const named = (path: string) => session.items.find((item) => `${folder}/${item.name}` === path);
  await tab.route("http://files-selection.test/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/app/filesv2")
      return route.fulfill({ contentType: "text/html", body: html(lang, url.searchParams.get("theme") ?? "light") });
    if (path === "/harness/items") return route.fulfill({ json: session.items.map(entry) });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: readFileSync(`${ui}dist/tabler.css`, "utf8") });
    if (path.endsWith(".woff2")) return route.fulfill({ contentType: "font/woff2", body: readFileSync(`${ui}dist${path}`) });
    const asset = assets.get(path);
    if (asset) return route.fulfill({ contentType: asset[0], body: asset[1] });
    if (path.endsWith("/preview")) {
      const item = named(url.searchParams.get("path") ?? "");
      if (!item) return route.fulfill({ status: 404, json: { code: "preview_unsupported", message: "" } });
      return route.fulfill({
        contentType: "image/svg+xml",
        body: item.name.endsWith(".jpg") ? photo(item.fill) : page(item.fill),
      });
    }
    if (path.endsWith("/entry")) {
      const item = named(url.searchParams.get("path") ?? "");
      return item ? route.fulfill({ json: { base: { id: "base" }, entry: entry(item) } }) : route.fulfill({ status: 404, json: {} });
    }
    if (path.endsWith("/download")) {
      const name = (route.request().postDataJSON() as { path: string }).path;
      return route.fulfill({
        json: { url: `http://files-selection.test/v1/direct/${encodeURIComponent(name)}`, method: "GET", expires: "2026-11-11T12:00:00Z" },
      });
    }
    if (path.startsWith("/v1/direct/")) {
      const item = named(path.slice("/v1/direct/".length));
      return item?.body ? route.fulfill({ contentType: "application/pdf", body: item.body }) : route.fulfill({ status: 404 });
    }
    if (path.endsWith("/pdf") && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Session["posts"][number];
      session.posts.push(body);
      const answer = session.answers.shift() ?? {};
      if (answer.hold) await answer.hold;
      const steps = body.paths.length + 2;
      const lines = Array.from({ length: steps }, (_, done) => JSON.stringify({ type: "progress", done, total: steps }));
      if (answer.fail) lines.push(JSON.stringify({ type: "error", ...answer.fail }));
      else {
        const created: Item = { name: body.name, size: 2_500_000, body: pdf(["Neu"]), fill: "#b91c1c" };
        const after = session.items.findIndex((item) => `${folder}/${item.name}` === body.paths.at(-1));
        session.items.splice(after + 1, 0, created);
        lines.push(JSON.stringify({ type: "done", result: { base: { id: "base" }, entry: entry(created) } }));
      }
      return route.fulfill({ contentType: "application/x-ndjson", body: `${lines.join("\n")}\n` }).catch(() => {});
    }
    if (path.endsWith("/delete")) {
      const { paths } = route.request().postDataJSON() as { paths: string[] };
      session.deleted.push(paths);
      session.items = session.items.filter((item) => !paths.includes(`${folder}/${item.name}`));
      if (session.refuseDelete)
        return route.fulfill({
          json: { results: paths.map((target) => ({ path: target, ok: false, error: "You may not move this file to the trash." })) },
        });
      return route.fulfill({ json: { results: paths.map((target) => ({ path: target, ok: true })) } });
    }
    return route.fulfill({ status: 404, json: { code: "not_found", message: "" } });
  });
  await tab.goto(`http://files-selection.test/app/filesv2${query}`);
  await tab.waitForSelector(".filesv2-list__row");
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return session;
};
const row = (tab: Page, name: string) => tab.locator(".filesv2-list__row", { hasText: name }).first();
// While choosing several entries, the status row under the head holds the count and the selection's actions (K6).
const bar = (tab: Page) => tab.locator('.k2b-status-row[data-mode="selection"]');
const barText = async (tab: Page) => ((await bar(tab).locator(".k2b-status-row__middle").textContent()) ?? "").trim();
const actionNames = (tab: Page) =>
  bar(tab)
    .locator(".filesv2-selection-actions button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => !button.closest("[role=menu]") && button.checkVisibility())
        .map((button) => button.textContent?.trim() || button.getAttribute("aria-label")),
    );
/** Opens the detail column's "…" menu. */
const detailMenu = async (tab: Page) => {
  await tab.locator(".k2b-detail-panel").getByRole("button", { name: "More actions" }).first().click();
  return tab.getByRole("menu");
};

describe("Files selection in the status row", () => {
  test("a click opens the details; Shift+click takes a range, Ctrl+click adds or removes one, Done ends it", async () => {
    const { tab, errors } = await open(desktop);
    try {
      expect(await bar(tab).count()).toBe(0);
      await row(tab, "Angebot-0412").click();
      await tab.locator(".k2b-detail-panel h2", { hasText: "Angebot-0412" }).waitFor();
      // One file chosen by a click is the detail column's; its rarer commands are in "…".
      expect(await bar(tab).count()).toBe(0);
      const menu = await detailMenu(tab);
      expect(await menu.getByRole("menuitem", { name: "Take out pages" }).count()).toBe(1);
      await tab.keyboard.press("Escape");
      await row(tab, "Angebot-0413").click({ modifiers: ["Shift"] });
      await bar(tab).waitFor();
      await settled(tab);
      expect(await barText(tab)).toBe("3 selected");
      expect(await actionNames(tab)).toContain("Merge");
      expect(await tab.locator('.filesv2-list__row[aria-selected="true"]').count()).toBe(3);
      await row(tab, "Expertise").click({ modifiers: ["ControlOrMeta"] });
      await settled(tab);
      expect(await barText(tab)).toBe("2 selected");
      await row(tab, "Sekretär-vorher.jpg").click({ modifiers: ["ControlOrMeta"] });
      await settled(tab);
      // A mixed selection offers no PDF action.
      expect(await barText(tab)).toBe("3 selected");
      expect(await actionNames(tab)).not.toContain("Merge");
      // The rarer commands stay in More at every width.
      await bar(tab).getByRole("button", { name: "More actions" }).click();
      const more = tab.getByRole("menu");
      for (const name of ["Move into new folder", "Copy to…", "Move to trash"])
        expect(await more.getByRole("menuitem", { name }).count()).toBe(1);
      await tab.keyboard.press("Escape");
      await bar(tab).getByRole("button", { name: "Done" }).click();
      await settled(tab);
      expect(await bar(tab).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  test("the status row says once that the selection's actions moved from the pill to it", async () => {
    const { tab } = await open(desktop, "?hint");
    try {
      await tab.getByRole("button", { name: "Select", exact: true }).click();
      const hint = tab.locator(".k2b-moved-hint").first();
      await hint.waitFor();
      expect(await hint.textContent()).toContain("The actions for the selection are now here, beside the count.");
      // The pill at the bottom is gone.
      expect(await tab.locator(".k2b-toolbar").count()).toBe(0);
      await hint.locator("button", { hasText: "Got it" }).first().click();
      await settled(tab);
      expect(await tab.evaluate(() => document.cookie)).toContain("filesv2.selection-status-row");
    } finally {
      await tab.context().close();
    }
  });

  test("merging asks for the order with page pictures, shows progress at the new file's place, and offers Undo", async () => {
    const session = await open(desktop);
    const { tab } = session;
    let release = () => {};
    session.answers.push({
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    try {
      await row(tab, "Angebot-0412").click();
      await row(tab, "Angebot-0413").click({ modifiers: ["Shift"] });
      await bar(tab).getByRole("button", { name: "Merge" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.getByRole("heading").first().textContent()).toBe("Merge 3 PDFs");
      // Every file shows its pages; the footer counts the result once all are known.
      await tab.waitForFunction(() => document.querySelectorAll(".filesv2-pdf-order .k2b-pdf-thumbnails li[data-drawn]").length >= 9);
      expect(await dialog.locator(".filesv2-pdf-dialog__count").textContent()).toBe("9 pages");
      expect(await dialog.getByLabel("Name of the new PDF").inputValue()).toBe("Angebot-0412-Sekretär-Biedermeier-komplett.pdf");
      // The last file moves to the top with the keyboard on its grip: Space lifts it, Home chooses the top, Enter drops.
      await dialog.getByRole("button", { name: /Move Angebot-0413/ }).focus();
      await tab.keyboard.press("Space");
      await tab.waitForFunction(() => document.querySelector(".filesv2-pdf-order [data-sortable-dragging]") !== null);
      await tab.keyboard.press("Home");
      await tab.keyboard.press("Enter");
      await settled(tab);
      if (shots) await tab.screenshot({ path: `${shots}/merge-dialog-light-1440.png` });
      await dialog.getByRole("button", { name: "Merge", exact: true }).click();
      // While the server works, the new file's row says so where it will appear, with Cancel.
      const making = tab.locator(".filesv2-list__row--operation");
      await making.waitFor();
      expect(await making.textContent()).toContain("Angebot-0412-Sekretär-Biedermeier-komplett.pdf");
      expect(await making.textContent()).toContain("Merging …");
      expect(session.posts[0]).toEqual({
        operation: "merge",
        paths: [
          `${folder}/Angebot-0413-Vitrine-Gründerzeit.pdf`,
          `${folder}/Angebot-0412-Sekretär-Biedermeier.pdf`,
          `${folder}/Expertise-Sekretär.pdf`,
        ],
        name: "Angebot-0412-Sekretär-Biedermeier-komplett.pdf",
      });
      if (shots) await tab.screenshot({ path: `${shots}/merge-progress-light-1440.png` });
      release();
      const toast = tab.locator(".k2b-toast", { hasText: "created" });
      await toast.waitFor();
      expect(await toast.textContent()).toContain("“Angebot-0412-Sekretär-Biedermeier-komplett.pdf” created");
      expect(await toast.textContent()).toContain("9 pages from 3 files");
      await row(tab, "-komplett.pdf").waitFor();
      expect(await row(tab, "-komplett.pdf").textContent()).toContain("Just created");
      expect(await making.count()).toBe(0);
      if (shots) await tab.screenshot({ path: `${shots}/merge-done-light-1440.png` });
      await toast.getByRole("button", { name: "Undo" }).click();
      await tab.locator(".k2b-toast", { hasText: "The new file is in the trash." }).waitFor();
      expect(session.deleted).toEqual([[`${folder}/Angebot-0412-Sekretär-Biedermeier-komplett.pdf`]]);
      // The originals were never touched.
      expect(session.items.map((item) => item.name)).toEqual(initialItems().map((item) => item.name));
    } finally {
      await tab.context().close();
    }
  });

  test("a protected file fails at the row with its reason, and the merge goes on without it", async () => {
    const session = await open(desktop);
    const { tab } = session;
    session.answers.push({
      fail: {
        code: "pdf_encrypted",
        message: "“Expertise-Sekretär.pdf” is protected with a password.",
        path: `${folder}/Expertise-Sekretär.pdf`,
      },
    });
    try {
      await row(tab, "Angebot-0412").click();
      await row(tab, "Angebot-0413").click({ modifiers: ["Shift"] });
      await bar(tab).getByRole("button", { name: "Merge" }).click();
      await tab.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
      const failed = tab.locator('.filesv2-list__row--operation[data-state="failed"]');
      await failed.waitFor();
      expect(await failed.textContent()).toContain("is protected with a password.");
      if (shots) await tab.screenshot({ path: `${shots}/merge-failed-light-1440.png` });
      await failed.getByRole("button", { name: "Without this file" }).click();
      // The row in the making carries the new name too; the file itself is there once that row is gone.
      await tab.locator(".filesv2-list__row--operation").waitFor({ state: "detached" });
      await tab.locator(".filesv2-list__row:not(.filesv2-list__row--operation)", { hasText: "-komplett.pdf" }).waitFor();
      expect(session.posts[1]!.paths).toEqual([
        `${folder}/Angebot-0412-Sekretär-Biedermeier.pdf`,
        `${folder}/Angebot-0413-Vitrine-Gründerzeit.pdf`,
      ]);
    } finally {
      await tab.context().close();
    }
  });

  test("Cancel stops the work and removes the row; Discard drops a failure", async () => {
    const session = await open(desktop);
    const { tab } = session;
    session.answers.push({ hold: new Promise(() => {}) }, { fail: { code: "pdf_failed", message: "The PDF could not be made." } });
    try {
      for (let round = 0; round < 2; round++) {
        await row(tab, "Rechnung-2026-0388").click();
        await (await detailMenu(tab)).getByRole("menuitem", { name: "Take out pages" }).click();
        const dialog = tab.getByRole("dialog");
        await dialog.locator(".k2b-pdf-thumbnails__toggle").first().waitFor();
        expect(await dialog.getByRole("button", { name: "Save as new PDF" }).isDisabled()).toBe(true);
        await dialog.getByRole("button", { name: "Page 1" }).click();
        expect(await dialog.locator(".filesv2-pdf-dialog__count").textContent()).toBe("1 page chosen");
        if (round === 0 && shots) await tab.screenshot({ path: `${shots}/extract-dialog-light-1440.png` });
        await dialog.getByRole("button", { name: "Save as new PDF" }).click();
        const making = tab.locator(".filesv2-list__row--operation");
        if (round === 0) {
          await making.getByRole("button", { name: "Cancel" }).click();
          await settled(tab);
          expect(await making.count()).toBe(0);
        } else {
          await tab.locator('.filesv2-list__row--operation[data-state="failed"]').waitFor();
          expect(await making.textContent()).toContain("The PDF could not be made.");
          expect(await making.getByRole("button", { name: "Try again" }).count()).toBe(1);
          await making.getByRole("button", { name: "Discard" }).click();
          await settled(tab);
          expect(await making.count()).toBe(0);
        }
      }
      expect(session.posts.map((post) => post.pages)).toEqual([[1], [1]]);
      expect(session.posts[0]!.name).toBe("Rechnung-2026-0388-Auszug.pdf");
      // The pages count over the version shown in the dialog.
      expect(session.posts[0]!.revisions).toEqual(["r-Rechnung-2026-0388.pdf"]);
    } finally {
      await tab.context().close();
    }
  });

  test("in the grid a file in the making shows its failure and recovery in its tile", async () => {
    const session = await open(desktop);
    const { tab } = session;
    session.answers.push({ fail: { code: "pdf_failed", message: "The PDF could not be made." } });
    try {
      await tab.getByRole("radio", { name: "Grid" }).click();
      await tab.locator(".k2b-file-grid [role=option], .k2b-file-grid [aria-selected]").first().waitFor();
      const tile = (name: string) => tab.locator(".k2b-file-grid > *", { hasText: name }).first();
      await tile("Rechnung-2026-0388").click();
      await (await detailMenu(tab)).getByRole("menuitem", { name: "Take out pages" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "Page 1" }).click();
      await dialog.getByRole("button", { name: "Save as new PDF" }).click();
      const failed = tab.locator('.filesv2-grid-operation[data-state="failed"]');
      await failed.waitFor();
      expect(await failed.textContent()).toContain("The PDF could not be made.");
      await failed.getByRole("button", { name: "Discard" }).click();
      await settled(tab);
      expect(await tab.locator(".filesv2-grid-operation").count()).toBe(0);
    } finally {
      await tab.context().close();
    }
  });

  test("an Undo the trash refuses says so instead of claiming success", async () => {
    const session = await open(desktop);
    const { tab } = session;
    try {
      await row(tab, "Angebot-0412").click();
      await row(tab, "Expertise").click({ modifiers: ["Shift"] });
      await bar(tab).getByRole("button", { name: "Merge" }).click();
      await tab.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
      const toast = tab.locator(".k2b-toast", { hasText: "created" });
      await toast.waitFor();
      session.refuseDelete = true;
      await toast.getByRole("button", { name: "Undo" }).click();
      await tab.locator(".k2b-toast", { hasText: "You may not move this file to the trash." }).waitFor();
      expect(await tab.locator(".k2b-toast", { hasText: "The new file is in the trash." }).count()).toBe(0);
    } finally {
      await tab.context().close();
    }
  });

  test("on a phone the status row keeps its count and Download, the rest in More", async () => {
    const { tab } = await open(phone);
    try {
      await tab.getByRole("button", { name: "Select", exact: true }).click();
      await row(tab, "Angebot-0412").locator("input[type=checkbox]").check();
      await row(tab, "Expertise").locator("input[type=checkbox]").check();
      await bar(tab).waitFor();
      await settled(tab);
      const box = (await bar(tab).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      if (shots) await tab.screenshot({ path: `${shots}/selection-light-390.png` });
      expect(await barText(tab)).toBe("2 selected");
      expect(await actionNames(tab)).toEqual(["Download as ZIP", "More actions", "Done"]);
      if (shots) await tab.screenshot({ path: `${shots}/selection-light-390.png` });
    } finally {
      await tab.context().close();
    }
  });
});

/** Where every row or tile stands, in window coordinates. */
const layout = (tab: Page) =>
  tab.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".filesv2-browser__collection .filesv2-list__row, .k2b-file-grid > *")].map((item) => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
const scrollToEnd = async (tab: Page) => {
  await tab.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".filesv2-browser__collection .k2b-scroll-area")!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await settled(tab);
};
const few = () => initialItems().slice(0, 3);
const many = (): Item[] =>
  Array.from({ length: 60 }, (_, index) => ({
    name: `Beleg-2026-${String(index + 1).padStart(3, "0")}.docx`,
    size: 24_000 + index,
    fill: "#1d4ed8",
  }));

/**
 * A phone without touch for the layout self-check: on touch every button grows an invisible 44 px hit area (`::after`),
 * which the check would count as content spilling out of its box. The hit area is no layout.
 */
const phoneLayout: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true };

describe("Files folder is flat (K1–K15)", () => {
  // Valentin 21.11.: no two borders on one edge, nothing overlaps or is cut, and a scrollbar moves no line.
  const problems = (tab: Page) =>
    tab.evaluate(layoutProblems, {
      root: "#root",
      // Text for screen readers only (a 1 px clipped box) is hidden on purpose, also the phone's New label beside its sign.
      // The path's "…" and a detail section's toggle reach past their boxes on touch; reported to their blocks (PR3, PR2).
      ignore:
        ".k2b-avatar-stack, [data-layout-check='skip'], .k2b-file-drop-target, .sr-only, .k2b-sr-only, .k2b-app-workspace__head-primary-label, .k2b-breadcrumbs__more, .k2b-section__header",
    });
  for (const [options, width] of [
    [desktop, 1440],
    [phoneLayout, 390],
  ] as const)
    for (const [amount, items] of [
      ["few", few],
      ["many", many],
    ] as const)
      test(`${width} px, ${amount} files: the folder and its details draw every line once and cut nothing`, async () => {
        const { tab, errors } = await open(options, "", "en", items());
        try {
          if (shots) await tab.screenshot({ path: `${shots}/folder-${amount}-light-${width}.png` });
          expect((await problems(tab)).problems).toEqual([]);
          const names = items().map((item) => item.name);
          await row(tab, names[1]!).click();
          await tab.locator(".k2b-detail-panel h2").first().waitFor();
          await settled(tab);
          if (shots) await tab.screenshot({ path: `${shots}/detail-${amount}-light-${width}.png` });
          expect((await problems(tab)).problems).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await tab.context().close();
        }
      });

  for (const [device, options, width] of [
    ["desktop", desktop, 1440],
    ["phone", phoneLayout, 390],
  ] as const)
    test(`${device}: choosing several moves no row, and Done brings the status row back`, async () => {
      const { tab, errors } = await open(options, "", "en", many());
      try {
        const names = many().map((item) => item.name);
        await scrollToEnd(tab);
        await tab.getByRole("button", { name: "Select", exact: true }).click();
        await settled(tab);
        const before = await layout(tab);
        for (const name of names.slice(-2)) await row(tab, name).locator("input[type=checkbox]").check();
        await bar(tab).waitFor();
        await settled(tab);
        expect(await layout(tab)).toEqual(before);
        // The self-check does not see what a head or status row covers (K15), so it runs on the list's top.
        await tab.evaluate(() => {
          document.querySelector<HTMLElement>(".filesv2-browser__collection .k2b-scroll-area")!.scrollTop = 0;
        });
        await settled(tab);
        if (shots) await tab.screenshot({ path: `${shots}/selection-many-light-${width}.png` });
        expect((await problems(tab)).problems).toEqual([]);
        await bar(tab).getByRole("button", { name: "Done" }).click();
        await settled(tab);
        expect(await bar(tab).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await tab.context().close();
      }
    });
});

describe("Files folder states", () => {
  const problems = (tab: Page) =>
    tab.evaluate(layoutProblems, {
      root: "#root",
      ignore:
        ".k2b-avatar-stack, [data-layout-check='skip'], .k2b-file-drop-target, .sr-only, .k2b-sr-only, .k2b-app-workspace__head-primary-label, .k2b-breadcrumbs__more, .k2b-section__header",
    });
  // K12: the tablet and the very wide screen keep one head row, the name column's cap and every line once.
  for (const width of [768, 1920])
    test(`${width} px with many files: nothing overlaps, spills, is cut, or draws a double line`, async () => {
      const { tab, errors } = await open({ viewport: { width, height: 900 } }, "", "en", many());
      try {
        if (shots) await tab.screenshot({ path: `${shots}/folder-many-light-${width}.png` });
        expect((await problems(tab)).problems).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await tab.context().close();
      }
    });

  test("an empty folder, a failed refresh and keyboard focus keep the column's lines and places", async () => {
    const { tab, errors } = await open(desktop, "?error", "en", []);
    try {
      // The folder is empty: the parent row, then the quiet empty state without a box (K10).
      expect(await tab.getByText("This folder is empty").first().isVisible()).toBe(true);
      // A failed refresh says so under the status row and offers the way on.
      expect(await tab.getByRole("alert").textContent()).toContain("The folder could not be loaded again.");
      await tab.locator(".filesv2-list__row--up").focus();
      await settled(tab);
      if (shots) await tab.screenshot({ path: `${shots}/folder-empty-light-1440.png` });
      expect((await problems(tab)).problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  test("dark: the folder and its details stay readable", async () => {
    const { tab, errors } = await open(desktop, "?theme=dark");
    try {
      await row(tab, "Expertise").click();
      await tab.locator(".k2b-detail-panel h2").first().waitFor();
      await settled(tab);
      if (shots) await tab.screenshot({ path: `${shots}/detail-few-dark-1440.png` });
      expect((await problems(tab)).problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });
});
