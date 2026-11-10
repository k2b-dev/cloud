import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { compileCapabilityManifest } from "../capabilities/testing";
import { type CapabilityInvocationResult, type CapabilityQueryDefinition, defineCapabilities } from "../contracts/capabilities";
import {
  FileProviderContextListInputSchema,
  type FileProviderEntry,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
  FileProviderTreeListInputSchema,
} from "../contracts/file-provider";
import { appAccentStyle } from "../ssr/app-appearance";

// User activation for the device dialog, focus, full-screen geometry, and whether a state change moves the frame
// depend on a real engine, so this runs the real chooser in a browser against invented provider answers.
const ui = resolve(import.meta.dir, "../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "choose-files.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-chooser-test",
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
  if (!build.success) throw new AggregateError(build.logs, "File chooser harness build failed");
  return build.outputs[0]!.text();
};

const run = (): CapabilityInvocationResult<never> => ({ ok: false, error: { code: "INTERNAL", message: "Not invoked.", status: 500 } });
const listQuery: CapabilityQueryDefinition = {
  title: "List",
  description: "List one folder.",
  input: FileProviderListInputSchema,
  data: FileProviderListDataSchema,
  openWorld: false,
  run,
};
const readQuery: CapabilityQueryDefinition = {
  title: "Read",
  description: "Read one file.",
  input: FileProviderReadInputSchema,
  data: z.object({}).strict(),
  openWorld: false,
  stream: { direction: "read", maxBytes: 1024, read: async () => new Response("") },
  run,
};
const providerApp = (appId: string, appName: string, appIcon: string) => ({
  appId,
  appName,
  appIcon,
  appDescription: "Files",
  manifest: compileCapabilityManifest(
    appId,
    defineCapabilities({
      protocolVersion: 2,
      queries: { "folder.list": listQuery, "file.read": readQuery },
      fileProvider: { list: "folder.list", read: "file.read" },
    }),
  ),
});
const drive = providerApp("drive", "Drive", "ti ti-cloud");
// Invoices accepts caller context and has invoices only for customer c1; it shows nothing without that customer.
const invoices = {
  ...providerApp("invoices", "Invoices", "ti ti-receipt"),
  manifest: compileCapabilityManifest(
    "invoices",
    defineCapabilities({
      protocolVersion: 2,
      queries: { "folder.list": { ...listQuery, input: FileProviderContextListInputSchema }, "file.read": readQuery },
      fileProvider: { list: "folder.list", read: "file.read" },
    }),
  ),
};
// IDs only have to be unique within one provider: Vault also has a file "notes".
const vault = providerApp("vault", "Vault", "ti ti-lock");
const notes = {
  appId: "notes",
  appName: "Notes",
  appIcon: "ti ti-notebook",
  appDescription: "Notes",
  manifest: compileCapabilityManifest("notes", defineCapabilities({ protocolVersion: 2, queries: { "folder.list": listQuery } })),
};

const folder = (id: string, name: string): FileProviderEntry => ({ kind: "folder", id, name, icon: "ti ti-folder" });
const file = (id: string, name: string, content: string, extra: Partial<FileProviderEntry> = {}): FileProviderEntry =>
  ({
    kind: "file",
    id,
    name,
    size: content.length,
    mediaType: "text/plain",
    updatedAt: "2026-10-01T10:00:00Z",
    ...extra,
  }) as FileProviderEntry;
/** A one-page PDF that pdf.js can draw, with a correct cross-reference table. */
const onePagePdf = (() => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
})();
const onePixelPng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);
// The scan inbox of a warehouse app: its provider names its own source "Scanner" and searches below a folder.
const scans = {
  appId: "scans",
  appName: "Warehouse",
  appIcon: "ti ti-building-warehouse",
  appDescription: "Warehouse",
  manifest: compileCapabilityManifest(
    "scans",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        "folder.list": { ...listQuery, input: FileProviderTreeListInputSchema },
        "file.read": { ...readQuery, stream: { direction: "read", maxBytes: 100_000, read: async () => new Response("") } },
      },
      fileProvider: { list: "folder.list", read: "file.read", title: "Scanner", icon: "ti ti-scan" },
    }),
  ),
};
const longNames = {
  ablage: "Scanner-Ablage im Büro am Eingang",
  info: "Info-Blätter für alle Standorte",
  schilder: "Hinweisschilder und Aushänge",
};
const scanPlace = (...ids: ("buero" | "ablage" | "intern" | "info" | "schilder")[]) => ({
  appId: "scans",
  folders: ids.map((id) => ({ id, name: { buero: "Büro", intern: "Intern", ...longNames }[id] })),
});
const driveText = { notes: "meeting notes", todo: "buy milk", plan: "plan b" };
const vaultText = { notes: "vault notes" };
const contents: Record<string, Record<string, string | Uint8Array<ArrayBuffer>>> = {
  drive: driveText,
  vault: vaultText,
  scans: { scan: onePagePdf, photo: onePixelPng, memo: "memo", hinweis: onePagePdf },
};
const trees: Record<string, Record<string, FileProviderEntry[]>> = {
  drive: {
    "": [folder("home", "Home"), folder("team", "Team"), folder("broken", "Broken")],
    home: [
      folder("reports", "Reports"),
      file("notes", "notes.txt", driveText.notes, { tags: [{ label: "Draft", tone: "warning" }] }),
      file("todo", "todo.txt", driveText.todo),
      file("plan", "plan.txt", driveText.plan),
      file("huge", "huge.zip", "", { size: 5000, mediaType: "application/zip" }),
    ],
    reports: [],
  },
  vault: { "": [file("notes", "notes.txt", vaultText.notes)] },
  scans: {
    "": [folder("buero", "Büro")],
    buero: [folder("ablage", longNames.ablage)],
    ablage: [
      folder("intern", "Intern"),
      file("scan", "scan.pdf", "", { size: onePagePdf.length, mediaType: "application/pdf" }),
      file("photo", "photo.png", "", { size: onePixelPng.length, mediaType: "image/png" }),
      file("memo", "memo.txt", "memo"),
    ],
    intern: [folder("info", longNames.info)],
    info: [folder("schilder", longNames.schilder)],
    schilder: [file("hinweis", "Hinweis Eingang.pdf", "", { size: onePagePdf.length, mediaType: "application/pdf" })],
  },
};
/** Reads per stream, as `app:id`. */
const reads = new Map<string, number>();

