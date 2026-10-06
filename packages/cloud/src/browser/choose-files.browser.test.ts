import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { launchBrowser } from "../../../ui/test/browser";
import { compileCapabilityManifest } from "../capabilities/testing";
import { type CapabilityInvocationResult, type CapabilityQueryDefinition, defineCapabilities } from "../contracts/capabilities";
import {
  type FileProviderEntry,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
} from "../contracts/file-provider";

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
const contents: Record<string, Record<string, string>> = {
  drive: { notes: "meeting notes", todo: "buy milk", plan: "plan b" },
  vault: { notes: "vault notes" },
};
const trees: Record<string, Record<string, FileProviderEntry[]>> = {
  drive: {
    "": [folder("home", "Home"), folder("team", "Team"), folder("broken", "Broken")],
    home: [
      folder("reports", "Reports"),
      file("notes", "notes.txt", contents.drive!.notes!, { tags: [{ label: "Draft", tone: "warning" }] }),
      file("todo", "todo.txt", contents.drive!.todo!),
      file("plan", "plan.txt", contents.drive!.plan!),
      file("huge", "huge.zip", "", { size: 5000, mediaType: "application/zip" }),
    ],
    reports: [],
  },
  vault: { "": [file("notes", "notes.txt", contents.vault!.notes!)] },
};

let catalogApps: unknown[] = [];
let catalogRequests = 0;
let catalogGate: Promise<void> | undefined;
let brokenAnswers = 0;
let readGate: Promise<void> | undefined;
/** The one stream the gate holds, as `app:id`; without it the gate holds every read. */
let gatedRead: string | undefined;
let openReads = 0;
let peakReads = 0;
const queries: Record<string, unknown>[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status });

