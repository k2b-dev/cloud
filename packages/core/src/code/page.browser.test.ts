import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CodePageTree, validateCodePage } from "@k2b/cloud/code";
import { createConfig } from "@k2b/ssr";
import { AppWorkspace } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { CODE_NEWSLETTER_DEMO_SOURCE } from "./page.newsletter-demo";
import { codePageFixture } from "./page.test-fixture";
import { buildCodePage } from "./page.test-source";
import type { CodePageLabel, CodePageProvenance } from "./page-provenance-contracts";
import { provenanceMessages } from "./provenance-messages";

// The real renderer with the real stylesheet: the server's page, the island that replaces it, and every request it
// sends. A fake event source stands in for platform events.
const root = mkdtempSync(join(tmpdir(), "core-code-page-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CodePageHost } = await import("./PageHost");
const { buildFontAssets } = await import("../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../scripts/tabler-assets");
const publicDir = join(root, "public");
const codeId = "c_page";
const csrf = "session-bound";
/** Light screenshots for review; the directory is kept. */
const shots = process.env.CODE_PAGE_SHOTS;

const check = (tree: unknown) => validateCodePage(tree, codeId);
const home = check(codePageFixture);
const withChildren = (tree: CodePageTree, children: CodePageTree["children"]) => check({ ...tree, children });
const itemPage = check({
  version: 1,
  kind: "Page",
  title: "Chair",
  children: [{ kind: "Detail", title: "Chair", items: [{ label: "Code", value: "W-1" }] }],
});

type Post = { path: string; fields: Record<string, string>; tree: string | null };
type Reply = { delay?: number; response: () => Response };
/** How a page is framed: in the app card, whose Main scrolls, or alone in the window (`layout: "plain"`). */
type Frame = "workspace" | "plain";
const state = {
  trees: new Map<string, CodePageTree>(),
  posts: [] as Post[],
  replies: [] as Reply[],
  treeLoads: 0,
  treeDelay: 0,
  frame: "plain" as Frame,
  locale: "en",
  label: { kind: "person", name: "Lea Muster" } as CodePageLabel,
  /** The card's facts the provenance route answers with, unless a queued reply says otherwise. */
  facts: null as CodePageProvenance | null,
  reads: [] as Record<string, unknown>[],
  readReplies: [] as Reply[],
  reports: [] as Record<string, unknown>[],
  reportReplies: [] as Reply[],
};
const treeResponse = (tree: CodePageTree) => Response.json({ tree, csrf }, { headers: { "X-Code-Page": "tree" } });
const failure = (status: number, code: string) => Response.json({ code }, { status });

let script = "";
let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

/** The opaque version value hosting would send; the fake routes accept any. */
const versionValue = "v".repeat(32);
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const documentFor = (tree: CodePageTree, path: string) => {
  const { locale } = state;
  const provenance = { label: state.label, version: versionValue, path, cloudName: "Möbel Beispiel Cloud" };
  // As Core hosts it: the tree in its host, with the footer and the feat/code label beside it.
  const host = () => createComponent(CodePageHost, { tree, codeId, csrf, locale, timeZone: "UTC", provenance });
  // The app card as render-page draws it for signed-in people; Main scrolls and has no fade of its own.
  const workspace = () =>
    createComponent(AppWorkspace, {
      mobileSurface: "flush",
      class: "min-h-0 flex-1",
      resizable: false,
      head: false,
      get children() {
        return createComponent(AppWorkspace.Content, {
          get children() {
            return createComponent(AppWorkspace.Main, {
              class: "code-page-main",
              scrollFade: false,
              get children() {
                return host();
              },
            });
          },
        });
      },
    });
  const body =
    state.frame === "workspace"
      ? `<div class="code-test-shell">${renderToString(workspace)}</div>`
      : `<main id="app">${renderToString(host)}</main>`;
  const form = JSON.stringify(tree).includes('"kind":"Form"');
  return (
    `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${tree.title} · Cloud</title><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css">` +
    `<style>${css}</style><style>body{margin:0}.code-test-shell{position:fixed;inset:0;display:flex;flex-direction:column;padding:8px;background:var(--k2b-surface-canvas)}@media (max-width:47.999rem){.code-test-shell{padding:0}}</style>` +
    `</head><body class="k2b-ui">${body}` +
    `<script type="application/json" id="props">${json({ tree, codeId, csrf, locale, timeZone: "UTC" })}</script>` +
    `<script type="application/json" id="label-props">${json({ provenance, codeId, form, locale })}</script>` +
    `<script src="/client.js"></script></body></html>`
  );
};

beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  // Lives only in memory; its path makes relative imports resolve from this folder.
  const entry = resolve(import.meta.dir, "page.browser-entry.ts");
  const fixture = `import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import Page from "./PageTree.island";
import Label from "./PageProvenance.island";
const listeners = new Set();
const events = { subscribe(types, onEvent) { window.followed = types; listeners.add(onEvent); return () => listeners.delete(onEvent); } };
window.emit = () => listeners.forEach((listener) => listener());
window.mount = () => {
  // The island replaces only the tree; the label beside it is server markup.
  const app = document.querySelector("[data-code-page-tree]");
  const props = JSON.parse(document.getElementById("props").textContent);
  app.textContent = "";
  render(() => createComponent(Page, { ...props, events }), app);
  // The label is an island of its own beside the tree.
  const label = document.querySelector("[data-code-provenance]");
  const labelProps = JSON.parse(document.getElementById("label-props").textContent);
  label.textContent = "";
  render(() => createComponent(Label, labelProps), label);
};
if (!location.search.includes("hold")) window.mount();`;
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "code-page-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Code page");
  script = await bundle.outputs[0]!.text();
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(styles.map((path) => Bun.build({ entrypoints: [path], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/public/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname === "/client.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      // The card's routes, as hosting answers them for the viewer the test chose.
      if (url.pathname === "/api/code/pages/provenance" || url.pathname === "/api/code/pages/report") {
        const read = url.pathname.endsWith("/provenance");
        (read ? state.reads : state.reports).push(await request.json());
        const reply = (read ? state.readReplies : state.reportReplies).shift() ?? {
          response: () =>
            read
              ? state.facts
                ? Response.json({ data: state.facts })
                : failure(404, "code_route_not_found")
              : Response.json({ data: { reportedAt: "2026-11-15T09:00:00.000Z" } }),
        };
        if (reply.delay) await Bun.sleep(reply.delay);
        return reply.response();
      }
      const path = url.pathname.slice(`/code/${codeId}`.length) || "/";
      if (request.method === "POST") {
        state.posts.push({
          path: url.pathname,
          fields: Object.fromEntries(new URLSearchParams(await request.text())),
          tree: request.headers.get("X-Code-Page"),
        });
        const reply = state.replies.shift() ?? { response: () => treeResponse(state.trees.get("/")!) };
        if (reply.delay) await Bun.sleep(reply.delay);
        return reply.response();
      }
      const tree = state.trees.get(path);
      if (!tree) return failure(404, "code_route_not_found");
      if (request.headers.get("X-Code-Page") === "tree") {
        state.treeLoads++;
        if (state.treeDelay) await Bun.sleep(state.treeDelay);
        return treeResponse(tree);
      }
      return new Response(documentFor(tree, path), { headers: { "Content-Type": "text/html" } });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

/** The weekly delivery notices of the concept's mockup (fictitious data), as short, normal and long pages and with a form. */
const week = [
  ["Beschläge Kern", "Mo., 09.11.", "Messinggriffe, 400 Stück", "mit Lieferschein"],
  ["Holz Brandt", "Di., 10.11.", "Eiche, 12 Platten", "mit Lieferschein"],
  ["Lack & Leim", "Di., 10.11.", "Klarlack, 30 Liter", "ohne Lieferschein"],
  ["Beschläge Kern", "Mi., 11.11.", "Scharniere, 250 Stück", "mit Lieferschein"],
  ["Holz Brandt", "Do., 12.11.", "Nussbaum, 6 Platten", "mit Lieferschein"],
  ["Polster Winter", "Fr., 13.11.", "Bezugsstoff, 40 Meter", "ohne Lieferschein"],
];
const notices = (rows: string[][], form = false, weeks = 1) =>
  check({
    version: 1,
    kind: "Page",
    title: "Lieferavise dieser Woche",
    subtitle: "Jeden Morgen um 8 aktualisiert",
    icon: "ti ti-truck-delivery",
    color: "blue",
    follow: ["grids.record.changed"],
    children: [
      {
        kind: "Stats",
        items: [
          { label: "Lieferavise", value: 14, compare: { label: "Letzte Woche", value: 11 } },
          { label: "Mit Lieferschein", value: 9 },
          { label: "Lieferanten", value: 5 },
        ],
      },
      // A table scrolls inside its panel; a long page has one panel per week.
      ...Array.from({ length: weeks }, (_, week) => ({
        kind: "Table",
        title: week ? `Angekündigt, Woche ${46 - week}` : "Angekündigt",
        columns: [
          { key: "supplier", label: "Lieferant" },
          { key: "day", label: "Tag" },
          { key: "goods", label: "Ware" },
          { key: "slip", label: "Lieferschein" },
        ],
        rows: rows.map(([supplier, day, goods, slip]) => ({ supplier, day, goods, slip })),
      })),
      ...(form
        ? [
            {
              kind: "Form",
              title: "Lieferung fehlt?",
              action: "/missing",
              submit: "Melden",
              width: "half",
              fields: [
                {
                  type: "select",
                  name: "supplier",
                  label: "Lieferant",
                  options: [...new Set(week.map(([supplier]) => supplier!))].map((supplier) => ({ label: supplier, value: supplier })),
                },
                { type: "textarea", name: "missing", label: "Was fehlt?" },
              ],
            },
          ]
        : []),
    ],
  });
const callback = check({
  version: 1,
  kind: "Page",
  title: "Rückruf anfragen",
  subtitle: "Wir melden uns an einem Werktag bei dir",
  icon: "ti ti-phone-call",
  color: "emerald",
  children: [
    {
      kind: "Form",
      title: "Deine Angaben",
      action: "/callback",
      submit: "Rückruf anfragen",
      width: "half",
      fields: [
        { type: "text", name: "name", label: "Name" },
        { type: "text", name: "phone", label: "Telefon" },
        { type: "textarea", name: "message", label: "Nachricht" },
      ],
    },
  ],
});
const labelPages: [string, CodePageTree][] = [
  ["/week", notices(week)],
  ["/week/short", notices(week.slice(0, 2))],
  ["/week/long", notices(week, false, 5)],
  ["/week/form", notices(week, true)],
  ["/callback", callback],
];
/** The card's facts per viewer, as the provenance route answers them (fictitious names). */
/** Every failure of the report dialog; each has a short sentence for phones. */
const FAILURES = [
  "failedLost",
  "failedUnknown",
  "failedChanged",
  "failedRateLimit",
  "failedMembersOnly",
  "failedSignedOut",
  "failedNotFound",
  "failedInput",
] as const;
const facts = {
  visitor: { viewer: "visitor", owner: null, automation: null, gives: "nothing", report: null },
  member: {
    viewer: "member",
    owner: { kind: "person", name: "Lea Muster" },
    automation: null,
    gives: "account",
    report: { reportedAt: null },
  },
  reader: {
    viewer: "reader",
    owner: { kind: "person", name: "Lea Muster" },
    automation: {
      title: "Lieferavise der Woche",
      version: 3,
      activeSince: "2026-11-03T08:00:00.000Z",
      approvedBy: "Jana Probe",
      href: "/app/assistant/code/c_page",
    },
    gives: "account",
    report: { reportedAt: null },
  },
  mailbox: {
    viewer: "member",
    owner: { kind: "resource", type: "Postfach", name: null },
    automation: null,
    gives: "account",
    report: { reportedAt: null },
  },
  unclear: { viewer: "member", owner: { kind: "unavailable" }, automation: null, gives: "account", report: { reportedAt: null } },
  reported: {
    viewer: "member",
    owner: { kind: "person", name: "Lea Muster" },
    automation: null,
    gives: "account",
    report: { reportedAt: "2026-11-12T09:00:00.000Z" },
  },
} satisfies Record<string, CodePageProvenance>;

/** The Newsletter dashboard of the chart showcase, built from Code source. */
const newsletter = await buildCodePage(CODE_NEWSLETTER_DEMO_SOURCE, codeId);
const reset = () => {
  state.trees = new Map([["/", home], ["/newsletter", newsletter], ["/items/W-1", itemPage], ...labelPages]);
  state.posts = [];
  state.replies = [];
  state.treeLoads = 0;
  state.treeDelay = 0;
  state.frame = "plain";
  state.locale = "en";
  state.label = { kind: "person", name: "Lea Muster" };
  state.facts = null;
  state.reads = [];
  state.readReplies = [];
  state.reports = [];
  state.reportReplies = [];
};

type Camera = "code" | "denied" | null;
type OpenOptions = {
  hold?: boolean;
  camera?: Camera;
  path?: string;
  height?: number;
  frame?: Frame;
  locale?: string;
  label?: CodePageLabel;
  facts?: CodePageProvenance;
  /** Sets `prefers-reduced-motion: reduce`, as for screenshots. */
  reducedMotion?: boolean;
};
async function open(width: number, options: OpenOptions = {}) {
  reset();
  if (options.frame) state.frame = options.frame;
  if (options.locale) state.locale = options.locale;
  if (options.label) state.label = options.label;
  if (options.facts) state.facts = options.facts;
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: options.height ?? 900 },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    ...(options.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    locale: options.locale === "de" ? "de-DE" : "en-US",
  });
  if (options.camera)
    await context.addInitScript((camera: Exclude<Camera, null>) => {
      // A camera that films a white picture and a detector that reads one code from it, as on Chrome for Android.
      Object.defineProperty(globalThis, "BarcodeDetector", {
        configurable: true,
        value: class {
          static async getSupportedFormats() {
            return ["qr_code"];
          }
          async detect() {
            const corners = [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ];
            return [{ rawValue: "W-42", format: "qr_code", cornerPoints: corners, boundingBox: new DOMRectReadOnly(0, 0, 1, 1) }];
          }
        },
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (camera === "denied") throw new DOMException("The camera refused.", "NotAllowedError");
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 640;
            const paint = canvas.getContext("2d")!;
            const draw = () => {
              paint.fillStyle = "#fff";
              paint.fillRect(0, 0, 640, 640);
            };
            draw();
            setInterval(draw, 50);
            const stream = canvas.captureStream(20);
            await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
            return stream;
          },
        },
      });
    }, options.camera);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = pageErrors(page);
  await page.goto(`${server.url.origin}/code/${codeId}${options.path ?? "/"}${options.hold ? "?hold" : ""}`);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
}

const boxes = (page: Page) =>
  page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    // Code's own blocks, and the shared panels that draw its data: sections, frames and key-figure tiles.
    blocks: Array.from(
      document.querySelectorAll("[data-code-block], .k2b-dashboard-section, .k2b-dashboard-frame, .k2b-stat-cell, .k2b-chart-explorer"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return [
        element.getAttribute("data-code-block") ?? element.classList[0],
        Math.round(rect.left + window.scrollX),
        Math.round(rect.top + window.scrollY),
        Math.round(rect.width),
        Math.round(rect.height),
      ];
    }),
    text: document.querySelector<HTMLElement>("[data-code-page]")?.innerText,
    label: (() => {
      const rect = document.querySelector("[data-code-provenance] .code-page-provenance__pill")?.getBoundingClientRect();
      return rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
    })(),
  }));

