import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page, Route } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

// The real Browser with its selection pill and PDF actions, on invented files; the pill, the dialogs and the rows of
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
      build.outputs.map(async (output): Promise<[string, [string, Buffer]]> => [
        `/${output.path.split("/").at(-1)}`,
        [output.path.endsWith(".js") ? "text/javascript; charset=utf-8" : output.type, Buffer.from(await output.arrayBuffer())],
      ]),
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
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`);
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
  { name: "Angebot-0412-Sekretär-Biedermeier.pdf", size: 412_000, body: pdf(["Angebot 0412", "Positionen", "Bedingungen"]), fill: "#b91c1c" },
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

const html = (lang: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
  `<body class="k2b-ui" data-theme="light" style="margin:0;height:100vh"><div id="root" style="height:100vh;display:flex"></div>` +
  `<script type="module" src="/harness.js"></script></body></html>`;

type PdfAnswer = { hold?: Promise<void>; fail?: { code: string; message: string; path?: string } };
type Session = {
  tab: Page;
  errors: string[];
  items: Item[];
  posts: { paths: string[]; pages?: number[]; name: string; operation: string }[];
  deleted: string[][];
  /** The answer to the next PDF action; the first entry is used and removed. */
  answers: PdfAnswer[];
};

const open = async (options: BrowserContextOptions, query = "", lang = "en"): Promise<Session> => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  const session: Session = { tab, errors: pageErrors(tab), items: initialItems(), posts: [], deleted: [], answers: [] };
  const named = (path: string) => session.items.find((item) => `${folder}/${item.name}` === path);
  await tab.route("http://files-selection.test/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/app/filesv2") return route.fulfill({ contentType: "text/html", body: html(lang) });
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
const pill = (tab: Page) => tab.locator(".filesv2-selection-pill");
const pillText = async (tab: Page) => ((await pill(tab).locator(".k2b-toolbar__label").first().textContent()) ?? "").trim();
const actionNames = (tab: Page) =>
  pill(tab)
    .locator(".k2b-toolbar__action")
    .evaluateAll((buttons) =>
      buttons.filter((button) => !button.closest('[data-overflow="hidden"]')).map((button) => button.getAttribute("aria-label")),
    );

describe("Files selection pill in a browser", () => {
  test("a click shows the pill; Shift+click takes a range, Ctrl+click adds or removes one, Escape-free Clear ends it", async () => {
    const { tab, errors } = await open(desktop);
    try {
      expect(await pill(tab).count()).toBe(0);
      await row(tab, "Angebot-0412").click();
      await pill(tab).waitFor();
      expect(await pillText(tab)).toBe("1 PDF");
      expect(await actionNames(tab)).toEqual(["Clear selection", "Take out pages", "Download", "Share publicly", "Move to…"]);
      await row(tab, "Angebot-0413").click({ modifiers: ["Shift"] });
      await settled(tab);
      expect(await pillText(tab)).toBe("3 PDFs");
      expect(await actionNames(tab)).toContain("Merge");
      expect(await tab.locator('.filesv2-list__row[aria-selected="true"]').count()).toBe(3);
      await row(tab, "Expertise").click({ modifiers: ["ControlOrMeta"] });
      await settled(tab);
      expect(await pillText(tab)).toBe("2 PDFs");
      await row(tab, "Sekretär-vorher.jpg").click({ modifiers: ["ControlOrMeta"] });
      await settled(tab);
      // A mixed selection offers no PDF action.
      expect(await pillText(tab)).toBe("3 selected");
      expect(await actionNames(tab)).not.toContain("Merge");
      // The rarer commands stay in More at every width.
      await pill(tab).getByRole("button", { name: "More actions" }).click();
      const menu = tab.getByRole("menu");
      for (const name of ["Move into new folder", "Copy to…", "Move to trash"]) expect(await menu.getByRole("menuitem", { name }).count()).toBe(1);
      await tab.keyboard.press("Escape");
      await pill(tab).getByRole("button", { name: "Clear selection" }).click();
      await settled(tab);
      expect(await pill(tab).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  test("the header says once that its Actions menu moved to the pill", async () => {
    const { tab } = await open(desktop, "?hint");
    try {
      await tab.getByRole("button", { name: "Select", exact: true }).click();
      const hint = tab.locator(".k2b-moved-hint");
      await hint.waitFor();
      expect(await hint.textContent()).toContain("The actions for the selection are now in the bar at the bottom.");
      // The old menu is gone from the header.
      expect(await tab.locator(".filesv2-toolbar").getByRole("button", { name: "Actions" }).count()).toBe(0);
      await hint.getByRole("button", { name: "Got it" }).click();
      await settled(tab);
      expect(await tab.evaluate(() => document.cookie)).toContain("filesv2.selection-pill");
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
      await pill(tab).getByRole("button", { name: "Merge" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.getByRole("heading").first().textContent()).toBe("Merge 3 PDFs");
      // Every file shows its pages; the footer counts the result once all are known.
      await tab.waitForFunction(() => document.querySelectorAll(".filesv2-pdf-order .k2b-pdf-thumbnails li[data-drawn]").length >= 9);
      expect(await dialog.locator(".filesv2-pdf-dialog__count").textContent()).toBe("9 pages");
      expect(await dialog.getByLabel("Name of the new PDF").inputValue()).toBe("Angebot-0412-Sekretär-Biedermeier-komplett.pdf");
      // The last file moves to the top with the keyboard on its grip.
      await dialog.getByRole("button", { name: /Move Angebot-0413/ }).focus();
      await tab.keyboard.press("Home");
      await settled(tab);
      await tab.screenshot({ path: "/tmp/files11-shots/merge-dialog-light-1440.png" });
      await dialog.getByRole("button", { name: "Merge", exact: true }).click();
      // While the server works, the new file's row says so where it will appear, with Cancel.
      const making = tab.locator(".filesv2-list__row--operation");
      await making.waitFor();
      expect(await making.textContent()).toContain("Angebot-0412-Sekretär-Biedermeier-komplett.pdf");
      expect(await making.textContent()).toContain("Merging …");
      expect(session.posts[0]).toEqual({
        operation: "merge",
        paths: [`${folder}/Angebot-0413-Vitrine-Gründerzeit.pdf`, `${folder}/Angebot-0412-Sekretär-Biedermeier.pdf`, `${folder}/Expertise-Sekretär.pdf`],
        name: "Angebot-0412-Sekretär-Biedermeier-komplett.pdf",
      });
      await tab.screenshot({ path: "/tmp/files11-shots/merge-progress-light-1440.png" });
      release();
      const toast = tab.locator(".k2b-toast", { hasText: "created" });
      await toast.waitFor();
      expect(await toast.textContent()).toContain("“Angebot-0412-Sekretär-Biedermeier-komplett.pdf” created");
      expect(await toast.textContent()).toContain("9 pages from 3 files");
      await row(tab, "-komplett.pdf").waitFor();
      expect(await row(tab, "-komplett.pdf").textContent()).toContain("Just created");
      expect(await making.count()).toBe(0);
      await tab.screenshot({ path: "/tmp/files11-shots/merge-done-light-1440.png" });
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
      await pill(tab).getByRole("button", { name: "Merge" }).click();
      await tab.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
      const failed = tab.locator('.filesv2-list__row--operation[data-state="failed"]');
      await failed.waitFor();
      expect(await failed.textContent()).toContain("is protected with a password.");
      await tab.screenshot({ path: "/tmp/files11-shots/merge-failed-light-1440.png" });
      await failed.getByRole("button", { name: "Without this file" }).click();
      await row(tab, "-komplett.pdf").waitFor();
      expect(session.posts[1]!.paths).toEqual([`${folder}/Angebot-0412-Sekretär-Biedermeier.pdf`, `${folder}/Angebot-0413-Vitrine-Gründerzeit.pdf`]);
      expect(await tab.locator(".filesv2-list__row--operation").count()).toBe(0);
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
        await pill(tab).getByRole("button", { name: "Take out pages" }).click();
        const dialog = tab.getByRole("dialog");
        await dialog.locator(".k2b-pdf-thumbnails__toggle").first().waitFor();
        expect(await dialog.getByRole("button", { name: "Save as new PDF" }).isDisabled()).toBe(true);
        await dialog.getByRole("button", { name: "Page 1" }).click();
        expect(await dialog.locator(".filesv2-pdf-dialog__count").textContent()).toBe("1 page chosen");
        if (round === 0) await tab.screenshot({ path: "/tmp/files11-shots/extract-dialog-light-1440.png" });
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
    } finally {
      await tab.context().close();
    }
  });

  test("on a phone the pill keeps its count and first action, the rest in More", async () => {
    const { tab } = await open(phone);
    try {
      await tab.getByRole("button", { name: "Select", exact: true }).click();
      await row(tab, "Angebot-0412").locator("input[type=checkbox]").check();
      await row(tab, "Expertise").locator("input[type=checkbox]").check();
      await pill(tab).waitFor();
      await settled(tab);
      const box = (await pill(tab).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await pillText(tab)).toBe("2 PDFs");
      await tab.screenshot({ path: "/tmp/files11-shots/pill-light-390.png" });
    } finally {
      await tab.context().close();
    }
  });

  test("the list with previews and a selection, as a desktop shows it", async () => {
    const { tab } = await open(desktop);
    try {
      await row(tab, "Angebot-0412").click();
      await row(tab, "Angebot-0413").click({ modifiers: ["Shift"] });
      await pill(tab).waitFor();
      await settled(tab);
      await tab.screenshot({ path: "/tmp/files11-shots/pill-light-1440.png" });
    } finally {
      await tab.context().close();
    }
  });
});