const answer = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/capabilities/v1/catalog") {
    catalogRequests++;
    await catalogGate;
    return json({ protocolVersion: 2, apps: catalogApps, page: { hasMore: false } });
  }
  const [, app = "", operation] = /^\/api\/capabilities\/v1\/queries\/(\w+)\/([\w.]+)$/.exec(url.pathname) ?? [];
  if (operation === "folder.list") {
    const { input } = (await request.json()) as { input: { parent?: string; query?: string } };
    queries.push(input);
    if (input.parent === "team") return json({ code: "FORBIDDEN", message: "No access" }, 403);
    if (input.parent === "broken" && brokenAnswers++ === 0) return json({ code: "APP_UNAVAILABLE", message: "Down" }, 503);
    const items = (trees[app]?.[input.parent ?? ""] ?? []).filter((entry) => !input.query || entry.name.includes(input.query));
    return json({ data: { writable: false, items, next: null } });
  }
  if (operation === "file.read") {
    const { input } = (await request.json()) as { input: { id: string } };
    const content = contents[app]?.[input.id] ?? "";
    return json({
      data: {},
      stream: {
        id: `${app}:${input.id}`,
        direction: "read",
        mediaType: "text/plain",
        size: content.length,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }
  if (url.pathname === "/api/capabilities/v1/streams/read") {
    const stream = request.headers.get("x-cloud-stream-id") ?? "";
    const [app = "", id = ""] = stream.split(":");
    openReads++;
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
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

/** Opens the harness once the idle provider discovery has answered, like a click some time after the page loaded. */
const open = async (view: View, query = "") => {
  const before = catalogRequests;
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
  for (let attempt = 0; catalogRequests === before && attempt < 100; attempt++) await Bun.sleep(20);
  await page.waitForTimeout(50);
  return { page, context, close: () => context.close() };
};
const chosen = (page: Page) => page.evaluate(() => (window as unknown as { chosen: unknown[] }).chosen);
const dialogBox = (page: Page) =>
  page.locator("dialog[open]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  });
const rows = (page: Page) => page.locator('dialog [role="gridcell"]');
const rowNames = (page: Page) => page.locator('dialog [role="gridcell"] .k2b-file-grid__name').allTextContents();
const row = (page: Page, name: string) => page.locator("dialog .k2b-file-grid__name").getByText(name, { exact: true });
/** The text of the focused row, or null when focus is anywhere else. */
const focusedRow = (page: Page) =>
  page.evaluate(() => (document.activeElement?.matches('[role="gridcell"]') ? document.activeElement.textContent : null));
const attach = async (page: Page) => {
  await page.locator("#attach").click();
  await page.locator("dialog[open]").waitFor();
  // The chooser moves focus to its first row once it opened; a key pressed before that would reach the page.
  await page.waitForFunction(() => document.activeElement?.matches('dialog [role="gridcell"]'));
};
const status = (page: Page) => page.locator(".cloud-file-chooser__status").textContent();
/** Where the footer buttons are; selecting and adding must not move them. */
const footer = (page: Page) =>
  page.locator(".cloud-file-chooser__actions button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return [button.textContent, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)];
    }),
  );

describe("choosing files in a browser", () => {
  test("without providers, Attach opens the device's file dialog directly", async () => {
    catalogApps = [notes];
    const { page, close } = await open(desktop, "?single");
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

  test("without providers, an abort while the device's dialog is open resolves nothing and drops a later pick", async () => {
    catalogApps = [notes];
    const { page, close } = await open(desktop);
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

  test("with providers, This device comes first and still opens the device's file dialog", async () => {
    catalogApps = [notes, drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view);
      try {
        await attach(page);
        expect(await rowNames(page)).toEqual(["This device", "Drive"]);
        // Focus starts on the first source, so Enter is the same activation as a click.
        expect(await focusedRow(page)).toContain("This device");
        const box = await dialogBox(page);
        if (view === phone) expect(box).toEqual([0, 0, phone.width, phone.height]);
        const picker = page.waitForEvent("filechooser");
        await page.keyboard.press("Enter");
        const chooser = await picker;
        expect(chooser.isMultiple()).toBe(true);
        await chooser.setFiles([{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        expect(await page.locator("dialog[open]").count()).toBe(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("sources keep no selection, so one Escape closes the chooser after This device or the arrow keys", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      const picker = page.waitForEvent("filechooser");
      await row(page, "This device").click();
      await picker;
      expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await page.locator("dialog[open]").count()).toBe(0);

      await attach(page);
      await page.keyboard.press("ArrowDown");
      expect(await focusedRow(page)).toContain("Drive");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 2);
      expect(await chosen(page)).toEqual([[], []]);
    } finally {
      await close();
    }
  }, 30_000);

  test("a double-click on a source opens it once, even when its folder answers between the two clicks", async () => {
    catalogApps = [drive];
    const { page, close } = await open(desktop);
    try {
      await attach(page);
      const box = (await row(page, "Drive").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await row(page, "Team").waitFor();
      // The second click of the same double-click lands on "Team", which now sits where "Drive" was.
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await page.waitForTimeout(150);
      expect(await rowNames(page)).toEqual(["Home", "Team", "Broken"]);
    } finally {
      await close();
    }
  }, 30_000);

  test("providers that answer after the click join below This device without moving it or taking focus", async () => {
    catalogApps = [drive];
    let release!: () => void;
    catalogGate = new Promise((resolve) => {
      release = resolve;
    });
    const { page, close } = await open(phone);
    try {
      await attach(page);
      await page.getByText("Looking for apps with files…").waitFor();
      expect(await rowNames(page)).toEqual(["This device"]);
      const before = await rows(page).first().boundingBox();
      release();
      await row(page, "Drive").waitFor();
      expect(await rows(page).first().boundingBox()).toEqual(before);
      expect(await focusedRow(page)).toContain("This device");
    } finally {
      catalogGate = undefined;
      await close();
    }
  }, 30_000);

  test("browses a provider by keyboard, disables what does not fit, and reads at most two files at once", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, "?max=100");
      try {
        await attach(page);
        const sources = await dialogBox(page);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelectorAll('dialog [role="gridcell"]').length === 3);
        expect(await rowNames(page)).toEqual(["Home", "Team", "Broken"]);
        expect(await focusedRow(page)).toContain("Home");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelectorAll('dialog [role="gridcell"]').length === 5);
        expect(await rowNames(page)).toEqual(["Reports", "notes.txt", "todo.txt", "plan.txt", "huge.zip"]);
        const huge = rows(page).nth(4);
        expect(await huge.getAttribute("aria-disabled")).toBe("true");
        expect(await huge.textContent()).toContain("Too large, up to 100 B");
        expect(await rows(page).nth(1).textContent()).toContain("Draft");
        const buttons = await footer(page);

        // Arrows move focus only; Space and a tap toggle.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        await rows(page).nth(3).click();
        expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(3);
        expect(await dialogBox(page)).toEqual(sources);
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
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.locator(".cloud-file-chooser__downloads").waitFor();
        expect(await dialogBox(page)).toEqual(sources);
        expect(await footer(page)).toEqual(buttons);
        for (let attempt = 0; openReads < 2 && attempt < 100; attempt++) await Bun.sleep(10);
        await Bun.sleep(100);
        expect(peakReads).toBe(2);
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
        expect(peakReads).toBe(2);
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
      await row(page, "Drive").click();
      await row(page, "Home").click();
      await row(page, "notes.txt").click();
      await row(page, "todo.txt").click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.locator(".cloud-file-chooser__status").getByText("1 of 2 ready").waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
      await row(page, "notes.txt").waitFor();
      expect(await page.locator('dialog [aria-selected="true"]').count()).toBe(2);

      await page.getByRole("button", { name: "Sources" }).click();
      await row(page, "Vault").click();
      await row(page, "notes.txt").click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[{ name: "notes.txt", type: "text/plain", size: 11, text: "vault notes" }]]);
    } finally {
      release();
      readGate = undefined;
      gatedRead = undefined;
      await close();
    }
  }, 30_000);

  test("maxBytes bounds the whole choice: files that fit alone cannot be added together above it", async () => {
    catalogApps = [drive];
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, "?max=20");
      try {
        await attach(page);
        await row(page, "Drive").click();
        await row(page, "Home").click();
        const add = page.getByRole("button", { name: "Add", exact: true });
        await row(page, "notes.txt").click();
        await row(page, "todo.txt").click();
        expect(await status(page)).toBe("Too large together, up to 20 B");
        expect(await page.locator(".cloud-file-chooser__status").isVisible()).toBe(true);
        expect(await add.isDisabled()).toBe(true);
        await row(page, "todo.txt").click();
        await row(page, "plan.txt").click();
        expect(await status(page)).toBe("2 files selected");
        await add.click();
        await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
        expect((await chosen(page))[0]).toMatchObject([{ name: "notes.txt" }, { name: "plan.txt" }]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("explains empty, filtered, forbidden, unavailable, and offline folders in one unmoving frame", async () => {
    catalogApps = [drive];
    brokenAnswers = 0;
    const { page, context, close } = await open(desktop);
    try {
      await attach(page);
      const frame = await dialogBox(page);
      await rows(page).nth(1).click();
      await row(page, "Team").waitFor();
      await rows(page).nth(0).click();
      await row(page, "Reports").waitFor();

      await page.getByRole("searchbox", { name: "Filter by name" }).fill("zzz");
      await page.getByText("Nothing matches “zzz”").waitFor();
      expect(queries.at(-1)).toEqual({ parent: "home", query: "zzz", limit: 50 });
      expect(await dialogBox(page)).toEqual(frame);
      await page.getByRole("button", { name: "Clear filter" }).click();
      await row(page, "notes.txt").waitFor();

      await rows(page).nth(0).click();
      await page.getByText("This folder is empty").waitFor();
      expect(await dialogBox(page)).toEqual(frame);

      await page.getByRole("button", { name: "Drive" }).click();
      await row(page, "Team").waitFor();
      await rows(page).nth(1).click();
      await page.getByText("You no longer have access to this folder").waitFor();
      expect(await dialogBox(page)).toEqual(frame);
      await page.locator("dialog .k2b-placeholder").getByRole("button", { name: "Up" }).click();
      await row(page, "Broken").waitFor();

      await rows(page).nth(2).click();
      await page.getByText("Drive is not available right now").waitFor();
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByText("This folder is empty").waitFor();

      await page.getByRole("button", { name: "Drive" }).click();
      await row(page, "Home").waitFor();
      await context.setOffline(true);
      await rows(page).nth(0).click();
      await page.getByText("You are offline").waitFor();
      expect(await dialogBox(page)).toEqual(frame);
      await context.setOffline(false);
      await page.getByRole("button", { name: "Try again" }).click();
      await row(page, "notes.txt").waitFor();
    } finally {
      await close();
    }
  }, 60_000);

  test("Escape closes the chooser with nothing chosen and returns focus to Attach, in German too", async () => {
    catalogApps = [drive];
    const { page, close } = await open(phone, "?lang=de");
    try {
      await attach(page);
      expect(await rowNames(page)).toEqual(["Dieses Gerät", "Drive"]);
      expect(await page.locator("dialog h2").textContent()).toBe("Dateien hinzufügen");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (window as unknown as { chosen: unknown[] }).chosen.length === 1);
      expect(await chosen(page)).toEqual([[]]);
      await page.waitForFunction(() => document.activeElement?.id === "attach");
    } finally {
      await close();
    }
  }, 30_000);
});
