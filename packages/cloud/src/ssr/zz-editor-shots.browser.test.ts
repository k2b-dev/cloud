// Throwaway: screenshots of the built app bar editor for the review artifact. Not committed.
import { test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const out = `${process.env.HOME}/.local/state/cloud-dev/app-leiste-anpassen-gebaut/shots`;
mkdirSync(out, { recursive: true });
const ui = resolve(import.meta.dir, "../../../ui");
const fonts = `${import.meta.dir}/../../../../node_modules/.bun/@tabler+icons-webfont@3.48.0/node_modules/@tabler/icons-webfont/dist`;
const iconCss = readFileSync(`${fonts}/tabler-icons.min.css`, "utf8").replace(
  /src:[^;}]*/,
  `src:url(data:font/woff2;base64,${readFileSync(`${fonts}/fonts/tabler-icons.woff2`).toString("base64")}) format("woff2")`,
);

const app = (id: string, label: string, icon: string, accent: string, defaultVisible = true) => ({
  id,
  label,
  href: `/app/${id}`,
  match: `/app/${id}`,
  iconClass: `ti ti-${icon}`,
  defaultVisible,
  accent,
});
const apps = [
  app("auftraege", "Aufträge", "clipboard-list", "#0891b2"),
  app("chat", "Chat", "messages", "#7c3aed"),
  app("dateien", "Dateien", "files", "#0284c7"),
  app("gustav", "Gustav", "sparkles", "#8e1b6f"),
  app("kontakte", "Kontakte", "address-book", "#e11d48"),
  app("lager", "Lager", "building-warehouse", "#d97706"),
  app("mail", "Mail", "mail", "#2563eb"),
  app("notizen", "Notizbücher", "notebook", "#ca8a04"),
  app("projekte", "Projekte", "briefcase", "#4f46e5"),
  app("rechnungen", "Rechnungen", "file-invoice", "#059669"),
  app("spaces", "Spaces", "layout-kanban", "#52525b"),
];
const full = {
  revision: 3,
  visibility: { spaces: false },
  showNames: true,
  shortcuts: [
    { id: "p1", kind: "app", appId: "projekte" },
    { id: "p2", kind: "app", appId: "lager" },
    { id: "p3", kind: "app", appId: "rechnungen" },
    { id: "p4", kind: "link", title: "Lieferantenbestellungen Süd", href: "/grids/t/lieferanten-sued", icon: "ti ti-truck-delivery" },
  ],
};
const managed = [
  { id: "m1", kind: "link", title: "Intranet", href: "https://intranet.werkstatt-nord.example", icon: "ti ti-world" },
  { id: "m2", kind: "app", appId: "auftraege" },
];

type Shot = { name: string; width: number; empty?: boolean; get?: "hang" | "fail"; put?: "fail"; act?: (page: Page) => Promise<void> };
const shots: Shot[] = [
  { name: "01-liste", width: 1440 },
  { name: "01-liste", width: 390 },
  { name: "02-leer", width: 1440, empty: true },
  { name: "02-leer", width: 390, empty: true },
  {
    name: "03-link-anlegen",
    width: 1440,
    act: async (page) => {
      await page.getByRole("button", { name: "Link hinzufügen" }).click();
      await page.locator(".rail-editor-link-form input").nth(0).fill("Wochenplan");
      await page.locator(".rail-editor-link-form input").nth(1).fill("intranet/wochenplan");
      await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
    },
  },
  {
    name: "04-speichern-fehlgeschlagen",
    width: 1440,
    put: "fail",
    act: async (page) => {
      await page.getByRole("button", { name: "Kontakte anheften" }).click();
      await page.locator(".rail-editor-failure").waitFor();
    },
  },
  {
    name: "04-speichern-fehlgeschlagen",
    width: 390,
    put: "fail",
    act: async (page) => {
      await page.getByRole("button", { name: "Kontakte anheften" }).click();
      await page.locator(".rail-editor-failure").waitFor();
    },
  },
  {
    name: "05-zurueckgesetzt",
    width: 1440,
    act: async (page) => {
      await page.getByRole("button", { name: "App-Leiste zurücksetzen" }).click();
      await page.getByRole("button", { name: "Rückgängig" }).waitFor();
    },
  },
  {
    name: "06-gespeichert",
    width: 1440,
    act: async (page) => {
      await page.getByRole("switch", { name: "Spaces in der App-Leiste zeigen" }).click();
      await page.locator('.rail-editor-state[data-state="saved"]').waitFor();
    },
  },
  { name: "07-laden", width: 1440, get: "hang" },
  { name: "08-ladefehler", width: 1440, get: "fail" },
];

test("editor shots", async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const entry = resolve(import.meta.dir, "zz-editor-shots.entry.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: `import { LocaleProvider } from "@k2b/ui"; import { openRailEditor } from "./RailEditor"; window.openEditor = () => openRailEditor("de");` },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "shots",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result!.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "build");
  const harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  const css = await styles.outputs[0]!.text();
  const browser = await launchBrowser();
  try {
    for (const shot of shots) {
      const phone = shot.width < 768;
      const context = await browser.newContext({
        viewport: { width: shot.width, height: phone ? 844 : 900 },
        hasTouch: phone,
        isMobile: phone,
        colorScheme: "light",
        locale: "de-DE",
      });
      const page = await context.newPage();
      let stored = shot.empty ? { revision: 1, visibility: {}, shortcuts: [], showNames: true } : full;
      const shell = { apps, rail: { ...stored, managedShortcuts: shot.empty ? [] : managed }, legalLinks: [], theme: "light", searchLinks: {} };
      const html =
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>${iconCss}</style></head>` +
        `<body class="k2b-ui" style="background:var(--ui-canvas)"><script id="cloud-shell-data" type="application/json">${JSON.stringify(shell)}</script></body></html>`;
      await page.route("http://localhost/**", async (route) => {
        const request = route.request();
        if (new URL(request.url()).pathname !== "/api/me/rail") return route.fulfill({ contentType: "text/html", body: html });
        if (request.method() === "GET") {
          if (shot.get === "hang") return;
          if (shot.get === "fail") return route.fulfill({ status: 503, body: "unavailable" });
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(stored) });
        }
        if (shot.put === "fail") return route.fulfill({ status: 503, body: "unavailable" });
        const body = request.postDataJSON();
        stored = { ...body, revision: stored.revision + 1 };
        await new Promise((done) => setTimeout(done, 150));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(stored) });
      });
      await page.goto("http://localhost/page");
      await page.addScriptTag({ content: harness });
      await page.evaluate(() => (window as unknown as { openEditor: () => void }).openEditor());
      await page.waitForTimeout(shot.get ? 400 : 700);
      if (shot.act) await shot.act(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${shot.name}-light-${shot.width}.png` });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}, 240_000);
