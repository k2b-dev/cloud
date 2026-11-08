import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-field-suggestion-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "field-suggestion.fixture.tsx");
// An invoice read by an assistant (fictional data), in the states the concept's field scene shows.
const fixture = (entry: string) => `
import { batch, createSignal } from "solid-js";
import { DatePicker, LocaleProvider, NumberInput, Select, SuggestionGroup, Switch, TextInput } from ${JSON.stringify(entry)};
const read = { supplier: "berger", number: "RE-2026-4471", date: "2026-10-28", gross: 312.4, vat: "19", account: "3400", deduct: true, text: "Ankauf Biedermeier-Kommode, Lieferung 27.10." };
export function Fixture(props: { scenario: string }) {
  const [loading, setLoading] = createSignal(props.scenario === "loading");
  const [gone, setGone] = createSignal(false);
  const [accepted, setAccepted] = createSignal<string[]>(["supplier"]);
  const [supplier, setSupplier] = createSignal<string | null>("berger");
  const [number, setNumber] = createSignal("");
  const [date, setDate] = createSignal<string | null>(null);
  const [gross, setGross] = createSignal<number | null>(321.4);
  const [vat, setVat] = createSignal<string | null>(null);
  const [account, setAccount] = createSignal<string | null>(null);
  const [deduct, setDeduct] = createSignal(false);
  const [text, setText] = createSignal("");
  const setters: Record<string, (value: never) => void> = { supplier: setSupplier, number: setNumber, date: setDate, gross: setGross, vat: setVat, account: setAccount, deduct: setDeduct, text: setText };
  const accept = (id: string) => setAccepted((list) => (list.includes(id) ? list : [...list, id]));
  const suggest = (id: keyof typeof read, extra: Record<string, unknown> = {}) => () =>
    gone() ? undefined : loading() ? { id, state: "loading" as const } : { id, state: "ready" as const, value: read[id], confidence: "high" as const, accepted: accepted().includes(id), ...extra };
  const acceptAll = (ids: string[]) => {
    document.body.dataset.acceptAll = ids.join(",");
    batch(() => ids.forEach((id) => { setters[id](read[id as keyof typeof read] as never); accept(id); }));
  };
  return (
    <LocaleProvider locale="de">
      <form id="invoice" style="display:grid;gap:1rem;padding:1rem;max-width:52rem">
        <SuggestionGroup source="Gustav" title={loading() ? "Gustav liest RE-4471.pdf …" : "Gustav hat 8 Felder aus RE-4471.pdf gelesen"} onAcceptAll={acceptAll}>
          <div id="fields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1rem 1.5rem">
            <Select label="Lieferant" searchable value={supplier} onValueChange={setSupplier} options={[{ value: "berger", label: "Antikhandel Berger GmbH" }, { value: "lenz", label: "Möbel Lenz KG" }]} suggestion={suggest("supplier")} onSuggestionAccept={accept} />
            <TextInput label="Rechnungsnummer" name="number" value={number} onValueChange={setNumber} suggestion={suggest("number")} onSuggestionAccept={accept} disabled={props.scenario === "locked"} />
            <DatePicker label="Rechnungsdatum" value={date} onValueChange={setDate} dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }} suggestion={suggest("date")} onSuggestionAccept={accept} error={props.scenario === "locked" ? "Bitte ein Datum angeben." : undefined} />
            <NumberInput label="Betrag brutto" locale="de" step={0.01} suffix="€" value={gross} onValueChange={setGross} suggestion={suggest("gross")} onSuggestionAccept={accept} />
            <Select label="Umsatzsteuer" value={vat} onValueChange={setVat} options={[{ value: "19", label: "19 %" }, { value: "7", label: "7 %" }, { value: "0", label: "0 %" }]} suggestion={suggest("vat", { confidence: "low", reason: "Die Rechnung weist keine Umsatzsteuer aus." })} onSuggestionAccept={accept} />
            <Select label="Buchungskonto" value={account} onValueChange={setAccount} options={[{ value: "3400", label: "3400 Wareneingang 19 %" }, { value: "3300", label: "3300 Wareneingang 7 %" }]} suggestion={props.scenario === "locked" ? () => ({ id: "account", state: "error" as const, onRetry: () => {} }) : suggest("account")} onSuggestionAccept={accept} />
            <Switch label="Vorsteuer abziehen" value={deduct} onValueChange={setDeduct} suggestion={suggest("deduct")} onSuggestionAccept={accept} />
            <TextInput label="Buchungstext" multiline lines={2} value={text} onValueChange={setText} suggestion={suggest("text")} onSuggestionAccept={accept} readOnly={props.scenario === "locked"} />
          </div>
        </SuggestionGroup>
        <div style="display:flex;gap:.5rem">
          <button type="button" id="arrive" onClick={() => setLoading(false)}>Arrive</button>
          <button type="button" id="dismiss" onClick={() => setGone(true)}>Dismiss</button>
        </div>
      </form>
    </LocaleProvider>
  );
}
`;
const compile = async (path: string, source: string, generate: "ssr" | "dom") => {
  const result = await transformAsync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    presets: [typescript, [solid, { generate, hydratable: true }]],
  });
  if (!result?.code) throw new Error(`Could not compile ${path}`);
  return result.code;
};
const serverEntry = resolve(import.meta.dir, "field-suggestion.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./field-suggestion.fixture";
export const render = (scenario) => renderToString(() => createComponent(Fixture, { scenario }));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "field-suggestion-ssr",
      setup(builder) {
        builder.onResolve({ filter: /field-suggestion\.fixture$/ }, () => ({ path: fixturePath, namespace: "suggestion-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "suggestion-fixture" }, async ({ path }) => ({
          contents: await compile(path, fixture(resolve(ui, "src/index.ts")), "ssr"),
          loader: "js",
          resolveDir: import.meta.dir,
        }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => ({
          contents: await compile(path, await Bun.file(path).text(), "ssr"),
          loader: "js",
        }));
      },
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the field suggestion SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: (scenario: string) => string; hydrationScript: string } = await import(modulePath);
const clientEntry = resolve(import.meta.dir, "field-suggestion.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./field-suggestion.fixture";
hydrate(() => createComponent(Fixture, { scenario: document.body.dataset.scenario }), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "field-suggestion-dom",
      setup(builder) {
        builder.onResolve({ filter: /field-suggestion\.fixture$/ }, () => ({ path: fixturePath, namespace: "suggestion-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "suggestion-fixture" }, async ({ path }) => ({
          contents: await compile(path, fixture(resolve(ui, "dist/browser/index.js")), "dom"),
          loader: "js",
          resolveDir: import.meta.dir,
        }));
      },
    },
  ],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle the field suggestion client fixture");
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
      const url = new URL(request.url);
      if (url.pathname === "/client.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
      const scenario = url.searchParams.get("scenario") ?? "mixed";
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body class="k2b-ui" style="margin:0" data-scenario="${scenario}"><div id="app">${render(scenario)}</div>${hydrationScript}</body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
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

const boxes = (page: Page) =>
  page
    .locator(
      "#fields > *, .k2b-field__label-row, .k2b-input-shell, .k2b-choice-trigger, .k2b-switch__track, .k2b-ai-suggestion-group__bar, #arrive",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
const open = async (page: Page, scenario: string) => {
  const errors = pageErrors(page);
  page.on("console", (message) => {
    if ((message.type() === "error" || message.type() === "warning") && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(`${origin}?scenario=${scenario}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settled(page);
  const before = await boxes(page);
  await page.evaluate(() => Reflect.set(window, "serverField", document.querySelector("#fields > :nth-child(2)")));
  await page.addScriptTag({ url: `${origin}/client.js` });
  await page.waitForSelector('body[data-ready="true"]');
  await settled(page);
  // Hydration reuses the server's fields and moves nothing.
  expect(await page.evaluate(() => Reflect.get(window, "serverField") === document.querySelector("#fields > :nth-child(2)"))).toBe(true);
  expect(await boxes(page)).toEqual(before);
  return { before, errors };
};
const live = (page: Page) => page.locator('.k2b-sr-only[aria-live="polite"]').allTextContents();

describe("field suggestions in a browser", () => {
  for (const width of [1440, 390]) {
    test(`accepting, editing, and accepting all move nothing and never overwrite own values at ${width}px`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 1400 }, reducedMotion: "reduce" });
      try {
        const { before, errors } = await open(page, "mixed");
        const summary = page.locator(".k2b-ai-suggestion-group__summary");
        expect(await summary.textContent()).toContain("1 übernommen · 5 offen · 1 unsicher");
        expect(await page.locator(".k2b-ai-suggestion-group__accept").textContent()).toBe("Alle übernehmen (5)");

        // Keyboard: Accept is a normal button; after it the focus continues in the field.
        const number = page.getByRole("textbox", { name: "Rechnungsnummer" });
        expect(await number.inputValue()).toBe("");
        expect(await number.getAttribute("placeholder")).toBe("RE-2026-4471");
        await page.getByRole("button", { name: "Vorschlag für Rechnungsnummer übernehmen" }).focus();
        await page.keyboard.press("Enter");
        expect(await number.inputValue()).toBe("RE-2026-4471");
        expect(await number.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await live(page)).toContain("Rechnungsnummer übernommen: RE-2026-4471.");
        await settled(page);
        expect(await boxes(page)).toEqual(before);

        // Edited after accepting: the value is the person's; the suggestion waits in the status line.
        await number.fill("RE-2026-4470");
        expect(await page.locator(".k2b-field", { has: number }).locator(".k2b-ai-suggestion__text").textContent()).toBe(
          "Gustav: RE-2026-4471",
        );
        await settled(page);
        expect(await boxes(page)).toEqual(before);

        // Leaving an open field accepts nothing.
        const date = page.getByRole("combobox", { name: "Rechnungsdatum" });
        await date.focus();
        await page.keyboard.press("Tab");
        expect(await date.inputValue()).toBe("");

        // Accept all takes only open, certain values: the overruled number, the own amount, and the unsure VAT stay.
        await page.locator(".k2b-ai-suggestion-group__accept").click();
        expect(await page.evaluate(() => document.body.dataset.acceptAll)).toBe("date,account,deduct,text");
        expect(await number.inputValue()).toBe("RE-2026-4470");
        expect(await page.getByRole("spinbutton", { name: "Betrag brutto" }).inputValue()).toBe("321,40");
        expect(await page.getByRole("combobox", { name: "Umsatzsteuer" }).textContent()).toContain("19 %");
        expect(await page.getByRole("combobox", { name: "Umsatzsteuer" }).getAttribute("data-suggestion")).toBe("open-unsure");
        expect(await page.getByRole("switch", { name: "Vorsteuer abziehen" }).isChecked()).toBe(true);
        expect(await live(page)).toContain("4 Vorschläge übernommen. 1 unsicherer Wert bleibt offen: Umsatzsteuer.");
        // The button keeps focus and says there is nothing left to take.
        expect(await page.locator(".k2b-ai-suggestion-group__accept").getAttribute("aria-disabled")).toBe("true");
        await settled(page);
        expect(await boxes(page)).toEqual(before);

        // The owner withdraws every suggestion: the reserved lines stay.
        await page.locator("#dismiss").click();
        await settled(page);
        expect(await boxes(page)).toEqual(before);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`loading, arriving, locked, and failed suggestions keep every field in place at ${width}px`, async () => {
      for (const scenario of ["loading", "locked"]) {
        const page = await browser!.newPage({ viewport: { width, height: 1400 }, reducedMotion: "reduce" });
        try {
          const { before, errors } = await open(page, scenario);
          if (scenario === "loading") {
            expect(await page.locator(".k2b-ai-suggestion-group").getAttribute("aria-busy")).toBe("true");
            await page.locator("#arrive").click();
            await settled(page);
            expect(await page.locator(".k2b-ai-suggestion-group").getAttribute("aria-busy")).toBeNull();
            expect(await page.getByRole("textbox", { name: "Rechnungsnummer" }).getAttribute("placeholder")).toBe("RE-2026-4471");
          } else {
            expect(await page.getByRole("button", { name: "Vorschlag für Rechnungsnummer übernehmen" }).count()).toBe(0);
            expect(await page.getByRole("button", { name: "Vorschlag für Buchungstext übernehmen" }).count()).toBe(0);
            expect(await page.getByRole("button", { name: "Erneut", exact: true }).count()).toBe(1);
          }
          expect(await boxes(page)).toEqual(before);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }
    }, 60_000);
  }
});