let catalogApps: unknown[] = [];
/** A catalog status other than 200 refuses the caller, like Core does for a visitor of a public page. */
let catalogStatus = 200;
let catalogRequests = 0;
let catalogGate: Promise<void> | undefined;
let brokenAnswers = 0;
let readGate: Promise<void> | undefined;
/** Holds every folder listing while set, so a test can see a folder that is still loading. */
let listGate: Promise<void> | undefined;
/** The one stream the gate holds, as `app:id`; without it the gate holds every read. */
let gatedRead: string | undefined;
let openReads = 0;
let peakReads = 0;
const queries: Record<string, unknown>[] = [];
/** The place the server remembers for the person, and every place the chooser saved. */
let serverPlace: unknown = null;
const placeWrites: unknown[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status });

const answer = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/me/file-chooser/place") {
    if (request.method === "PUT") {
      placeWrites.push(((await request.json()) as { place: unknown }).place);
      return new Response(null, { status: 204 });
    }
    return json({ place: serverPlace });
  }
  if (url.pathname === "/api/capabilities/v1/catalog") {
    catalogRequests++;
    await catalogGate;
    if (catalogStatus !== 200) return json({ code: "UNAUTHORIZED", message: "Sign in" }, catalogStatus);
    return json({ protocolVersion: 2, apps: catalogApps, page: { hasMore: false } });
  }
  const [, app = "", operation] = /^\/api\/capabilities\/v1\/queries\/(\w+)\/([\w.]+)$/.exec(url.pathname) ?? [];
  if (operation === "folder.list") {
    const { input } = (await request.json()) as { input: { parent?: string; query?: string } };
    queries.push(input);
    await listGate;
    if (app === "invoices") {
      const refs = (input as { context?: { refs: { type: string; id: string }[] } }).context?.refs ?? [];
      const customers = refs.filter((ref) => ref.type === "customers.customer" && ref.id === "c1").map((ref) => ref.id);
      const items = customers.map((id) => file(`invoice-${id}`, `Invoice ${id}.pdf`, `invoice ${id}`));
      return json({ data: { writable: false, items, next: null } });
    }
    if (input.parent === "team") return json({ code: "FORBIDDEN", message: "No access" }, 403);
    if (input.parent === "broken" && brokenAnswers++ === 0) return json({ code: "APP_UNAVAILABLE", message: "Down" }, 503);
    if (app === "scans" && input.query && (input as { scope?: string }).scope === "tree") {
      const hit = { ...trees.scans!.schilder![0]!, location: `Intern / ${longNames.info} / ${longNames.schilder}` };
      return json({
        data: { writable: false, items: hit.name.toLowerCase().includes(input.query.toLowerCase()) ? [hit] : [], next: null },
      });
    }
    const items = (trees[app]?.[input.parent ?? ""] ?? []).filter((entry) => !input.query || entry.name.includes(input.query));
    return json({ data: { writable: false, items, next: null } });
  }
  if (operation === "file.read") {
    const { input } = (await request.json()) as { input: { id: string } };
    const content = contents[app]?.[input.id] ?? "";
    // Like Files, the stream reports the type the listing claimed; the chooser checks it against the first bytes.
    const listed = Object.values(trees[app] ?? {})
      .flat()
      .find((entry) => entry.id === input.id);
    return json({
      data: {},
      stream: {
        id: `${app}:${input.id}`,
        direction: "read",
        mediaType: (listed?.kind === "file" && listed.mediaType) || "text/plain",
        size: content.length,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }
  if (url.pathname === "/api/capabilities/v1/streams/read") {
    const stream = request.headers.get("x-cloud-stream-id") ?? "";
    const [app = "", id = ""] = stream.split(":");
    openReads++;
    reads.set(stream, (reads.get(stream) ?? 0) + 1);
    peakReads = Math.max(peakReads, openReads);
    if (!gatedRead || gatedRead === stream) await readGate;
    openReads--;
    return new Response(contents[app]?.[id] ?? "");
  }
  return new Response(null, { status: 404 });
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/api/")) return answer(request);
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const lang = url.searchParams.get("lang") ?? "en";
      return new Response(
        `<!doctype html><html lang="${lang}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui"><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser({ serveShellCatalog: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

/** A fresh document does no discovery. Warm only when a test explicitly needs a previously known list. */
const open = async (view: View, query = "", warm = false) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // Playwright turns on file chooser interception with an unawaited round trip when the first listener arrives. A
  // listener added only right before the key press can miss a chooser that opens at once, so subscribe up front.
  page.on("filechooser", () => undefined);
  await page.goto(`http://127.0.0.1:${server.port}/${query}`);
  if (warm) {
    await page.locator("#attach").click();
    await page.locator("dialog[open] .cloud-file-chooser").waitFor();
    await page.waitForFunction(() => !document.querySelector(".cloud-file-dialog__source-skeleton"));
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    // This setup choice is not part of the result being tested.
    await page.evaluate(() => (window as unknown as { chosen: unknown[] }).chosen.splice(0));
  }
  return { page, context, close: () => context.close() };
};
const chosen = (page: Page) => page.evaluate(() => (window as unknown as { chosen: unknown[] }).chosen);
const dialogBox = (page: Page) =>
  page.locator("dialog[open]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  });
const rows = (page: Page) => page.locator('dialog [role="gridcell"]');
const rowNames = (page: Page) => page.locator('dialog [role="gridcell"] .cloud-file-dialog__name').allTextContents();
const row = (page: Page, name: string) => page.locator("dialog .cloud-file-dialog__name").getByText(name, { exact: true });
const sourceNames = (page: Page) => page.locator("dialog .cloud-file-dialog__source-name").allTextContents();
const source = (page: Page, name: string) =>
  page.locator("dialog .cloud-file-dialog__source").filter({ has: page.getByText(name, { exact: true }) });
const currentSource = (page: Page) => page.locator('dialog .cloud-file-dialog__source[aria-current="true"]').textContent();
/** The text of the focused row, or null when focus is anywhere else. */
const focusedRow = (page: Page) =>
  page.evaluate(() => (document.activeElement?.matches('[role="gridcell"]') ? document.activeElement.textContent : null));
const focusedSource = (page: Page) =>
  page.evaluate(() => (document.activeElement?.matches(".cloud-file-dialog__source") ? document.activeElement.textContent : null));
/** `restored`: the chooser opens at a remembered folder, whose first row takes focus once it shows. */
const attach = async (page: Page, loading = false, restored = false) => {
  await page.locator("#attach").click();
  await page.locator("dialog[open]").waitFor();
  if (!loading) await page.waitForFunction(() => !document.querySelector(".cloud-file-dialog__source-skeleton"));
  // The chooser moves focus to This device once it opened; a key pressed before that would reach the page.
  if (restored) await page.waitForFunction(() => document.activeElement?.matches('dialog [role="gridcell"]'));
  else await page.waitForFunction(() => document.activeElement?.matches('dialog .cloud-file-dialog__source[aria-current="true"]'));
};
const status = (page: Page) => page.locator(".cloud-file-chooser__status").textContent();
/** Where the footer buttons are; selecting and adding must not move them. */
const footer = (page: Page) =>
  page.locator(".cloud-file-chooser__actions button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    }),
  );
/** One element's box, rounded, relative to the dialog's surface inside its 1 px frame. */
const boxIn = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const frame = document.querySelector("dialog[open] .k2b-panel-dialog")!.getBoundingClientRect();
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (!rect) return null;
    return {
      left: Math.round(rect.left - frame.left),
      top: Math.round(rect.top - frame.top),
      right: Math.round(frame.right - rect.right),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, selector);

describe("choosing files in a browser", () => {
  test("page load and idle do not request providers; the first action loads them with retry in the same frame", async () => {
    catalogApps = [drive];
    catalogStatus = 503;
    const before = catalogRequests;
    const { page, close } = await open(phone);
    try {
      // Allow both the native idle callback and its one-second fallback to run.
      await page.waitForTimeout(1200);
      expect(catalogRequests).toBe(before);
      await attach(page);
      expect(catalogRequests).toBe(before + 1);
      await page.getByText("Apps not loaded", { exact: false }).waitFor();
      const frame = await dialogBox(page);
      const actions = await footer(page);
      let release!: () => void;
      catalogGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      catalogStatus = 200;
      try {
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".cloud-file-dialog__source-skeleton").first().waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        release();
        await source(page, "Drive").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        expect(await footer(page)).toEqual(actions);
        expect(catalogRequests).toBe(before + 2);
      } finally {
        release();
      }
    } finally {
      catalogGate = undefined;
      catalogStatus = 200;
      await close();
    }
  }, 30_000);

  test("without providers, Attach opens the device's file dialog directly", async () => {
    catalogApps = [notes];
    const { page, close } = await open(desktop, "?single", true);
    try {
      const picker = page.waitForEvent("filechooser");
      await page.locator("#attach").click();
      const chooser = await picker;
      expect(chooser.isMultiple()).toBe(false);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      await chooser.setFiles({ name: "local.txt", mimeType: "text/plain", buffer: Buffer.from("local") });
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[{ name: "local.txt", type: "text/plain", size: 5, text: "local" }]]);
    } finally {
      await close();
    }
  }, 30_000);

  test("with no providers already known, an abort while the device's dialog is open resolves nothing and drops a later pick", async () => {
    catalogApps = [notes];
    const { page, close } = await open(desktop, "", true);
    try {
      const picker = page.waitForEvent("filechooser");
      await page.locator("#attach").click();
      const chooser = await picker;
      await page.evaluate(() => (window as unknown as { abortChoosing: () => void }).abortChoosing());
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      await chooser.setFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("late") });
      await page.waitForTimeout(100);
      expect(await chosen(page)).toEqual([[]]);
    } finally {
      await close();
    }
  }, 30_000);

  test("with providers, the chooser opens on This device: Enter, a click on it, or its drop zone opens the device's dialog", async () => {
    catalogApps = [notes, drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view);
      try {
        await attach(page);
        expect(await sourceNames(page)).toEqual(["This device", "Drive"]);
        expect(await focusedSource(page)).toContain("This device");
        expect(await page.locator("dialog .k2b-dropzone").isVisible()).toBe(true);
        const box = await dialogBox(page);
        if (view === phone) expect(box).toEqual([0, 0, phone.width, phone.height]);
        // From 75 rem the chooser is 1040 × 640 px, with room for the preview beside the list.
        else expect(box).toEqual([(desktop.width - 1040) / 2, (desktop.height - 640) / 2, 1040, 640]);
        // No source chosen yet: Add stays in its place, disabled.
        expect(await page.getByRole("button", { name: "Add", exact: true }).isDisabled()).toBe(true);
        let picker = page.waitForEvent("filechooser");
        await page.keyboard.press("Enter");
        expect((await picker).isMultiple()).toBe(true);
        picker = page.waitForEvent("filechooser");
        await page.locator("dialog .k2b-dropzone").click();
        await picker;
        picker = page.waitForEvent("filechooser");
        await source(page, "This device").click();
        const chooser = await picker;
        await chooser.setFiles([{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        expect(await page.locator("dialog[open]").count()).toBe(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("arrow keys move between sources without opening one, and one Escape closes the chooser", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      await page.keyboard.press("ArrowDown");
      expect(await focusedSource(page)).toContain("Drive");
      expect(await currentSource(page)).toContain("This device");
      await page.keyboard.press("ArrowUp");
      expect(await focusedSource(page)).toContain("This device");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[]]);
      expect(await page.locator("dialog[open]").count()).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  test("a double-click on a source opens it once", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      const before = queries.length;
      await source(page, "Drive").dblclick();
      await row(page, "Team").waitFor();
      await page.waitForTimeout(150);
      expect(queries.length - before).toBe(1);
      expect(await rowNames(page)).toEqual(["Home", "Team", "Broken"]);
    } finally {
      await close();
    }
  }, 30_000);

  test("apps that answer after the click replace two placeholder rows without moving anything or taking focus", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      let release!: () => void;
      catalogGate = new Promise((resolve) => {
        release = resolve;
      });
      // A fresh page: the first file action starts discovery and opens its reserved loading frame.
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await attach(page, true);
        await page.getByText("Looking for apps with files…").waitFor({ state: "attached" });
        expect(await sourceNames(page)).toEqual(["This device"]);
        expect(await page.locator("dialog .cloud-file-dialog__source-skeleton").count()).toBe(2);
        await settled(page);
        const frame = await dialogBox(page);
        const device = await boxIn(page, ".cloud-file-dialog__source");
        const zone = await boxIn(page, "dialog .k2b-dropzone");
        const buttons = await footer(page);
        release();
        await source(page, "Drive").waitFor();
        await settled(page);
        expect(await page.locator("dialog .cloud-file-dialog__source-skeleton").count()).toBe(0);
        expect(await dialogBox(page)).toEqual(frame);
        expect(await boxIn(page, ".cloud-file-dialog__source")).toEqual(device);
        expect(await boxIn(page, "dialog .k2b-dropzone")).toEqual(zone);
        expect(await footer(page)).toEqual(buttons);
        expect(await focusedSource(page)).toContain("This device");
      } finally {
        catalogGate = undefined;
        await context.close();
      }
    }
  }, 60_000);

  test("one grid: sources, toolbar, list, and buttons share their edges, and loading a folder moves nothing", async () => {
    catalogApps = [drive, vault];
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      // This device: the first source and the drop zone start on one line.
      const firstSource = (await boxIn(page, ".cloud-file-dialog__source"))!;
      expect((await boxIn(page, "dialog .k2b-dropzone"))!.top).toBe(firstSource.top);
      expect(firstSource.height).toBe(36);
      expect((await boxIn(page, ".cloud-file-dialog__chip"))!.left).toBe(20);
      expect((await boxIn(page, "dialog h2"))!.left).toBe(20);
      expect((await boxIn(page, "dialog .k2b-dialog__close"))!.right).toBe(12);
      expect((await boxIn(page, ".cloud-file-chooser__add"))!.right).toBe(12);

      await source(page, "Drive").click();
      let release!: () => void;
      listGate = new Promise((resolve) => {
        release = resolve;
      });
      await row(page, "Home").click();
      // While the folder loads, rows of the same height stand where its entries will be.
      await page.locator("dialog .cloud-file-dialog__skeleton-row").first().waitFor();
      await settled(page);
      const placeholder = (await boxIn(page, "dialog .cloud-file-dialog__skeleton-row"))!;
      release();
      listGate = undefined;
      await row(page, "notes.txt").waitFor();
      await settled(page);
      const loaded = (await boxIn(page, 'dialog [role="gridcell"]'))!;
      expect([loaded.top, loaded.left, loaded.height]).toEqual([placeholder.top, placeholder.left, placeholder.height]);
      const toolbar = (await boxIn(page, ".cloud-file-chooser__toolbar"))!;
      const filter = (await boxIn(page, ".cloud-file-chooser__filter .k2b-input-shell"))!;
      expect(toolbar.top).toBe(firstSource.top);
      expect(filter.top).toBe(firstSource.top);
      expect(filter.height).toBe(firstSource.height);
      // The preview column stands right of the list; its frame starts on the first source's line and ends 12 px
      // before the dialog edge, like the filter did before it.
      const aside = (await boxIn(page, ".cloud-file-dialog__aside"))!;
      const frameBox = (await boxIn(page, ".cloud-file-preview__frame"))!;
      expect(aside.width).toBe(320);
      expect(filter.right).toBe(aside.width + 12);
      expect(frameBox.top).toBe(firstSource.top);
      expect(frameBox.right).toBe(12);
      const firstRow = (await boxIn(page, 'dialog [role="gridcell"]'))!;
      expect(firstRow.height).toBe(48);
      expect(firstRow.top).toBe(toolbar.top + 36 + 12);

      // Add keeps one width for none, two, and more files.
      const add = page.locator(".cloud-file-chooser__add");
      const empty = (await add.boundingBox())!.width;
      await row(page, "notes.txt").click();
      await row(page, "todo.txt").click();
      expect(await add.textContent()).toBe("Add (2)");
      await settled(page);
      expect((await add.boundingBox())!.width).toBe(empty);
      expect(await status(page)).toBe("2 files selected");
      await row(page, "plan.txt").click();
      await settled(page);
      expect((await add.boundingBox())!.width).toBe(empty);
    } finally {
      listGate = undefined;
      await close();
    }
  }, 30_000);

  test("a picked provider file uses the opener app's ink and keeps its row geometry, in light and dark", async () => {
    catalogApps = [drive];
    for (const dark of [false, true]) {
      const { page, close } = await open(desktop, "?max=100");
      try {
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle("dark", dark);
          document.documentElement.classList.toggle("light", !dark);
        }, dark);
        // The page shell renders `<body class="k2b-ui app-accent-scope" style="…">` for an app page.
        await page.evaluate((style) => {
          document.body.classList.add("app-accent-scope");
          document.body.style.cssText = style ?? "";
        }, appAccentStyle("#0f766e"));
        await attach(page);
        await source(page, "Drive").click();
        await row(page, "Home").click();
        await page.waitForFunction(() => document.querySelectorAll('dialog [role="gridcell"]').length === 5);
        expect(await rowNames(page)).toEqual(["Reports", "notes.txt", "todo.txt", "plan.txt", "huge.zip"]);
        expect(await focusedRow(page)).toContain("Reports");
        await page.keyboard.press("ArrowDown");
        expect(await focusedRow(page)).toContain("notes.txt");
        const fileRow = rows(page).nth(1);
        await settled(page);
        const before = await fileRow.boundingBox();
        expect(before).not.toBeNull();
        await page.keyboard.press("Space");
        expect(await fileRow.getAttribute("aria-selected")).toBe("true");
        await settled(page);
        expect(await fileRow.boundingBox()).toEqual(before);
        const colors = await fileRow.locator(".k2b-file-grid__check-box").evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;color:var(--k2b-app-workspace-active)";
          element.append(probe);
          const appInk = getComputedStyle(probe).color;
          document.documentElement.append(probe);
          const defaultInk = getComputedStyle(probe).color;
          probe.remove();
          return { checked: getComputedStyle(element).backgroundColor, appInk, defaultInk };
        });
        expect(colors.checked).toBe(colors.appInk);
        expect(colors.checked).not.toBe(colors.defaultInk);
      } finally {
        await close();
      }
    }
  }, 30_000);

  test("browses a provider by keyboard, disables what does not fit, and reads at most three files at once", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, "?max=100");
      try {
        await attach(page);
        const frame = await dialogBox(page);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelectorAll('dialog [role="gridcell"]').length === 3);
        expect(await rowNames(page)).toEqual(["Home", "Team", "Broken"]);
        expect(await currentSource(page)).toContain("Drive");
        await row(page, "Home").click();
        await page.waitForFunction(() => document.querySelectorAll('dialog [role="gridcell"]').length === 5);
        expect(await focusedRow(page)).toContain("Reports");
        const huge = rows(page).nth(4);
        expect(await huge.getAttribute("aria-disabled")).toBe("true");
        expect(await huge.textContent()).toContain(view === phone ? "Over 100 B" : "Too large, up to 100 B");
        expect(await rows(page).nth(1).textContent()).toContain("Draft");
        const buttons = await footer(page);

        // Arrows move focus only; Space and a tap toggle.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        await rows(page).nth(3).click();
        expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(3);
        await settled(page);
        expect(await dialogBox(page)).toEqual(frame);
        expect(await footer(page)).toEqual(buttons);

        // The file that does not fit is a focus stop, so its reason is read out, but Space and Enter do nothing.
        await page.keyboard.press("End");
        expect(await focusedRow(page)).toContain("huge.zip");
        await page.keyboard.press("Space");
        await page.keyboard.press("Enter");
        expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(3);
        expect(await page.locator(".cloud-file-chooser__downloads").count()).toBe(0);

        let release!: () => void;
        readGate = new Promise((resolve) => {
          release = resolve;
        });
        peakReads = 0;
        await page.getByRole("button", { name: "Add (3)", exact: true }).click();
        await page.locator(".cloud-file-chooser__downloads").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        expect(await footer(page)).toEqual(buttons);
        for (let attempt = 0; openReads < 3 && attempt < 100; attempt++) await Bun.sleep(10);
        await Bun.sleep(100);
        expect(peakReads).toBe(3);
        release();
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        readGate = undefined;
        expect(await chosen(page)).toEqual([
          [
            { name: "notes.txt", type: "text/plain", size: 13, text: "meeting notes" },
            { name: "todo.txt", type: "text/plain", size: 8, text: "buy milk" },
            { name: "plan.txt", type: "text/plain", size: 6, text: "plan b" },
          ],
        ]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 90_000);

  test("Cancel stops a transfer and forgets it, so another provider's file with the same ID comes from that provider", async () => {
    catalogApps = [drive, vault];
    let release = () => {};
    readGate = new Promise((resolve) => {
      release = resolve;
    });
    gatedRead = "drive:todo";
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      await source(page, "Drive").click();
      await row(page, "Home").click();
      await row(page, "notes.txt").click();
      await row(page, "todo.txt").click();
      await page.getByRole("button", { name: "Add (2)", exact: true }).click();
      await page.locator(".cloud-file-chooser__status").getByText("1 of 2 ready").waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
      await row(page, "notes.txt").waitFor();
      expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(2);

      await source(page, "Vault").click();
      await row(page, "notes.txt").click();
      await page.getByRole("button", { name: "Add (1)", exact: true }).click();
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[{ name: "notes.txt", type: "text/plain", size: 11, text: "vault notes" }]]);
    } finally {
      release();
      readGate = undefined;
      gatedRead = undefined;
      await close();
    }
  }, 30_000);

  test("maxFiles and maxTotalBytes bound one choice: Add stays disabled with the reason in the status", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, "?maxTotal=20&maxFiles=2");
      try {
        await attach(page);
        await source(page, "Drive").click();
        await row(page, "Home").click();
        await row(page, "notes.txt").waitFor();
        expect(await status(page)).toBe("Select one or more files · at most 2 files, up to 20 B together");
        const add = page.locator(".cloud-file-chooser__add");
        await row(page, "notes.txt").click();
        await row(page, "todo.txt").click();
        expect(await status(page)).toBe("Too large together, up to 20 B");
        expect(await page.locator('.cloud-file-chooser__status[data-error="true"]').isVisible()).toBe(true);
        expect(await add.isDisabled()).toBe(true);
        await row(page, "todo.txt").click();
        await row(page, "plan.txt").click();
        expect(await status(page)).toBe("2 files selected");
        await row(page, "todo.txt").click();
        expect(await status(page)).toBe("At most 2 files");
        expect(await add.isDisabled()).toBe(true);
        await row(page, "todo.txt").click();
        await add.click();
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        expect((await chosen(page))[0]).toMatchObject([{ name: "notes.txt" }, { name: "plan.txt" }]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("explains empty, filtered, forbidden, unavailable, and offline folders in one unmoving frame, on desktop and phone", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      brokenAnswers = 0;
      const { page, context, close } = await open(view);
      try {
        await attach(page);
        const frame = await dialogBox(page);
        const buttons = await footer(page);
        const crumb = (name: string) => page.locator(".cloud-file-chooser__crumbs").getByRole("button", { name, exact: true });
        await source(page, "Drive").click();
        await row(page, "Team").waitFor();
        await row(page, "Home").click();
        await row(page, "Reports").waitFor();
        expect(await dialogBox(page)).toEqual(frame);

        if (view === desktop) {
          await page.getByRole("searchbox", { name: "Filter this folder" }).fill("zzz");
          await page.getByText("Nothing matches “zzz”").waitFor();
          expect(queries.at(-1)).toEqual({ parent: "home", query: "zzz", limit: 50 });
          expect(await dialogBox(page)).toEqual(frame);
          // The empty state has no second action; the filter itself clears.
          expect(await page.getByRole("button", { name: "Clear filter" }).count()).toBe(0);
          await page.getByRole("searchbox", { name: "Filter this folder" }).fill("");
          await row(page, "notes.txt").waitFor();
        }

        await row(page, "Reports").click();
        await page.getByText("This folder is empty").waitFor();
        expect(await dialogBox(page)).toEqual(frame);

        await crumb("Drive").click();
        await row(page, "Team").click();
        await page.getByText("You no longer have access to this folder").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        await page.locator("dialog .k2b-placeholder").getByRole("button", { name: "Up" }).click();
        await row(page, "Broken").click();
        await page.getByText("Drive is not available right now").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        await page.getByRole("button", { name: "Try again" }).click();
        await page.getByText("This folder is empty").waitFor();

        await crumb("Drive").click();
        await row(page, "Home").waitFor();
        await context.setOffline(true);
        await row(page, "Home").click();
        await page.getByText("You are offline").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        expect(await footer(page)).toEqual(buttons);
        await context.setOffline(false);
        await page.getByRole("button", { name: "Try again" }).click();
        await row(page, "notes.txt").waitFor();
      } finally {
        await close();
      }
    }
  }, 90_000);

  test("context reaches only the provider that accepts it, which shows its customer's files or a calm empty root in place", async () => {
    catalogApps = [drive, invoices];
    const title = "No matching files for these recipients";
    const other = await open(desktop, `?customer=c2&noMatching=${encodeURIComponent(title)}`);
    try {
      await attach(other.page);
      const frame = await dialogBox(other.page);
      await source(other.page, "Invoices").click();
      await other.page.getByText(title).waitFor();
      expect(queries.at(-1)).toEqual({ context: { refs: [{ type: "customers.customer", id: "c2" }] }, limit: 50 });
      expect(await dialogBox(other.page)).toEqual(frame);
      await source(other.page, "Drive").click();
      await row(other.page, "Home").waitFor();
      // Drive's list input is closed and names no context, so it never receives one.
      expect(queries.at(-1)).toEqual({ limit: 50 });
    } finally {
      await other.close();
    }
    const matching = await open(desktop, "?customer=c1");
    try {
      await attach(matching.page);
      await source(matching.page, "Invoices").click();
      await row(matching.page, "Invoice c1.pdf").waitFor();
      expect(await rowNames(matching.page)).toEqual(["Invoice c1.pdf"]);
    } finally {
      await matching.close();
    }
  }, 60_000);

  test("Escape closes the chooser with nothing chosen and returns focus to Attach, in German too", async () => {
    catalogApps = [drive];
    const { page, close } = await open(phone, "?lang=de");
    try {
      await attach(page);
      expect(await sourceNames(page)).toEqual(["Dieses Gerät", "Drive"]);
      expect(await page.locator("dialog h2").textContent()).toBe("Dateien hinzufügen");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[]]);
      await page.waitForFunction(() => document.activeElement?.id === "attach");
    } finally {
      await close();
    }
  }, 30_000);

  test("a provider's own source opens where the person was and previews a PDF's page, an image, or the icon; Add reuses the read", async () => {
    catalogApps = [drive, scans];
    serverPlace = scanPlace("buero", "ablage");
    placeWrites.length = 0;
    reads.clear();
    const { page, close } = await open(desktop);
    try {
      await attach(page, false, true);
      await row(page, "scan.pdf").waitFor();
      expect(await sourceNames(page)).toEqual(["This device", "Drive", "Scanner"]);
      expect(await page.locator('dialog .cloud-file-dialog__source[aria-current="true"] i').getAttribute("class")).toBe("ti ti-scan");
      expect(await page.locator(".cloud-file-chooser__crumbs li").allTextContents()).toEqual(["Scanner", "/Büro", `/${longNames.ablage}`]);
      // The restored folder takes focus from This device, so the keyboard continues in the list.
      expect(await focusedRow(page)).toContain("Intern");
      // Nothing is read before the person uses the list.
      await page.waitForTimeout(400);
      expect(reads.size).toBe(0);
      expect(await page.locator(".cloud-file-preview__frame").getAttribute("data-state")).toBe("empty");
      const list = await boxIn(page, 'dialog [role="gridcell"]');

      await row(page, "photo.png").click();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('.cloud-file-preview__frame[data-state="image"] img');
        return Boolean(image?.complete && image.naturalWidth === 1);
      });
      expect(await page.locator(".cloud-file-preview__name").textContent()).toBe("photo.png");
      await row(page, "scan.pdf").click();
      // The PDF whose bytes proved it a PDF reaches the shared PdfViewer; drawing pages is PdfViewer's own test, since
      // this harness bundles no pdf.js engine.
      await page.locator('.cloud-file-preview__frame[data-state="pdf"] .k2b-pdf-viewer').waitFor();
      await row(page, "memo.txt").click();
      await page.locator('.cloud-file-preview__frame[data-state="icon"]').waitFor();
      // Previews never move the list or the footer.
      expect(await boxIn(page, 'dialog [role="gridcell"]')).toEqual(list);
      await page.waitForTimeout(400);
      expect(Object.fromEntries(reads)).toEqual({ "scans:photo": 1, "scans:scan": 1 });

      await page.getByRole("button", { name: "Add (3)" }).click();
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      const [files] = (await chosen(page)) as { name: string; type: string }[][];
      expect(files!.map(({ name, type }) => [name, type])).toEqual([
        ["scan.pdf", "application/pdf"],
        ["photo.png", "image/png"],
        ["memo.txt", "text/plain"],
      ]);
      // The previewed files were not read a second time.
      expect(Object.fromEntries(reads)).toEqual({ "scans:photo": 1, "scans:scan": 1, "scans:memo": 1 });
      // The chooser closed where it opened, so nothing new is remembered.
      expect(placeWrites).toEqual([]);
    } finally {
      serverPlace = null;
      await close();
    }
  }, 60_000);

  test("a previewed file that grew since it was listed is read again within the choice's total limit", async () => {
    catalogApps = [scans];
    serverPlace = scanPlace("buero", "ablage");
    const listed = trees.scans!.ablage!;
    // Listed at 10 bytes, the stored image has grown to its real size since.
    trees.scans!.ablage = listed.map((entry) => (entry.id === "photo" ? { ...entry, size: 10 } : entry));
    reads.clear();
    const { page, close } = await open(desktop, `?maxTotal=${onePixelPng.length + 5}`);
    try {
      await attach(page, false, true);
      await row(page, "photo.png").click();
      await page.locator('.cloud-file-preview__frame[data-state="image"] img').waitFor();
      await page.getByRole("button", { name: "Add (1)" }).click();
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      // The preview's bytes did not stand in for the listed size: Add read the file again and took it within budget.
      expect(reads.get("scans:photo")).toBe(2);
      expect(((await chosen(page)) as { name: string }[][])[0]!.map((file) => file.name)).toEqual(["photo.png"]);
    } finally {
      trees.scans!.ablage = listed;
      serverPlace = null;
      await close();
    }
  }, 60_000);

  test("a deep path stays on one line and scrolls to its end under a fade; the search finds files in subfolders with their place", async () => {
    catalogApps = [scans];
    for (const view of [desktop, phone]) {
      serverPlace = scanPlace("buero", "ablage", "intern", "info", "schilder");
      reads.clear();
      const { page, close } = await open(view);
      try {
        await attach(page, false, true);
        await row(page, "Hinweis Eingang.pdf").waitFor();
        await settled(page);
        const path = await page.locator(".cloud-file-chooser__crumbs ol").evaluate((list) => {
          const last = list.lastElementChild!.getBoundingClientRect();
          const box = list.getBoundingClientRect();
          return {
            overflows: list.scrollWidth > list.clientWidth,
            atEnd: Math.abs(list.scrollWidth - list.clientWidth - list.scrollLeft) <= 1,
            fade: list.getAttribute("data-scroll-fade"),
            lastInside: last.right <= box.right + 0.5,
            fitsRow: box.height <= 36,
          };
        });
        expect(path).toEqual({ overflows: true, atEnd: true, fade: "top", lastInside: true, fitsRow: true });
        // The levels above are blue text links; the current level is plain text. No Up arrow.
        expect(await page.locator('.cloud-file-chooser__crumbs [aria-current="location"]').textContent()).toBe(longNames.schilder);
        expect(await page.locator(".cloud-file-chooser__crumbs .k2b-button").first().getAttribute("data-variant")).toBe("link");
        expect(await page.locator('.cloud-file-chooser__toolbar [aria-label="Up"]').count()).toBe(0);
        // Scrolled back to the start, the fade moves to the end.
        await page.locator(".cloud-file-chooser__crumbs ol").evaluate((list) => {
          list.scrollLeft = 0;
        });
        await page.waitForFunction(
          () => document.querySelector(".cloud-file-chooser__crumbs ol")?.getAttribute("data-scroll-fade") === "bottom",
        );

        await page.locator(".cloud-file-chooser__crumbs").getByRole("button", { name: longNames.ablage }).click();
        await row(page, "scan.pdf").waitFor();
        if (view === phone) {
          // A phone shows no preview column and reads nothing for it.
          expect(await page.locator(".cloud-file-dialog__aside").count()).toBe(0);
          await row(page, "scan.pdf").click();
          await page.waitForTimeout(500);
          expect(reads.size).toBe(0);
          await page.getByRole("button", { name: "Search here and in subfolders" }).click();
        }
        await page.getByRole("searchbox", { name: "Search here and in subfolders" }).fill("hinweis");
        await row(page, "Hinweis Eingang.pdf").waitFor();
        expect(queries.at(-1)).toMatchObject({ parent: "ablage", query: "hinweis", scope: "tree" });
        expect(await page.locator('dialog [role="gridcell"]').first().textContent()).toContain(
          `Intern / ${longNames.info} / ${longNames.schilder}`,
        );
      } finally {
        serverPlace = null;
        await close();
      }
    }
  }, 60_000);

  test("by keyboard, the preview follows the focused row and a path link opens its folder, which the chooser remembers", async () => {
    catalogApps = [scans];
    serverPlace = scanPlace("buero", "ablage");
    placeWrites.length = 0;
    const { page, close } = await open(desktop);
    try {
      await attach(page, false, true);
      await row(page, "scan.pdf").waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('[role="gridcell"]'));
      await page.keyboard.press("ArrowDown");
      expect(await focusedRow(page)).toContain("scan.pdf");
      await page.locator('.cloud-file-preview__frame[data-state="pdf"] .k2b-pdf-viewer').waitFor();
      await page.keyboard.press("ArrowDown");
      await page.locator('.cloud-file-preview__frame[data-state="image"]').waitFor();
      await page.locator(".cloud-file-chooser__crumbs").getByRole("button", { name: "Büro" }).focus();
      await page.keyboard.press("Enter");
      await row(page, longNames.ablage).waitFor();
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.id === "attach");
      expect(placeWrites).toEqual([scanPlace("buero")]);
      // The same page opens there next time without asking the server again.
      await attach(page, false, true);
      await row(page, longNames.ablage).waitFor();
      expect(await page.locator(".cloud-file-chooser__crumbs li").allTextContents()).toEqual(["Scanner", "/Büro"]);
    } finally {
      serverPlace = null;
      await close();
    }
  }, 60_000);

  test("a visitor the catalog refuses gets the device's file dialog directly, with no error", async () => {
    catalogApps = [drive];
    catalogStatus = 401;
    const { page, close } = await open(desktop, "?single", true);
    try {
      const picker = page.waitForEvent("filechooser");
      await page.locator("#attach").click();
      const chooser = await picker;
      expect(await page.locator("dialog[open]").count()).toBe(0);
      await chooser.setFiles({ name: "local.txt", mimeType: "text/plain", buffer: Buffer.from("local") });
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[{ name: "local.txt", type: "text/plain", size: 5, text: "local" }]]);
    } finally {
      catalogStatus = 200;
      await close();
    }
  }, 30_000);
});

