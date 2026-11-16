import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The server renders the list from the server's `now`; the browser's first render must show the same, even with a
// device in another time zone. The device clock stands at the same instant, so after mounting nothing may change.
const NOW = "2026-11-12T15:31:00Z";
const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-activity-hydration-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "activity-list-hydration.fixture.tsx");
const fixture = (entry: string) => `
import { ActivityCard, LocaleProvider } from ${JSON.stringify(entry)};
const draft = (minute) => ({
  at: "2026-10-27T10:" + minute + ":00+01:00", icon: "ti ti-pencil", text: "Entwurf geändert", actor: "Elif Kaya",
  bundle: { key: "draft", text: (count) => "Entwurf " + count + "-mal geändert" },
});
export function Fixture() {
  const entries = () => [
    { at: "2026-11-12T00:20:00+01:00", icon: "ti ti-mail-x", tone: "danger", iconLabel: "fehlgeschlagen", text: "Einladung unzustellbar",
      detail: "Postfach voll", action: { icon: "ti ti-send", label: "Erneut senden" } },
    { at: "2026-11-11T23:50:00+01:00", icon: "ti ti-check", text: "Aufgabe erledigt", href: "/app/spaces/s1", actor: "Mira Lang" },
    { at: "2026-11-10T14:05:00+01:00", icon: "ti ti-mail", text: "Per E-Mail gesendet", details: () => "Betreff" },
    draft("35"), draft("30"),
    { at: "2026-10-01T09:00:00+02:00", icon: "ti ti-plus", text: "Erstellt", actor: "Tom Reiter" },
  ];
  return <LocaleProvider locale="de">
    <ActivityCard entries={entries()} now=${JSON.stringify(NOW)} timeZone="Europe/Berlin" limit={4} />
  </LocaleProvider>;
}
`;
const compile = async (source: string, path: string, generate: "ssr" | "dom") => {
  const result = await transformAsync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    presets: [typescript, [solid, { generate, hydratable: true }]],
  });
  if (!result?.code) throw new Error(`Could not compile ${path} for ${generate}`);
  return result.code;
};
const serverEntry = resolve(import.meta.dir, "activity-list-hydration.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./activity-list-hydration.fixture";
export const render = () => renderToString(() => createComponent(Fixture, {}));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "activity-hydration-ssr",
      setup(builder) {
        builder.onResolve({ filter: /activity-list-hydration\.fixture$/ }, () => ({ path: fixturePath, namespace: "activity-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "activity-fixture" }, async ({ path }) => ({
          contents: await compile(fixture(resolve(ui, "src/index.ts")), path, "ssr"),
          loader: "js",
          resolveDir: import.meta.dir,
        }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => ({
          contents: await compile(await Bun.file(path).text(), path, "ssr"),
          loader: "js",
        }));
      },
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the activity SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: () => string; hydrationScript: string } = await import(modulePath);
const clientEntry = resolve(import.meta.dir, "activity-list-hydration.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./activity-list-hydration.fixture";
hydrate(() => createComponent(Fixture, {}), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "activity-hydration-dom",
      setup(builder) {
        builder.onResolve({ filter: /activity-list-hydration\.fixture$/ }, () => ({ path: fixturePath, namespace: "activity-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "activity-fixture" }, async ({ path }) => ({
          contents: await compile(fixture(resolve(ui, "dist/browser/index.js")), path, "dom"),
          loader: "js",
          resolveDir: import.meta.dir,
        }));
      },
    },
  ],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle the activity hydration fixture");
const script = await clientBuild.outputs[0]!.text();
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/client.js") {
        return new Response(script, { headers: { "Content-Type": "application/javascript" } });
      }
      return new Response(
        `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body class="k2b-ui" style="margin:24px"><div id="app">${render()}</div>${hydrationScript}</body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 30_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the first browser render shows the server's rows, times, and dividers in a device of another time zone", async () => {
  const context = await browser!.newContext({ viewport: { width: 720, height: 900 }, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
  // Only Date stands at the server's "now"; timers stay real.
  await context.addInitScript((now: number) => {
    const Real = Date;
    window.Date = new Proxy(Real, {
      construct: (target, args) => new target(...((args.length > 0 ? args : [now]) as [number])),
      get: (target, key) => (key === "now" ? () => now : Reflect.get(target, key)),
    });
  }, Date.parse(NOW));
  const page = await context.newPage();
  const errors: string[] = [];
  const hydrationMessages: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if ((message.type() === "error" || message.type() === "warning") && /hydrat/i.test(message.text())) hydrationMessages.push(message.text());
  });
  // Elements with their attributes and the text, without hydration keys and markers: what a person and a screen reader get.
  const markup = () =>
    page.locator("#app .k2b-activity").evaluate((root) => {
      const read = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (!(node instanceof Element)) return "";
        const attributes = Array.from(node.attributes)
          .filter((attribute) => attribute.name !== "data-hk")
          .map((attribute) => `${attribute.name}="${attribute.value}"`)
          .sort()
          .join(" ");
        return `<${node.localName} ${attributes}>${Array.from(node.childNodes).map(read).join("")}</${node.localName}>`;
      };
      return read(root);
    });
  try {
    await page.goto(origin);
    await settled(page);
    const server = await markup();
    // In Berlin 00:20 on 12 Nov is today, 23:50 on 11 Nov yesterday; in Los Angeles both would be 11 Nov.
    expect(server).toContain("Heute");
    expect(server).toContain("Gestern");
    await page.evaluate(() => Reflect.set(window, "serverRow", document.querySelector(".k2b-activity__entry")));
    await page.addScriptTag({ url: `${origin}/client.js` });
    await page.waitForSelector('body[data-ready="true"]');
    await settled(page);
    expect(await markup()).toBe(server);
    expect(await page.evaluate(() => Reflect.get(window, "serverRow") === document.querySelector(".k2b-activity__entry"))).toBe(true);
    expect(errors).toEqual([]);
    expect(hydrationMessages).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);
