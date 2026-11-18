import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import type { CodeRunEntries } from "../../code/run-ledger";
import { RUN_LEDGER_NOW, runLedgerFixture, runLedgerOutput } from "./run-ledger.fixture";

let browser: Browser;
let origin: string;
let server: ReturnType<typeof Bun.serve> | undefined;
const scripts = new Map<string, string>();
const fonts = new Map<string, ArrayBuffer>();
let css: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "CodeRunLog.browser-harness.tsx")], target: "browser", format: "esm", splitting: true, minify: true, conditions: ["browser"], plugins: [{
    name: "solid-run-ledger", setup(builder) {
      builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        const result = await transformAsync(await Bun.file(path).text(), { filename: path, babelrc: false, configFile: false, presets: [typescript, [solid, { generate: "dom", hydratable: false }]] });
        return { contents: result.code, loader: "js" };
      });
    },
  }] });
  if (!build.success) throw new AggregateError(build.logs, "Run ledger harness build failed");
  for (const output of build.outputs) scripts.set(`/${basename(output.path)}`, await output.text());
  const entry = build.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("Missing run ledger harness");
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Run ledger styles build failed");
  const iconPath = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  let icons = await Bun.file(iconPath).text();
  const iconFont = icons.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!iconFont) throw new Error("Missing icon font");
  fonts.set("/__icons.woff2", await Bun.file(resolve(dirname(iconPath), iconFont)).arrayBuffer());
  icons = icons.replace(/url\([^)]+\)/, 'url("/__icons.woff2")');
  const plexPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  const plex = await Bun.file(plexPath).text();
  for (const file of new Set(plex.match(/\.\/fonts\/[^)"']+\.woff2/g) ?? [])) fonts.set(file.slice(1), await Bun.file(resolve(dirname(plexPath), file)).arrayBuffer());
  css = `${plex}\n${await styles.outputs[0]!.text()}\n${icons}`;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__ledger.css") return new Response(css, { headers: { "content-type": "text/css" } });
    const script = scripts.get(url.pathname);
    if (script !== undefined) return new Response(script, { headers: { "content-type": "text/javascript" } });
    const font = fonts.get(url.pathname);
    if (font) return new Response(font, { headers: { "content-type": "font/woff2" } });
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    return new Response(`<!doctype html><html lang="de" data-theme="${theme}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/__ledger.css"><script type="module" src="/${basename(entry.path)}"></script></head><body class="k2b-ui"><main id="root" style="padding:24px 16px;max-width:1440px;margin:auto"></main></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => { try { await browser?.close(); } finally { server?.stop(true); } });

const bounds = async (page: Page) => {
  await settled(page);
  return page.locator(".k2b-run-log").evaluate((node) => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; });
};
async function shot(page: Page, state: string, theme: string, width: number) {
  if (!process.env.CODE_RUN_LEDGER_SHOTS) return;
  mkdirSync(process.env.CODE_RUN_LEDGER_SHOTS, { recursive: true });
  await settled(page);
  await page.screenshot({ path: resolve(process.env.CODE_RUN_LEDGER_SHOTS, `lauf-${state}-${theme}-${width}.png`) });
}
for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
  test(`${theme} ${width}: v13 run detail, live step, failure and recovery keep the same bounds`, async () => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 780 : 900 }, reducedMotion: "reduce", colorScheme: theme });
    const page = await context.newPage();
    const errors = pageErrors(page);
    const data = runLedgerFixture();
    if (data.state.kind !== "ready" || !data.state.run) throw new Error("Missing run fixture");
    const run = data.state.run.run;
    let snapshot: CodeRunEntries = { state: "running", outcome: null, startedAt: run.startedAt, endedAt: null, output: runLedgerOutput() };
    let reads = 0;
    const live: { event?: (data: unknown) => void; revoke?: () => void; unavailable?: () => void } = {};
    await page.addInitScript((at) => { const RealDate = Date; globalThis.Date = new Proxy(RealDate, { construct: (target, args) => Reflect.construct(target, args.length ? args : [at]), get: (target, key, receiver) => key === "now" ? () => at : Reflect.get(target, key, receiver) }); }, Date.parse(RUN_LEDGER_NOW));
    await page.route("**/api/capabilities/v1/queries/**", async (route) => { reads++; await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: snapshot }) }); });
    await page.routeWebSocket("**/api/ai/live*", (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.t !== "sub") return;
        socket.send(JSON.stringify({ t: "ready", id: message.id, cursor: "0" }));
        live.event = (data) => socket.send(JSON.stringify({ t: "event", id: message.id, cursor: "1", data }));
        live.unavailable = () => socket.close({ code: 1008, reason: "fixture_unavailable" });
        live.revoke = () => socket.send(JSON.stringify({ t: "revoked", id: message.id, code: "access_denied" }));
      });
    });
    try {
      await page.goto(`${origin}/?theme=${theme}`);
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.getByText("14 Positionen erkannt", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.body.textContent?.includes("Verbindung wird hergestellt"));
      expect(reads).toBe(1);
      expect(await page.locator(".k2b-run-log__output-toggle").getAttribute("aria-expanded")).toBe("true");
      const before = await bounds(page);
      await shot(page, "laeuft", theme, width);
      const finishedStep = runLedgerOutput(true).entries.find((entry) => entry.kind === "step" && entry.id === "1:step:2");
      if (!live.event || !finishedStep) throw new Error("Missing live fixture");
      live.event({ type: "code.output", runId: run.id, generation: 1, seq: 2, entries: [finishedStep], droppedLines: 0, droppedBytes: 0, budget: 32768 });
      await page.locator('.k2b-run-log__step[data-status="failed"]').waitFor();
      expect(reads).toBe(1);
      snapshot = { ...snapshot, state: "failed", outcome: "lease_lost", endedAt: RUN_LEDGER_NOW, output: runLedgerOutput(true) };
      live.event({ type: "code.run", runId: run.id, state: "failed", at: RUN_LEDGER_NOW });
      await page.locator('.k2b-run-log[data-state="failed"]').waitFor();
      expect(reads).toBe(2);
      expect(await bounds(page)).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: /^Ausgabe/ }).focus();
      await page.keyboard.press("Enter");
      expect(await page.locator(".k2b-run-log__output-toggle").getAttribute("aria-expanded")).toBe("false");
      live.event({ type: "code.output", runId: run.id, generation: 1, seq: 3, entries: [], droppedLines: 0, droppedBytes: 0, budget: 32768 });
      await settled(page);
      expect(await page.locator(".k2b-run-log__output-toggle").getAttribute("aria-expanded")).toBe("false");
      if (width === 390 && theme === "light") {
        const folded = await bounds(page);
        if (!live.unavailable) throw new Error("Missing unavailable fixture");
        live.unavailable();
        await page.getByText(/Updates angehalten/, { exact: false }).waitFor();
        expect(await bounds(page)).toEqual(folded);
        await shot(page, "updates-angehalten", theme, width);
        await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
        await page.waitForFunction(() => !document.body.textContent?.includes("Verbindung wird hergestellt"));
      }
      if (!live.revoke) throw new Error("Missing revoke fixture");
      live.revoke();
      await page.getByText("Zugriff geändert. Lade die Seite neu, um deinen Zugriff zu prüfen.", { exact: false }).waitFor();
      expect(await page.getByText("14 Positionen erkannt", { exact: true }).count()).toBe(0);
      if (width === 390 && theme === "light") {
        await page.goto(`${origin}/?theme=${theme}&failed=1`);
        await page.getByText("Lieferschein #4711", { exact: true }).waitFor();
        await shot(page, "kopf-aktionen", theme, width);
        expect(await page.locator(".k2b-run-log__actions").count()).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.goto(`${origin}/?theme=${theme}&failed=1&reader=1`);
        await page.getByText("Nur wer diesen Code verwaltet, sieht seine Ausgabe.", { exact: false }).waitFor();
        expect(await page.getByText("14 Positionen erkannt", { exact: true }).count()).toBe(0);
        await shot(page, "leser", theme, width);
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