/** Scrolled to the end, the last block is fully visible and ends above the footer, which sits in view. */
const expectEndClear = async (page: Page) => {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const main = document.querySelector(".k2b-app-workspace__main");
    main?.scrollTo(0, main.scrollHeight);
  });
  await settled(page);
  const end = await page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>("[data-code-provenance]")!.getBoundingClientRect();
    const blocks = Array.from(
      document.querySelectorAll("[data-code-page-tree] .k2b-dashboard-frame, [data-code-page-tree] [data-code-block]"),
    );
    return {
      footerTop: footer.top,
      footerBottom: footer.bottom,
      last: Math.max(...blocks.map((block) => block.getBoundingClientRect().bottom)),
      view: window.innerHeight,
    };
  });
  expect(end.last).toBeLessThanOrEqual(end.footerTop);
  expect(end.footerBottom).toBeLessThanOrEqual(end.view);
};

describe("Code page in a browser", () => {
  test("a public page response removes stale CSRF fields and the next submit sends no token", async () => {
    const { page, errors, close } = await open(1280);
    try {
      await settled(page);
      expect(await page.locator('input[name="_csrf"]').count()).toBeGreaterThan(0);
      const publicTree = withChildren(home, [{ kind: "Notice", tone: "success", title: "Public response" }, ...home.children]);
      state.replies.push({ response: () => Response.json({ tree: publicTree, csrf: null }, { headers: { "X-Code-Page": "tree" } }) });
      await page.getByRole("button", { name: "Mark ready", exact: true }).click();
      await page.getByText("Public response", { exact: true }).waitFor();
      expect(await page.locator('input[name="_csrf"]').count()).toBe(0);
      state.replies.push({ response: () => Response.json({ tree: publicTree, csrf: null }, { headers: { "X-Code-Page": "tree" } }) });
      await page.getByRole("button", { name: "Mark ready", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('button[aria-busy="true"]').length === 0);
      expect(state.posts[1]).toEqual({ path: `/code/${codeId}/ready`, fields: { item: "W-1" }, tree: "tree" });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
  test("the Newsletter demo from Code data fits at 1280 and 390 px and keeps every panel from server to browser", async () => {
    for (const width of [1280, 390]) {
      const { page, errors, close } = await open(width, { hold: true, path: "/newsletter" });
      try {
        await settled(page);
        const server = await boxes(page);
        expect(server.overflow).toBeLessThanOrEqual(0);
        expect(server.blocks.filter(([kind]) => kind === "k2b-stat-cell")).toHaveLength(4);
        if (shots) await page.screenshot({ path: join(shots, `newsletter-${width}-light.png`), fullPage: true });
        await page.evaluate(() => (window as unknown as { mount: () => void }).mount());
        await settled(page);
        expect(await boxes(page)).toEqual(server);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  for (const width of [1280, 390]) {
    test(`${width}px: every block fits, and the first client render shows the server's page in place`, async () => {
      const { page, errors, close } = await open(width, { hold: true });
      try {
        await settled(page);
        const server = await boxes(page);
        expect(server.overflow).toBeLessThanOrEqual(0);
        expect(server.blocks.map(([kind]) => kind)).toContain("k2b-chart-explorer");
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: join(shots, `code-page-${width}-light.png`), fullPage: true });
        }
        await page.evaluate(() => (window as unknown as { mount: () => void }).mount());
        await settled(page);
        expect(await boxes(page)).toEqual(server);
        await page.evaluate(() => {
          document.documentElement.className = "dark";
        });
        // The theme change starts colour transitions on every control; they end on their own.
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .every(
              (animation) =>
                animation.timeline !== document.timeline ||
                animation.playState !== "running" ||
                !Number.isFinite(animation.effect?.getComputedTiming().endTime),
            ),
        );
        expect((await boxes(page)).overflow).toBeLessThanOrEqual(0);
        if (shots) await page.screenshot({ path: join(shots, `code-page-${width}-dark.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);

    test(`${width}px: actions and forms send without a reload, keep their place while sending and carry the CSRF field`, async () => {
      const { page, errors, close } = await open(width);
      try {
        await page.evaluate(() => {
          (window as unknown as { sameDocument: boolean }).sameDocument = true;
        });
        await settled(page);
        const before = await boxes(page);
        state.replies.push({
          delay: 700,
          response: () => treeResponse(withChildren(home, [{ kind: "Notice", tone: "success", title: "Marked ready" }, ...home.children])),
        });
        const ready = page.getByRole("button", { name: "Mark ready", exact: true });
        await ready.click();
        await page.waitForSelector('[data-code-block="Button"] button[aria-busy="true"]');
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-sending-light.png") });
        // Sending changes nothing around the button.
        // settled: the busy moment is the subject; its spinner never stops while the request runs.
        expect((await boxes(page)).blocks).toEqual(before.blocks);
        await page.getByText("Marked ready").waitFor();
        expect(state.posts[0]).toEqual({ path: `/code/${codeId}/ready`, fields: { _csrf: csrf, item: "W-1" }, tree: "tree" });
        expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

        // The Code answers a form with its validation message; the person's input stays.
        await page.getByLabel("Title", { exact: true }).fill("Lamp");
        await page.getByLabel("Count", { exact: true }).fill("3");
        await page.getByLabel("Urgent", { exact: true }).check();
        await page.getByRole("combobox", { name: "Status", exact: true }).click();
        await page.getByRole("option", { name: "In repair", exact: true }).click();
        state.replies.push({
          response: () =>
            treeResponse(
              check({
                ...home,
                children: home.children.map((child) =>
                  child.kind === "Section"
                    ? {
                        ...child,
                        children: child.children.map((inner) =>
                          inner.kind === "Form"
                            ? {
                                ...inner,
                                fields: inner.fields.map((field) =>
                                  field.name === "title" ? { ...field, value: "Lamp", error: "Choose a longer title." } : field,
                                ),
                              }
                            : inner,
                        ),
                      }
                    : child,
                ),
              }),
            ),
        });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByText("Choose a longer title.").waitFor();
        // Focus continues at the first field the Code marked invalid.
        expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("barcode");
        expect(state.posts[1]?.fields).toMatchObject({
          _csrf: csrf,
          barcode: "W-1",
          title: "Lamp",
          count: "3",
          urgent: "on",
          status: "repair",
        });
        expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Lamp");
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-validation-light.png"), fullPage: true });

        // A redirect opens the next page in place; Back returns to the first.
        state.replies.push({ response: () => new Response(null, { status: 303, headers: { Location: `/code/${codeId}/items/W-1` } }) });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.waitForURL(`**/code/${codeId}/items/W-1`);
        await page.getByRole("heading", { name: "Chair", level: 1 }).waitFor();
        expect(await page.title()).toBe("Chair · Cloud");
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
        await page.goBack();
        await page.waitForURL(`**/code/${codeId}/`);
        await page.getByRole("heading", { name: "Workshop", level: 1 }).waitFor();
        expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

        // Failures say what happened and leave the controls ready to try again.
        state.replies.push({ response: () => failure(403, "code_csrf_required") });
        await page.getByRole("button", { name: "Print label", exact: true }).click();
        await page
          .getByRole("region", { name: "Notifications" })
          .getByText("This page is out of date. Reload it and repeat the step.")
          .waitFor();
        expect(await page.getByRole("button", { name: "Print label", exact: true }).isEnabled()).toBe(true);
        state.replies.push({ response: () => failure(503, "code_request_busy") });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The Code is busy. Try again in a moment." }).waitFor();
        // An answer that breaks off may have run: the form says so, and the next submit still works.
        state.replies.push({
          response: () => new Response("{", { headers: { "X-Code-Page": "tree", "Content-Type": "application/json" } }),
        });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The answer was lost." }).waitFor();
        state.replies.push({ response: () => failure(503, "code_request_busy") });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The Code is busy. Try again in a moment." }).waitFor();
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-failure-light.png"), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);
  }

  test("followed events load the page again; while someone types, new data waits in a toast", async () => {
    const { page, errors, close } = await open(1280);
    try {
      expect(await page.evaluate(() => (window as unknown as { followed: string[] }).followed)).toEqual(["grids.record.changed"]);
      const table = (rows: { item: string; status: string; count: number }[]) =>
        withChildren(
          home,
          home.children.map((child) =>
            child.kind === "Section"
              ? {
                  ...child,
                  children: child.children.map((inner) => (inner.kind === "Table" && inner.title === "Items" ? { ...inner, rows } : inner)),
                }
              : child,
          ),
        );
      state.trees.set("/", table([{ item: "Desk", status: "Received", count: 1 }]));
      const emit = () => page.evaluate(() => (window as unknown as { emit: () => void }).emit());
      await emit();
      await page.getByRole("cell", { name: "Desk" }).waitFor();
      // A burst of events ends in at most one more load after the running one.
      const loads = state.treeLoads;
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as unknown as { emit: () => void }).emit();
      });
      await page.waitForFunction(() => !document.querySelector("[data-code-page][aria-busy]"));
      expect(state.treeLoads - loads).toBeLessThanOrEqual(2);

      // Typing that starts while a load runs keeps its input; the new data waits.
      state.treeDelay = 500;
      state.trees.set("/", table([{ item: "Shelf", status: "Received", count: 1 }]));
      await emit();
      await page.waitForSelector("[data-code-page][aria-busy]");
      await page.getByLabel("Title", { exact: true }).fill("Typed");
      await page.getByRole("region", { name: "Notifications" }).getByText("This page has new data.").waitFor();
      state.treeDelay = 0;
      expect(await page.getByRole("cell", { name: "Shelf" }).count()).toBe(0);
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("cell", { name: "Shelf" }).waitFor();
      // A reload that fails leaves every panel's data in place and says when it was read, with Try again.
      state.trees.delete("/");
      await emit();
      await page.getByText("Refresh failed").first().waitFor();
      expect(await page.getByRole("cell", { name: "Shelf" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  test("tables sort on their headers; the scanner writes into its field and sends nothing", async () => {
    const { page, errors, close } = await open(390, { camera: "code" });
    try {
      const items = page
        .locator(".k2b-dashboard-frame")
        .filter({ has: page.locator("table") })
        .first();
      // Like every shared table, the first click sorts descending and the second ascending.
      await items.getByRole("button", { name: "Count" }).click();
      expect(await items.getByRole("row").nth(1).innerText()).toContain("Lamp");
      await items.getByRole("button", { name: "Count" }).click();
      expect(await items.getByRole("row").nth(1).innerText()).toContain("Bicycle");
      await page.getByLabel("Title", { exact: true }).fill("Typed");
      // The field holds the scan by the time the scanner leaves the page, not only once its history entry is gone.
      await page.evaluate(() => {
        const seen = window as unknown as { valueWhenScannerLeft?: string };
        let opened = false;
        // The label's card is a closed dialog beside the page all along; the scanner is the other one.
        const scanner = '[role="dialog"]:not(.code-page-provenance__card)';
        const observer = new MutationObserver(() => {
          if (document.querySelector(scanner)) opened = true;
          if (!opened || document.querySelector(scanner)) return;
          seen.valueWhenScannerLeft = document.querySelector<HTMLInputElement>('input[name="barcode"]')!.value;
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      await page.getByRole("button", { name: "Scan", exact: true }).click();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor({ state: "detached" });
      expect(await page.evaluate(() => (window as unknown as { valueWhenScannerLeft?: string }).valueWhenScannerLeft)).toBe("W-42");
      expect(await page.locator('input[name="barcode"]').inputValue()).toBe("W-42");
      // Closing the scanner leaves its history entry at the same address: nothing loads and nothing is sent.
      await page.waitForFunction(() => !document.querySelector("[data-code-page][aria-busy]"));
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      expect(state.treeLoads).toBe(0);
      expect(state.posts).toEqual([]);
      // Back closes the scanner, not the page, and keeps what was typed.
      await page.getByRole("button", { name: "Scan", exact: true }).click();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor();
      await page.goBack();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor({ state: "detached" });
      await page.waitForFunction(() => !document.querySelector("[data-code-page][aria-busy]"));
      expect(page.url()).toBe(`${server.url.origin}/code/${codeId}/`);
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      expect(state.treeLoads).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    const denied = await open(390, { camera: "denied" });
    try {
      await denied.page.getByRole("button", { name: "Scan", exact: true }).click();
      await denied.page.getByText("Camera access is off. Allow it in the browser settings, or type the code.").waitFor();
      expect(await denied.page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("barcode");
      if (shots) await denied.page.screenshot({ path: join(shots, "code-page-camera-denied-light.png") });
      expect(denied.errors).toEqual([]);
    } finally {
      await denied.close();
    }
  }, 60_000);
});

type Rect = { x: number; y: number; width: number; height: number };
const rectOf = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  }, selector);
/**
 * Moves the pointer off every control before the page settles: a click leaves it resting on a button, whose hover
 * transition can start while `settled` waits (#3465).
 */
const restPointer = (page: Page) => page.mouse.move(1, 1);
const pill = (page: Page) => page.locator(".code-page-provenance__pill");
const card = (page: Page) => page.locator(".code-page-provenance__card");
/** Opens the card with a press and waits for its facts (or its failure) to show. */
const openCard = async (page: Page) => {
  await pill(page).click();
  await card(page).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".code-page-provenance__card [aria-busy='true']"));
  await settled(page);
};
/** Lage und Größe of what must never move: the page's heading, its scroll area, and the footer with the pill. */
const steady = (page: Page) =>
  page.evaluate(() =>
    ["[data-code-page] h1", ".k2b-app-workspace__main", "[data-code-provenance]", ".code-page-provenance__pill"].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return [selector, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
    }),
  );
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await settled(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the feat/code label of a Code page", () => {
  test("the footer stands in the same place for short, normal and long pages and with a form, and every page ends above it", async () => {
    for (const [frame, width, height] of [
      ["workspace", 1440, 900],
      ["plain", 1440, 900],
      ["workspace", 390, 844],
      ["plain", 390, 844],
    ] as const) {
      const places: (Rect | null)[] = [];
      for (const path of ["/week/short", "/week", "/week/long", "/week/form"]) {
        const { page, errors, close } = await open(width, { frame, height, path });
        try {
          await settled(page);
          const footer = await page.evaluate(() => {
            const element = document.querySelector<HTMLElement>("[data-code-provenance]")!;
            const box = element.getBoundingClientRect();
            const pillBox = element.querySelector(".code-page-provenance__pill")!.getBoundingClientRect();
            const hit = document.elementFromPoint(pillBox.left + pillBox.width / 2, pillBox.top + pillBox.height / 2);
            return {
              inTree: !!element.closest("[data-code-page-tree]"),
              treeIsolation: getComputedStyle(document.querySelector("[data-code-page-tree]")!).isolation,
              position: getComputedStyle(element).position,
              height: Math.round(box.height),
              onTop: !!hit && element.contains(hit),
              pillHeight: Math.round(pillBox.height),
              pillCentre: Math.round(pillBox.left + pillBox.width / 2),
              opaque: getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
            };
          });
          expect(footer).toMatchObject({
            inTree: false,
            treeIsolation: "isolate",
            position: width < 768 ? "fixed" : "sticky",
            height: width < 768 ? 40 : 44,
            onTop: true,
            pillHeight: 28,
            opaque: true,
          });
          // On a phone the pill sits in the middle; from 48rem at the right end.
          if (width < 768) expect(Math.abs(footer.pillCentre - width / 2)).toBeLessThanOrEqual(1);
          places.push(await rectOf(page, "[data-code-provenance]"));
          // A short page keeps the footer at the bottom edge of its scroll area, not right under the content.
          const edge = await page.evaluate(() => {
            const area = document.querySelector(".k2b-app-workspace__main")?.getBoundingClientRect();
            // On a phone the footer holds the window's edge, whichever element scrolls.
            return Math.round(area && window.innerWidth >= 768 ? area.bottom : window.innerHeight);
          });
          expect(places.at(-1)!.y + places.at(-1)!.height).toBe(edge);
          // Halfway down, the page passes behind the footer, which stays on top and in view.
          await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight / 2);
            const main = document.querySelector(".k2b-app-workspace__main");
            main?.scrollTo(0, main.scrollHeight / 2);
          });
          await settled(page);
          expect(await rectOf(page, "[data-code-provenance]")).toEqual(places.at(-1)!);
          await expectEndClear(page);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }
      for (const place of places) expect(place).toEqual(places[0]!);
    }
  }, 180_000);

  test("with a form the pill leads with no passwords; the part follows the tree and the pill grows to the left", async () => {
    for (const width of [1440, 390]) {
      const { page, errors, close } = await open(width, { frame: "workspace", path: "/week/form" });
      try {
        await settled(page);
        const parts = () =>
          page.evaluate(() => {
            const part = document.querySelector<HTMLElement>("[data-code-provenance-warning]")!;
            const owner = document.querySelector(".code-page-provenance__owner")!.getBoundingClientRect();
            return {
              shown: getComputedStyle(part).display !== "none",
              text: part.innerText.trim(),
              ownerRight: Math.round(owner.right),
              ownerTop: Math.round(owner.top),
            };
          });
        const withForm = await parts();
        expect(withForm).toMatchObject({ shown: true, text: width < 768 ? "No passwords" : "Do not enter passwords here" });
        const pillBox = (await rectOf(page, ".code-page-provenance__pill"))!;
        expect(pillBox.x).toBeGreaterThanOrEqual(0);
        expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(width);
        // A tree without a form takes the part away, with no script of the label's own; the owner part stays put.
        await page.evaluate(() => {
          for (const form of document.querySelectorAll('[data-code-block="Form"]')) form.setAttribute("data-code-block", "Gone");
        });
        const without = await parts();
        expect(without.shown).toBe(false);
        if (width >= 768) expect(without.ownerRight).toBe(withForm.ownerRight);
        expect(without.ownerTop).toBe(withForm.ownerTop);
        // A form that arrives later brings it back.
        await page.evaluate(() => {
          for (const form of document.querySelectorAll('[data-code-block="Gone"]')) form.setAttribute("data-code-block", "Form");
        });
        expect((await parts()).shown).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("the last field, keyboard focus and an anchor at the end stay above the footer, and printing puts the label after the page", async () => {
    for (const [frame, width, height] of [
      ["workspace", 1440, 520],
      ["plain", 1440, 520],
      ["workspace", 390, 667],
    ] as const) {
      const { page, errors, close } = await open(width, { frame, height, path: "/week/form" });
      try {
        await settled(page);
        const clear = (selector: string) =>
          page.evaluate((selector) => {
            const target = document.querySelector(selector)!.getBoundingClientRect();
            const footer = document.querySelector("[data-code-provenance]")!.getBoundingClientRect();
            return { above: target.bottom <= footer.top, inView: target.top >= 0 };
          }, selector);
        // Tab from the page's heading to the last field: the browser scrolls it into view above the footer.
        await page.locator("[data-code-page] h1").focus();
        for (let step = 0; step < 40; step++) {
          if (await page.evaluate(() => document.activeElement?.getAttribute("name") === "missing")) break;
          await page.keyboard.press("Tab");
        }
        expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("missing");
        await settled(page);
        expect(await clear('[data-code-field="missing"]')).toEqual({ above: true, inView: true });
        await page.keyboard.press("Tab");
        await settled(page);
        expect(await clear('[data-code-block="Form"] button[type="submit"]')).toEqual({ above: true, inView: true });
        // An anchor at the end scrolls in above the footer as well.
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.querySelector(".k2b-app-workspace__main")?.scrollTo(0, 0);
          document.querySelector('[data-code-block="Form"] button[type="submit"]')!.scrollIntoView({ block: "end" });
        });
        await settled(page);
        expect(await clear('[data-code-block="Form"] button[type="submit"]')).toEqual({ above: true, inView: true });
        await page.emulateMedia({ media: "print" });
        await settled(page);
        const printed = await page.evaluate(() => {
          const footer = document.querySelector("[data-code-provenance]")!;
          return {
            position: getComputedStyle(footer).position,
            after:
              footer.getBoundingClientRect().top >= document.querySelector("[data-code-page-tree]")!.getBoundingClientRect().bottom - 1,
            text: (footer as HTMLElement).innerText,
          };
        });
        expect(printed.position).toBe("static");
        expect(printed.after).toBe(true);
        expect(printed.text).toContain("Lea Muster");
        await page.emulateMedia({ media: "screen" });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
    // The on-screen keyboard of a phone is not part of a desktop browser test; the fixed footer then rides above it
    // like every fixed bar, and scroll padding keeps the focused field above it.
  }, 90_000);

  test("a press or Enter opens the card, resting the pointer does not, and Escape gives the focus back to the pill", async () => {
    const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.member });
    try {
      await settled(page);
      await pill(page).hover();
      // fixed wait: a hint card opens 400 ms after the pointer rests; this card must still be closed after that.
      await page.waitForTimeout(700);
      expect(await card(page).isVisible()).toBe(false);
      expect(state.reads).toHaveLength(0);
      await pill(page).focus();
      // fixed wait: keyboard focus opens a hint card at once; one frame is enough to see that this one stays closed.
      await page.waitForTimeout(100);
      expect(await card(page).isVisible()).toBe(false);
      await page.keyboard.press("Enter");
      await card(page).waitFor({ state: "visible" });
      await page.getByText("Lea Muster", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.closest(".code-page-provenance__card") !== null)).toBe(true);
      expect(state.reads).toEqual([{ codeId, path: "/week", version: versionValue }]);
      await page.keyboard.press("Escape");
      await card(page).waitFor({ state: "hidden" });
      expect(await page.evaluate(() => document.activeElement?.classList.contains("code-page-provenance__pill"))).toBe(true);
      // Opening again shows what is loaded; nothing is asked twice.
      await openCard(page);
      expect(state.reads).toHaveLength(1);
      await pill(page).click();
      await card(page).waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  test("the card stays in the visible area above the pill at every size; when it is tight only its body scrolls", async () => {
    for (const [width, height] of [
      [1440, 900],
      [1440, 700],
      [1280, 640],
      [1280, 420],
      [390, 844],
      [390, 667],
    ] as const) {
      const phone = width < 768;
      const { page, errors, close } = await open(width, { frame: "workspace", height, path: "/week", facts: facts.reader });
      try {
        await settled(page);
        const before = await steady(page);
        if (phone) await pill(page).tap();
        else await pill(page).click();
        await card(page).waitFor({ state: "visible" });
        await page.getByText("Lieferavise der Woche · Version 3").waitFor();
        await settled(page);
        // Opening the card moves nothing on the page.
        expect(await steady(page)).toEqual(before);
        const place = await page.evaluate(() => {
          const surface = document.querySelector<HTMLElement>(".code-page-provenance__card")!;
          const box = surface.getBoundingClientRect();
          const pillBox = document.querySelector(".code-page-provenance__pill")!.getBoundingClientRect();
          const head = surface.querySelector(".k2b-hover-card__head")!.getBoundingClientRect();
          const foot = surface.querySelector(".k2b-hover-card__foot")!.getBoundingClientRect();
          const body = surface.querySelector<HTMLElement>(".k2b-hover-card__body")!;
          return {
            sheet: surface.hasAttribute("data-sheet"),
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
            gap: pillBox.top - box.bottom,
            alignedEnd: Math.abs(pillBox.right - box.right),
            headIn: head.top >= box.top && head.bottom <= box.bottom,
            footIn: foot.top >= box.top && foot.bottom <= box.bottom,
            scrolls: body.scrollHeight > body.clientHeight + 1,
            width: box.width,
          };
        });
        expect(place.headIn).toBe(true);
        expect(place.footIn).toBe(true);
        if (phone) {
          expect(place.sheet).toBe(true);
          expect(Math.round(place.bottom)).toBe(height);
          expect(place.top).toBeGreaterThanOrEqual(48 - 1);
        } else {
          expect(place.sheet).toBe(false);
          expect(place.top).toBeGreaterThanOrEqual(8 - 0.5);
          expect(place.right).toBeLessThanOrEqual(width - 8 + 0.5);
          expect(Math.round(place.gap)).toBe(6);
          expect(place.alignedEnd).toBeLessThanOrEqual(0.5);
          expect(Math.round(place.width)).toBe(368);
        }
        // Only in the low window there is too little room: the body scrolls between title and last line.
        expect(place.scrolls).toBe(height <= 420);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 180_000);

  test("the card shows each viewer only what they may see", async () => {
    const cases = [
      [
        "visitor",
        { kind: "anonymous" },
        facts.visitor,
        ["Someone built this page themselves", "Cloud passes on", "nothing about your account"],
        ["Belongs to", "Report page", "Open automation", "Automation"],
      ],
      [
        "member",
        { kind: "person", name: "Lea Muster" },
        facts.member,
        ["This page belongs to Lea Muster", "Belongs to", "Lea Muster", "name, username and groups of your account", "Report page"],
        ["Open automation", "Switched on", "Approved"],
      ],
      [
        "reader",
        { kind: "person", name: "Lea Muster" },
        facts.reader,
        ["Lieferavise der Woche · Version 3", "since 11/03/2026", "by Jana Probe", "Open automation", "Report page"],
        [],
      ],
      [
        "mailbox",
        { kind: "resource", type: "Postfach" },
        facts.mailbox,
        ["This page belongs to: Postfach", "Postfach · not visible to you"],
        ["Open automation"],
      ],
      [
        "unclear",
        { kind: "anonymous" },
        facts.unclear,
        ["Someone built this page themselves", "cannot be retrieved right now", "Report page"],
        ["Open automation"],
      ],
      ["reported", { kind: "person", name: "Lea Muster" }, facts.reported, ["Reported on 11/12"], ["Report page"]],
    ] as const;
    for (const [name, label, answer, shown, hidden] of cases) {
      const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", label, facts: answer });
      try {
        await settled(page);
        await openCard(page);
        const text = await card(page).innerText();
        for (const part of shown) expect(text, name).toContain(part);
        for (const part of hidden) expect(text, name).not.toContain(part);
        // The three promises and the made-with line are always there.
        for (const part of ["Checked by Cloud:", "Not checked:", "No passwords:", "Made with"]) expect(text, name).toContain(part);
        if (name === "reader")
          expect(await card(page).getByRole("link", { name: "Open automation" }).getAttribute("href")).toBe("/app/assistant/code/c_page");
        // The card's type: title 14/600, entries 13/400, labels and meta 12/400; leading signs on one axis.
        const type = await meterType(page, ".code-page-provenance__card", { ignore: ".cloud-featcode" });
        expect(
          type.styles.every((style) => ["12/400", "13/400", "14/600"].includes(style)),
          JSON.stringify(type.samples),
        ).toBe(true);
        expect(type.offSizes).toEqual([]);
        expect(type.axes, name).toHaveLength(1);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 120_000);

  test("the pill has one text style, 12/400, and its signs share one line", async () => {
    for (const path of ["/week", "/week/form"]) {
      const { page, errors, close } = await open(1440, { frame: "workspace", path });
      try {
        await settled(page);
        const type = await meterType(page, ".code-page-provenance__pill", { ignore: ".cloud-featcode" });
        expect(type.styles).toEqual(["12/400"]);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("loading shows placeholders in the height of the rows, a failure offers Try again, and a changed page offers Reload", async () => {
    const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.member });
    try {
      await settled(page);
      state.readReplies.push({ delay: 900, response: () => Response.json({ data: facts.member }) });
      const before = await steady(page);
      await pill(page).click();
      const loading = card(page).locator("[aria-busy='true']");
      await loading.waitFor();
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".code-page-provenance__facts dd")).map((dd) => Math.round(dd.getBoundingClientRect().height)),
      );
      expect(rows).toEqual([20, 20]);
      expect(await card(page).innerText()).toContain("Checked by Cloud:");
      await page.getByText("Lea Muster", { exact: true }).waitFor();
      const loaded = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".code-page-provenance__facts dd")).map((dd) => Math.round(dd.getBoundingClientRect().height)),
      );
      expect(loaded[0]).toBe(20);
      expect(await steady(page)).toEqual(before);
      await pill(page).click();
      await card(page).waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    {
      const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.member });
      try {
        await settled(page);
        state.readReplies.push({ response: () => failure(503, "code_request_failed") });
        await openCard(page);
        expect(await card(page).innerText()).toContain("Who owns this page cannot be loaded right now. Try again");
        await card(page).getByRole("button", { name: "Try again" }).click();
        await page.getByText("Lea Muster", { exact: true }).waitFor();
        expect(state.reads).toHaveLength(2);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
    {
      const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.reader });
      try {
        await settled(page);
        state.readReplies.push({ response: () => failure(409, "code_page_changed") });
        await openCard(page);
        const text = await card(page).innerText();
        expect(text).toContain("The page has changed in the meantime. Reload, then the details are right.");
        expect(text).not.toContain("Report page");
        await Promise.all([page.waitForEvent("load"), card(page).getByRole("button", { name: "Reload" }).click()]);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 90_000);

  test("a new tree drops the loaded facts; the next opening asks again for the page shown now", async () => {
    const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week/form", facts: facts.member });
    try {
      await settled(page);
      const footer = await rectOf(page, "[data-code-provenance]");
      await openCard(page);
      await pill(page).click();
      await card(page).waitFor({ state: "hidden" });
      // The form answers with another tree, as a submit does.
      state.replies.push({ response: () => treeResponse(state.trees.get("/week")!) });
      await page.getByLabel("Was fehlt?", { exact: true }).fill("Scharniere");
      await page.getByRole("button", { name: "Melden", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-code-block="Form"]'));
      await settled(page);
      // The no-passwords part left with the form; the footer stays.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-code-provenance-warning]")!).display)).toBe("none");
      expect(await rectOf(page, "[data-code-provenance]")).toEqual(footer);
      await openCard(page);
      expect(state.reads).toHaveLength(2);
      expect(state.reads[1]).toEqual({ codeId, path: "/week/form", version: versionValue });
      await pill(page).click();
      await card(page).waitFor({ state: "hidden" });
      // A followed event loads the tree again: the facts go as well, and the footer stays where it is.
      const loads = state.treeLoads;
      await page.evaluate(() => (window as unknown as { emit: () => void }).emit());
      await page.waitForFunction(() => !document.querySelector("[data-code-page][aria-busy]"));
      expect(state.treeLoads).toBe(loads + 1);
      await settled(page);
      expect(await rectOf(page, "[data-code-provenance]")).toEqual(footer);
      await openCard(page);
      expect(state.reads).toHaveLength(3);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  test("a long owner name wraps inside its row and never overlaps the next fact (Rundgang #41)", async () => {
    const longOwner = {
      ...facts.reader,
      owner: { kind: "resource", type: "Postfach", name: "info@moebel-beispiel-lieferanten-und-avise.de" },
    } satisfies CodePageProvenance;
    for (const width of [1440, 390]) {
      const { page, errors, close } = await open(width, { frame: "workspace", path: "/week", facts: longOwner, locale: "de" });
      try {
        await settled(page);
        if (width < 768) {
          await pill(page).tap();
          await card(page).waitFor({ state: "visible" });
          await page.waitForFunction(() => !document.querySelector(".code-page-provenance__card [aria-busy='true']"));
          await settled(page);
        } else await openCard(page);
        const rows = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".code-page-provenance__facts dd")).map((dd) => {
            const own = dd.getBoundingClientRect();
            const content = Array.from(dd.querySelectorAll("*")).map((child) => child.getBoundingClientRect());
            return {
              top: own.top,
              bottom: own.bottom,
              contentTop: Math.min(own.top, ...content.map((box) => box.top)),
              contentBottom: Math.max(own.bottom, ...content.map((box) => box.bottom)),
            };
          }),
        );
        // The owner's name takes two lines here, and its row grows with it.
        expect(rows[0]!.bottom - rows[0]!.top).toBeGreaterThan(30);
        for (const [index, row] of rows.entries()) {
          expect(row.contentTop).toBeGreaterThanOrEqual(row.top - 0.5);
          expect(row.contentBottom).toBeLessThanOrEqual(row.bottom + 0.5);
          if (index > 0) expect(row.top).toBeGreaterThanOrEqual(rows[index - 1]!.bottom - 0.5);
        }
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("reporting: one optional reason, a required sentence, one size in every state, one key, and the card says Reported", async () => {
    for (const width of [1440, 390]) {
      const { page, errors, close } = await open(width, { frame: "workspace", path: "/week", facts: facts.member, locale: "de" });
      try {
        await settled(page);
        if (width < 768) await pill(page).tap();
        else await pill(page).click();
        await card(page).waitFor({ state: "visible" });
        await card(page).getByRole("button", { name: "Seite melden" }).click();
        const dialog = page.locator(".code-page-report");
        await dialog.waitFor();
        await page.getByText("Schreib einen Satz dazu. Dann kannst du melden.").waitFor();
        await restPointer(page);
        await settled(page);
        const frame = () => rectOf(page, ".code-page-report-frame");
        const send = page.locator(".code-page-report__actions button").last();
        const status = page.locator(".code-page-report__status");
        // Empty: the sentence is required, so "Melden" waits for it; the line below says why.
        expect(await send.isDisabled()).toBe(true);
        expect(await status.innerText()).toBe("Schreib einen Satz dazu. Dann kannst du melden.");
        const empty = await frame();
        if (width >= 768) {
          expect(empty!.width).toBe(480);
          await shoot(page, "89-seite-melden-leer-light-1440");
        }
        // The dialog's buttons keep @k2b/ui's regular button height; no dialog sets its own (Rundgang #44).
        const heights = await page.evaluate(() => {
          const reference = document.createElement("button");
          reference.className = "k2b-button";
          reference.dataset.size = "md";
          reference.textContent = "Melden";
          document.querySelector(".code-page-report__actions")!.after(reference);
          const regular = Math.round(reference.getBoundingClientRect().height);
          reference.remove();
          return {
            regular,
            dialog: Array.from(document.querySelectorAll(".code-page-report__actions button")).map((button) =>
              Math.round(button.getBoundingClientRect().height),
            ),
          };
        });
        expect(heights.dialog).toEqual([heights.regular, heights.regular]);
        // A reason is optional, one at most, and a second press takes it back.
        const reason = (label: string) => page.getByRole("button", { name: label, exact: true });
        await reason("Verdächtige Aktivität").click();
        await reason("Sicherheitsproblem").click();
        expect(await page.locator(".code-page-report__reasons [aria-pressed='true']").count()).toBe(1);
        await reason("Sicherheitsproblem").click();
        expect(await page.locator(".code-page-report__reasons [aria-pressed='true']").count()).toBe(0);
        await reason("Sicherheitsproblem").click();
        await page.locator(".code-page-report textarea").fill("Die Seite fragt nach meinen Zugangsdaten zum Lieferantenportal.");
        expect(await send.isEnabled()).toBe(true);
        expect(await status.innerText()).toBe("Geht an die Admins dieser Cloud.");
        await restPointer(page);
        await settled(page);
        expect(await frame()).toEqual(empty);
        if (width >= 768) await shoot(page, "75-seite-melden-light-1440");
        else await shoot(page, "92-seite-melden-telefon-light-390");
        if (width < 768) {
          // A sheet from below with two buttons of the same width.
          const sheet = await page.evaluate(() => {
            const frame = document.querySelector(".code-page-report-frame")!;
            const buttons = Array.from(document.querySelectorAll(".code-page-report__actions button")).map((button) =>
              Math.round(button.getBoundingClientRect().width),
            );
            return {
              bottom: Math.round(frame.getBoundingClientRect().bottom),
              radius: getComputedStyle(frame).borderTopLeftRadius,
              buttons,
            };
          });
          expect(sheet.bottom).toBe(900);
          expect(sheet.radius).toBe("16px");
          expect(sheet.buttons[0]).toBe(sheet.buttons[1]);
        }
        // Sending: fields and buttons are off, the line says so, and the dialog keeps its size.
        state.reportReplies.push({ delay: 700, response: () => failure(500, "code_request_failed") });
        await send.click();
        await page.waitForFunction(() => document.querySelector(".code-page-report")?.getAttribute("aria-busy") === "true");
        expect(await status.innerText()).toBe("Wird gesendet …");
        expect(await page.locator(".code-page-report textarea").isDisabled()).toBe(true);
        expect(await page.locator(".code-page-report__actions button").first().isDisabled()).toBe(true);
        expect(await frame()).toEqual(empty);
        // A failure keeps the text, says why in red, and the main button tries again.
        await page.waitForFunction(() => document.querySelector(".code-page-report__status")?.getAttribute("data-tone") === "danger");
        expect(await status.innerText()).toBe(
          width >= 768 ? "Die Meldung ist nicht angekommen. Dein Text bleibt stehen." : "Nicht angekommen. Dein Text bleibt stehen.",
        );
        if (width < 768) {
          // Rundgang #62: every failure fits the one 20px line on a phone, in German and English, without cutting.
          const sentences = (["de", "en"] as const).flatMap((locale) => {
            const words = provenanceMessages.resolve([locale]).t;
            return FAILURES.map((key) => words[`${key}Short`]);
          });
          const fits = await page.evaluate((all) => {
            const line = document.querySelector<HTMLElement>(".code-page-report__status")!;
            const span = line.querySelector<HTMLElement>(".code-page-report__short")!;
            const before = span.textContent;
            const result = all.map((sentence) => {
              span.textContent = sentence;
              return { sentence, height: Math.round(line.getBoundingClientRect().height), cut: span.scrollWidth > span.clientWidth };
            });
            span.textContent = before;
            return result;
          }, sentences);
          for (const fit of fits) expect(fit, fit.sentence).toEqual({ sentence: fit.sentence, height: 20, cut: false });
        }
        expect(await send.innerText()).toBe("Erneut versuchen");
        expect(await page.locator(".code-page-report textarea").inputValue()).toContain("Zugangsdaten");
        expect(await frame()).toEqual(empty);
        if (width >= 768) await shoot(page, "91-seite-melden-fehler-light-1440");
        const type = await meterType(page, ".code-page-report");
        expect(
          type.styles.every((style) => ["12/400", "13/400", "14/600"].includes(style)),
          JSON.stringify(type.samples),
        ).toBe(true);
        expect(type.offSizes).toEqual([]);
        await send.click();
        await page.getByText("Deine Meldung ist angekommen.").waitFor();
        await restPointer(page);
        await settled(page);
        if (width >= 768) await shoot(page, "90-seite-melden-gesendet-light-1440");
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Fertig");
        // Both sends carry the same key, the reason and the sentence.
        expect(state.reports).toHaveLength(2);
        expect(state.reports[0]).toMatchObject({
          codeId,
          path: "/week",
          version: versionValue,
          reason: "security",
          text: "Die Seite fragt nach meinen Zugangsdaten zum Lieferantenportal.",
        });
        expect(state.reports[1]!.key).toBe(state.reports[0]!.key);
        expect(String(state.reports[0]!.key)).toMatch(/^[0-9a-f-]{36}$/);
        await page.getByRole("button", { name: "Fertig" }).click();
        await dialog.waitFor({ state: "hidden" });
        // The card opens again beside the pill and says the page is reported; on a phone the pill keeps the focus
        // and the next tap shows the same.
        if (width < 768) {
          expect(await page.evaluate(() => document.activeElement?.classList.contains("code-page-provenance__pill"))).toBe(true);
          await pill(page).tap();
        }
        await card(page).waitFor({ state: "visible" });
        const text = await card(page).innerText();
        expect(text).toContain("Gemeldet. Die Admins sehen sich die Seite an.");
        expect(text).toContain("Gemeldet");
        expect(text).not.toContain("Seite melden");
        if (width >= 768) await shoot(page, "seite-gemeldet-light-1440");
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 120_000);

  test("a lost answer is checked before anything is sent again", async () => {
    const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.member });
    try {
      await settled(page);
      await openCard(page);
      await card(page).getByRole("button", { name: "Report page" }).click();
      await page.locator(".code-page-report textarea").fill("Asks for my password.");
      // The answer gets lost, but the report did arrive: the card's route says so, and nothing is sent twice.
      state.reportReplies.push({ response: () => new Response("lost", { status: 200 }) });
      state.readReplies.push({ response: () => Response.json({ data: facts.reported }) });
      await page.locator(".code-page-report__actions button").last().click();
      await page.getByText("Your report arrived.").waitFor();
      expect(state.reports).toHaveLength(1);
      expect(state.reads).toHaveLength(2);
      await page.keyboard.press("Escape");
      await page.locator(".code-page-report").waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    {
      const { page, errors, close } = await open(1440, { frame: "workspace", path: "/week", facts: facts.member });
      try {
        await settled(page);
        await openCard(page);
        await card(page).getByRole("button", { name: "Report page" }).click();
        await page.locator(".code-page-report textarea").fill("Asks for my password.");
        // Lost and not there: the dialog says so and offers to send again; a refusal names its reason.
        state.reportReplies.push({ response: () => new Response("lost", { status: 200 }) });
        await page.locator(".code-page-report__actions button").last().click();
        await page.getByText("The report did not arrive. Your text stays.").waitFor();
        state.reportReplies.push({ response: () => failure(429, "code_report_rate_limit") });
        await page.locator(".code-page-report__actions button").last().click();
        await page.getByText("You reported many pages just now. Try again in a minute.").waitFor();
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("light pictures of the label in the states of the concept", async () => {
    if (!shots) return;
    const pictures: [string, number, number, OpenOptions, boolean][] = [
      ["71-seite-kennzeichnung-light-1440", 1440, 900, { frame: "workspace", path: "/week", facts: facts.member }, false],
      ["72-seite-karte-mitglied-light-1440", 1440, 900, { frame: "workspace", path: "/week", facts: facts.member }, true],
      ["73-seite-formular-light-1440", 1440, 900, { frame: "workspace", path: "/week/form", facts: facts.member }, false],
      [
        "74-seite-karte-ohne-konto-light-1440",
        1440,
        900,
        { frame: "plain", path: "/callback", label: { kind: "anonymous" }, facts: facts.visitor },
        true,
      ],
      [
        "76-seite-telefon-light-390",
        390,
        780,
        { frame: "plain", path: "/callback", label: { kind: "anonymous" }, facts: facts.visitor },
        false,
      ],
      ["79-seite-karte-leser-light-1440", 1440, 900, { frame: "workspace", path: "/week", facts: facts.reader }, true],
      [
        "80-seite-telefon-karte-light-390",
        390,
        780,
        { frame: "plain", path: "/callback", label: { kind: "anonymous" }, facts: facts.visitor },
        true,
      ],
      [
        "seite-postfach-karte-light-1440",
        1440,
        900,
        { frame: "workspace", path: "/week", label: { kind: "resource", type: "Postfach" }, facts: facts.mailbox },
        true,
      ],
      [
        "seite-besitzer-unklar-light-1440",
        1440,
        900,
        { frame: "workspace", path: "/week", label: { kind: "anonymous" }, facts: facts.unclear },
        true,
      ],
      ["seite-schon-gemeldet-light-1440", 1440, 900, { frame: "workspace", path: "/week", facts: facts.reported }, true],
      ["seite-kurz-light-1440", 1440, 900, { frame: "workspace", path: "/week/short", facts: facts.member }, false],
      ["seite-lang-light-1440", 1440, 900, { frame: "workspace", path: "/week/long", facts: facts.member }, false],
      [
        "seite-allein-light-1440",
        1440,
        900,
        { frame: "plain", path: "/callback", label: { kind: "anonymous" }, facts: facts.visitor },
        false,
      ],
      ["seite-kennzeichnung-dark-1440", 1440, 900, { frame: "workspace", path: "/week/form", facts: facts.reader }, true],
    ];
    for (const [name, width, height, options, opened] of pictures) {
      const { page, errors, close } = await open(width, { ...options, height, locale: "de", reducedMotion: true });
      try {
        if (name.includes("dark"))
          await page.evaluate(() => {
            document.documentElement.className = "dark";
          });
        await settled(page);
        if (name === "seite-lang-light-1440")
          await page.evaluate(() => document.querySelector(".k2b-app-workspace__main")?.scrollTo(0, 260));
        if (opened) {
          if (width < 768) await pill(page).tap();
          else await pill(page).click();
          await card(page).waitFor({ state: "visible" });
          await page.waitForFunction(() => !document.querySelector(".code-page-provenance__card [aria-busy='true']"));
        }
        await settled(page);
        await shoot(page, name);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
    // The card's own states, in German like the concept: low window, loading, not loadable, changed meanwhile.
    const cardStates: [string, number, number, CodePageProvenance, Reply | null, boolean][] = [
      ["84-seite-karte-niedrig-light-1280", 1280, 420, facts.reader, null, true],
      [
        "seite-karte-laedt-light-1440",
        1440,
        900,
        facts.member,
        { delay: 2000, response: () => Response.json({ data: facts.member }) },
        false,
      ],
      ["seite-karte-fehler-light-1440", 1440, 900, facts.member, { response: () => failure(503, "code_request_failed") }, true],
      ["seite-karte-veraltet-light-1440", 1440, 900, facts.reader, { response: () => failure(409, "code_page_changed") }, true],
    ];
    for (const [name, width, height, cardFacts, reply, settle] of cardStates) {
      const { page, errors, close } = await open(width, {
        frame: "workspace",
        path: "/week",
        facts: cardFacts,
        height,
        locale: "de",
        reducedMotion: true,
      });
      try {
        await settled(page);
        if (reply) state.readReplies.push(reply);
        await pill(page).click();
        await card(page).waitFor({ state: "visible" });
        if (settle) {
          await page.waitForFunction(() => !document.querySelector(".code-page-provenance__card [aria-busy='true']"));
          await settled(page);
        } else await card(page).locator("[aria-busy='true']").waitFor();
        await shoot(page, name);
        if (!settle) await page.getByText("Lea Muster", { exact: true }).waitFor();
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 240_000);
});
