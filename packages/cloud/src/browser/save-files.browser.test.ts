import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { launchBrowser } from "../../../ui/test/browser";
import { compileCapabilityManifest } from "../capabilities/testing";
import {
  type CapabilityActionDefinition,
  type CapabilityInvocationResult,
  type CapabilityQueryDefinition,
  defineCapabilities,
} from "../contracts/capabilities";
import {
  type FileProviderEntry,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
  FileProviderSaveDataSchema,
  FileProviderSaveInputSchema,
} from "../contracts/file-provider";

// Upload progress, focus, full-screen geometry, and whether a state change moves the frame depend on a real engine,
// so this runs the real save dialog in a browser against an invented provider.
const ui = resolve(import.meta.dir, "../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "save-files.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-saver-test",
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
  if (!build.success) throw new AggregateError(build.logs, "File saver harness build failed");
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
const saveAction: CapabilityActionDefinition = {
  title: "Save",
  description: "Save one new file.",
  input: FileProviderSaveInputSchema,
  data: FileProviderSaveDataSchema,
  openWorld: false,
  destructive: false,
  idempotency: "required",
  stream: {
    direction: "write",
    maxBytes: 1024,
    write: async () => ({ data: {} }),
    status: async () => ({ state: "open" }),
    abort: async () => undefined,
  },
  run,
};
const providerApp = (appId: string, appName: string, save: boolean) => ({
  appId,
  appName,
  appIcon: "ti ti-cloud",
  appDescription: "Files",
  manifest: compileCapabilityManifest(
    appId,
    defineCapabilities({
      protocolVersion: 2,
      queries: { "folder.list": listQuery, "file.read": readQuery },
      ...(save ? { actions: { "file.save": saveAction } } : {}),
      fileProvider: { list: "folder.list", read: "file.read", ...(save ? { save: "file.save" } : {}) },
    }),
  ),
});
const drive = providerApp("drive", "Drive", true);
const archive = providerApp("archive", "Archive", false);

const folder = (id: string, name: string): FileProviderEntry => ({ kind: "folder", id, name });
const file = (id: string, name: string): FileProviderEntry => ({ kind: "file", id, name, size: 3, updatedAt: "2026-10-01T10:00:00Z" });
const tree: Record<string, { writable: boolean; items: FileProviderEntry[] }> = {
  "": { writable: false, items: [folder("home", "Home"), folder("team", "Team")] },
  home: { writable: true, items: [folder("docs", "Docs"), file("taken", "report.pdf")] },
  docs: { writable: true, items: [] },
  team: { writable: false, items: [file("plan", "plan.txt")] },
};
const sources: Record<string, string> = { "report.pdf": "%PDF-report", "notes.txt": "meeting notes", "huge.zip": "" };

let catalogApps: unknown[] = [];
/** Paths of the files the provider stores, with their bytes. */
const stored = new Map<string, string>();
const saveCalls: { input: Record<string, unknown>; key: string | null }[] = [];
const streamCalls: string[] = [];
let sourceReads = 0;
let writeGate: Promise<void> | undefined;
const json = (body: unknown, status = 200) => Response.json(body, { status });

const answer = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/capabilities/v1/catalog") return json({ protocolVersion: 2, apps: catalogApps, page: { hasMore: false } });
  if (url.pathname === "/api/capabilities/v1/queries/drive/folder.list") {
    const { input } = (await request.json()) as { input: { parent?: string; query?: string } };
    const page = tree[input.parent ?? ""] ?? { writable: false, items: [] };
    return json({ data: { ...page, items: page.items.filter((entry) => !input.query || entry.name.includes(input.query)), next: null } });
  }
  if (url.pathname === "/api/capabilities/v1/actions/drive/file.save") {
    const { input } = (await request.json()) as { input: { parent: string; name: string; mediaType: string; size: number } };
    saveCalls.push({ input, key: request.headers.get("idempotency-key") });
    const path = `${input.parent}/${input.name}`;
    const taken = stored.has(path) || (tree[input.parent]?.items ?? []).some((entry) => entry.name === input.name);
    if (taken) return json({ code: "FILE_NAME_CONFLICT", message: "Taken" }, 409);
    return json({
      data: {},
      stream: {
        id: path,
        direction: "write",
        name: input.name,
        mediaType: input.mediaType,
        size: input.size,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }
  if (url.pathname.startsWith("/api/capabilities/v1/streams/")) {
    const verb = url.pathname.split("/").at(-1)!;
    const path = request.headers.get("x-cloud-stream-id") ?? "";
    streamCalls.push(`${verb} ${path}`);
    if (verb !== "write") return json({ state: verb === "abort" ? "aborted" : "open" });
    const body = await request.text();
    await writeGate;
    stored.set(path, body);
    return json({
      data: { file: { id: path, name: path.split("/").at(-1), size: body.length } },
      links: [{ rel: "open", href: `/app/drive?path=${encodeURIComponent(path.split("/")[0]!)}` }],
    });
  }
  if (url.pathname.startsWith("/source/")) {
    sourceReads++;
    const name = decodeURIComponent(url.pathname.slice("/source/".length));
    return new Response(sources[name] ?? "", { headers: { "content-type": name.endsWith(".pdf") ? "application/pdf" : "text/plain" } });
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
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/source/")) return answer(request);
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const lang = url.searchParams.get("lang") ?? "en";
      return new Response(
        `<!doctype html><html lang="${lang}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui"><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const open = async (view: View, query = "") => {
  stored.clear();
  saveCalls.length = 0;
  streamCalls.length = 0;
  sourceReads = 0;
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/${query}`);
  // The idle discovery has answered once the shared button names the one app that stores files.
  await page.waitForFunction(() => document.querySelector("#icon button")?.getAttribute("aria-label")?.includes("Drive"));
  await page.waitForTimeout(50);
  return { page, close: () => context.close() };
};
const saved = (page: Page) => page.evaluate(() => (window as unknown as { saved: unknown[] }).saved);
const waitSaved = (page: Page, count: number) =>
  page.waitForFunction((count) => (window as unknown as { saved: unknown[] }).saved.length === count, count);
const dialogBox = (page: Page) =>
  page.locator("dialog[open]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  });
const row = (page: Page, name: string) => page.locator("dialog .k2b-file-grid__name").getByText(name, { exact: true });
const status = (page: Page) => page.locator(".cloud-file-chooser__status").textContent();
const footer = (page: Page) =>
  page.locator(".cloud-file-chooser__actions button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return [button.textContent, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)];
    }),
  );
const saveButton = (page: Page) => page.locator(".cloud-file-chooser__actions").getByRole("button", { name: "Save", exact: true });

describe("saving files into a provider in a browser", () => {
  test("one app opens straight into its folders, saves a downloaded attachment there, and links to it", async () => {
    catalogApps = [archive, drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view);
      try {
        expect(await page.locator("#icon button").getAttribute("aria-label")).toBe("Save report.pdf to Drive");
        await page.locator("#save").click();
        await row(page, "Home").waitFor();
        // Focus starts on the first folder once the app's root arrived, so the keyboard continues there.
        await page.waitForFunction(() => document.activeElement?.matches('dialog [role="gridcell"]'));
        expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Home");
        const frame = await dialogBox(page);
        if (view === phone) expect(frame).toEqual([0, 0, phone.width, phone.height]);
        // The read-only app is a place to choose from, never one to save into, so Drive is the only one and opens.
        expect(await page.locator("dialog .cloud-file-chooser__crumbs").textContent()).not.toContain("Sources");
        expect(await status(page)).toBe("Choose a folder");
        expect(await saveButton(page).isDisabled()).toBe(true);
        const buttons = await footer(page);

        await row(page, "Home").click();
        await row(page, "Docs").waitFor();
        expect(await status(page)).toBe("Saves to Home");
        expect(await page.locator('dialog [aria-disabled="true"]').textContent()).toContain("report.pdf");
        await row(page, "Docs").click();
        await page.getByText("This folder is empty").waitFor();
        expect(await dialogBox(page)).toEqual(frame);
        expect(await footer(page)).toEqual(buttons);
        expect(sourceReads).toBe(0);

        await saveButton(page).click();
        await waitSaved(page, 1);
        expect(await page.locator("dialog[open]").count()).toBe(0);
        expect(await saved(page)).toEqual([[{ name: "report.pdf", app: "Drive", href: "/app/drive?path=docs" }]]);
        expect(stored.get("docs/report.pdf")).toBe("%PDF-report");
        expect(saveCalls.map((call) => call.input)).toEqual([
          { parent: "docs", name: "report.pdf", mediaType: "application/pdf", size: 11 },
        ]);
        const toast = page.locator(".k2b-toast").filter({ hasText: "Saved report.pdf to Drive" });
        await toast.waitFor();
        expect(await toast.getByRole("link", { name: "Show in Drive" }).getAttribute("href")).toBe("/app/drive?path=docs");
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 90_000);

  test("a taken name asks for another, prefilled with the next number, and Enter saves it once", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await page.locator("#save").click();
      await row(page, "Home").click();
      await row(page, "Docs").waitFor();
      const frame = await dialogBox(page);
      await saveButton(page).click();
      const input = page.locator(".cloud-file-saver__rename input");
      await input.waitFor();
      expect(await input.inputValue()).toBe("report (2).pdf");
      await page.waitForFunction(() => document.activeElement?.closest(".cloud-file-saver__rename") !== null);
      expect(await status(page)).toBe("0 of 1 saved, 1 needs attention");
      expect(await dialogBox(page)).toEqual(frame);
      await page.keyboard.press("Enter");
      await waitSaved(page, 1);
      expect((await saved(page))[0]).toEqual([{ name: "report (2).pdf", app: "Drive", href: "/app/drive?path=home" }]);
      expect(stored.get("home/report (2).pdf")).toBe("%PDF-report");
      // The new name got its own key; the taken name never turned into a second file.
      expect(saveCalls.map((call) => call.input.name)).toEqual(["report.pdf", "report (2).pdf"]);
      expect(new Set(saveCalls.map((call) => call.key)).size).toBe(2);
    } finally {
      await close();
    }
  }, 30_000);

  test("saving all shows each file's progress; Cancel stops the write, aborts its stream, and returns focus", async () => {
    catalogApps = [drive];
    let release = () => {};
    writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const { page, close } = await open(phone);
    try {
      await page.locator("#save-all").click();
      expect(await page.locator("dialog h2").textContent()).toBe("Save 2 files");
      await row(page, "Home").click();
      await row(page, "Docs").click();
      await page.getByText("This folder is empty").waitFor();
      const frame = await dialogBox(page);
      // A double tap on Save starts one transfer: the button is disabled while it runs.
      await saveButton(page).dblclick();
      await page.locator(".cloud-file-chooser__downloads").waitFor();
      for (let attempt = 0; streamCalls.length < 2 && attempt < 100; attempt++) await Bun.sleep(10);
      expect(saveCalls).toHaveLength(2);
      expect(await page.locator('.cloud-file-chooser__downloads [role="progressbar"]').count()).toBe(2);
      expect(await dialogBox(page)).toEqual(frame);
      await page.getByRole("button", { name: "Cancel" }).click();
      await waitSaved(page, 1);
      expect(await saved(page)).toEqual([[]]);
      for (let attempt = 0; streamCalls.filter((call) => call.startsWith("abort")).length < 2 && attempt < 100; attempt++)
        await Bun.sleep(10);
      expect(streamCalls.filter((call) => call.startsWith("abort")).sort()).toEqual(["abort docs/notes.txt", "abort docs/report.pdf"]);
      await page.waitForFunction(() => document.activeElement?.id === "save-all");
    } finally {
      release();
      writeGate = undefined;
      await close();
    }
  }, 30_000);

  test("a taken name among several files keeps every row's height, and its new name waits for the running file", async () => {
    catalogApps = [drive];
    let release = () => {};
    writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const { page, close } = await open(desktop);
    try {
      await page.locator("#save-all").click();
      await row(page, "Home").click();
      await row(page, "Docs").waitFor();
      await saveButton(page).click();
      await page.locator(".cloud-file-saver__rename input").waitFor();
      // The taken name shows its field where the other file shows its progress, in rows of one height.
      const heights = await page
        .locator(".cloud-file-chooser__downloads > li")
        .evaluateAll((rows) => rows.map((element) => Math.round(element.getBoundingClientRect().height)));
      expect(heights).toHaveLength(2);
      expect(heights[0]).toBe(heights[1]);
      const rename = page.locator(".cloud-file-saver__rename button");
      expect(await rename.isDisabled()).toBe(true);
      release();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".cloud-file-saver__rename button")?.disabled);
      await page.locator(".cloud-file-saver__rename input").fill("a/b.pdf");
      await page.getByText("Use a name without / or \\").waitFor();
      expect(await rename.isDisabled()).toBe(true);
      await page.locator(".cloud-file-saver__rename input").fill("report-copy.pdf");
      await rename.click();
      await waitSaved(page, 1);
      expect((await saved(page))[0]).toEqual([
        { name: "notes.txt", app: "Drive", href: "/app/drive?path=home" },
        { name: "report-copy.pdf", app: "Drive", href: "/app/drive?path=home" },
      ]);
      await page.locator(".k2b-toast").filter({ hasText: "Saved 2 files to Drive" }).waitFor();
    } finally {
      release();
      writeGate = undefined;
      await close();
    }
  }, 30_000);

  test("a file above the app's limit is refused before it downloads, and Escape closes the dialog", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await page.locator("#save-big").click();
      await row(page, "Home").click();
      await row(page, "Docs").waitFor();
      await saveButton(page).click();
      await page.getByText("Too large, up to 1 KiB").waitFor();
      expect(sourceReads).toBe(0);
      expect(saveCalls).toHaveLength(0);
      await page.keyboard.press("Escape");
      await waitSaved(page, 1);
      expect(await saved(page)).toEqual([[]]);
    } finally {
      await close();
    }
  }, 30_000);

  test("a folder the person may only read keeps Save disabled, in German too", async () => {
    catalogApps = [drive];
    const { page, close } = await open(phone, "?lang=de");
    try {
      expect(await page.locator("#icon button").getAttribute("aria-label")).toBe("report.pdf in Drive speichern");
      await page.locator("#save").click();
      expect(await page.locator("dialog h2").textContent()).toBe("„report.pdf“ speichern");
      await row(page, "Team").click();
      await row(page, "plan.txt").waitFor();
      expect(await status(page)).toBe("In diesem Ordner kannst du nicht speichern");
      expect(await page.locator(".cloud-file-chooser__actions").getByRole("button", { name: "Speichern" }).isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      await waitSaved(page, 1);
    } finally {
      await close();
    }
  }, 30_000);
});