describe("choosing through a dropzone inside a dialog, as Notebooks does", () => {
  const dropzone = (page: Page) => page.locator("dialog[open] .k2b-dropzone");
  const openDropzone = async (page: Page) => {
    await page.locator("#attach").click();
    await dropzone(page).waitFor();
  };
  /** The chooser is the dialog's top level; the level that asked waits underneath and returns when it closes. */
  const chooserOpen = (page: Page) => page.locator("dialog[open] .cloud-file-chooser").isVisible();

  test("the chooser opens over the dialog, hands a provider file to the dropzone, and returns to the dialog", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, "?dropzone");
      try {
        await openDropzone(page);
        await dropzone(page).click();
        await page.waitForFunction(() => document.activeElement?.matches('dialog .cloud-file-dialog__source[aria-current="true"]'));
        await source(page, "Drive").click();
        await row(page, "Home").click();
        await row(page, "notes.txt").click();
        await page.getByRole("button", { name: "Add (1)", exact: true }).click();
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        expect(await chosen(page)).toEqual([[{ name: "notes.txt", type: "text/plain", size: 13, text: "meeting notes" }]]);
        // Only the chooser closed; the dialog that asked is back, and its dropzone has focus again.
        await dropzone(page).waitFor();
        expect(await chooserOpen(page)).toBe(false);
        await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-dropzone"));
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("the keyboard reaches the chooser through the dropzone, Escape returns focus, and an empty catalog still offers this device", async () => {
    catalogApps = [drive];
    const withProviders = await open(desktop, "?dropzone");
    try {
      const { page } = withProviders;
      await openDropzone(page);
      // The zone is the dialog's only file control: no native input takes the first focus or a key press past the chooser.
      await page.waitForFunction(() => document.activeElement?.closest("dialog[open]"));
      expect(await page.locator('dialog[open] input[type="file"]').count()).toBe(0);
      const zoneFocused = () => page.evaluate(() => Boolean(document.activeElement?.classList.contains("k2b-dropzone")));
      for (let presses = 0; presses < 3 && !(await zoneFocused()); presses++) await page.keyboard.press("Tab");
      expect(await zoneFocused()).toBe(true);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.activeElement?.matches('dialog .cloud-file-dialog__source[aria-current="true"]'));
      await page.keyboard.press("Escape");
      await dropzone(page).waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-dropzone"));
      // A cancelled choice hands nothing to the dropzone.
      expect(await chosen(page)).toEqual([]);
    } finally {
      await withProviders.close();
    }

    catalogApps = [notes];
    const withoutProviders = await open(desktop, "?dropzone");
    try {
      const { page } = withoutProviders;
      await openDropzone(page);
      await dropzone(page).click();
      await source(page, "This device").waitFor();
      const picker = page.waitForEvent("filechooser");
      await source(page, "This device").click();
      const chooser = await picker;
      await chooser.setFiles({ name: "local.txt", mimeType: "text/plain", buffer: Buffer.from("local") });
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[{ name: "local.txt", type: "text/plain", size: 5, text: "local" }]]);
      expect(await dropzone(page).isVisible()).toBe(true);
    } finally {
      await withoutProviders.close();
    }
  }, 60_000);
});
