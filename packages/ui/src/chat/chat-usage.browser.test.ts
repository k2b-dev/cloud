import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The usage control reserves its box in a real layout engine: a warning, the number, and the details must not move
// "+", the controls after the ring, or the model and send controls on the right.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "chat-usage.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { Button, Chat, IconButton, LocaleProvider, ProgressBar } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [budget, setBudget] = createSignal(34);
const [failed, setFailed] = createSignal(false);
const [running, setRunning] = createSignal(false);
const [context, setContext] = createSignal(18_000);
const [refreshing, setRefreshing] = createSignal(false);
window.calls = { compact: 0, refresh: 0, retry: 0 };
window.fixture = { setBudget, setFailed, setRunning, setContext };
const icon = (name) => {
  const element = document.createElement("i");
  element.className = "ti " + name;
  element.setAttribute("aria-hidden", "true");
  return element;
};
const line = (text) => {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
};
const row = (...children) => {
  const element = document.createElement("div");
  element.className = "k2b-chat-usage__row";
  for (const child of children) insert(element, child, null);
  return element;
};
const percent = (value) => new Intl.NumberFormat("de", { style: "percent" }).format(value / 100);

render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(Chat.Composer, {
          value: "",
          onValueChange: () => {},
          onSubmit: () => {},
          placeholder: "Assistent etwas fragen",
          menuActions: [{ id: "new", label: "Neuer Chat", onSelect: () => {} }],
          get contextUsage() {
            return {
              usage: { input: context() - 2_000, output: 2_000 },
              loopUsage: { total: context() + 6_000 },
              contextWindow: 100_000,
              modelLabel: "Orion 2",
              note: "Wird es voll, werden ältere Teile zusammengefasst.",
            };
          },
          get contextPopupAction() {
            return {
              id: "compact",
              label: "Jetzt zusammenfassen",
              icon: "ti ti-arrows-diagonal-minimize-2",
              disabled: running(),
              disabledReason: "Während eine Antwort läuft, lässt sich der Chat nicht zusammenfassen.",
              onSelect: () => { window.calls.compact++; },
            };
          },
          contextSections: [
            {
              id: "budget",
              title: "Dein Budget",
              warnAt: 80,
              get percent() { return failed() ? null : budget(); },
              get value() { return failed() ? "Nicht verfügbar" : percent(budget()) + " genutzt"; },
              get summary() { return "Budget " + (failed() ? "Nicht verfügbar" : percent(budget()) + " genutzt"); },
              content: () =>
                failed()
                  ? row(
                      line("Verbrauch nicht verfügbar"),
                      createComponent(Button, { size: "xs", variant: "subtle", onClick: () => { window.calls.retry++; setFailed(false); }, children: "Erneut versuchen" }),
                    )
                  : [
                      createComponent(ProgressBar, { get value() { return budget(); }, size: "xs", get tone() { return budget() >= 80 ? "warning" : "info"; }, label: "Orion 2" }),
                      row(
                        line("Orion 2 · setzt sich in 3 Tagen zurück"),
                        createComponent(IconButton, {
                          label: "Aktualisieren",
                          size: "xs",
                          // Loading disables the focused button natively, as the Assistant's refresh does.
                          get loading() {
                            return refreshing();
                          },
                          onClick: () => {
                            window.calls.refresh++;
                            setRefreshing(true);
                            setTimeout(() => setRefreshing(false), 300);
                          },
                          children: icon("ti-refresh") }),
                      ),
                    ],
            },
          ],
          contextActions: [{ id: "tasks", label: "Aufgaben anzeigen", icon: "ti ti-list-check", onSelect: () => {} }],
          submitTools: (() => {
            const model = document.createElement("button");
            model.id = "model";
            model.type = "button";
            model.textContent = "Ausgewogen";
            model.style.cssText = "width:148px;height:30px";
            return model;
          })(),
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the usage fixture for the browser.");
const script = await build.outputs[0]!.text();

type Fixture = {
  setBudget: (value: number) => void;
  setFailed: (value: boolean) => void;
  setRunning: (value: boolean) => void;
  setContext: (value: number) => void;
};
declare const fixture: Fixture;
declare const calls: { compact: number; refresh: number; retry: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width, height: 700 } })).newPage();
  page.setDefaultTimeout(5_000);
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const documentHtml =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<style>${css}</style><style>${fonts}</style>` +
    `<style>*,*::before,*::after{transition:none!important}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; padding: 0 0.5rem 0.5rem; box-sizing: border-box; max-width: 48rem; margin: 0 auto; }
</style></head>` +
    `<body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`;
  const documentUrl = `${assets}chat-usage`;
  await page.route(documentUrl, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  await page.goto(documentUrl);
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-chat-usage__trigger").waitFor();
  await settled(page);
  return page;
};

/** Boxes of every footer control and of the reserved usage box, which must not move between states. */
const footer = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
    };
    const trigger = document.querySelector(".k2b-chat-usage__trigger")!.getBoundingClientRect();
    const reserved = document.querySelector(".k2b-chat-usage")!.getBoundingClientRect();
    return {
      controls: [...document.querySelectorAll(".k2b-chat-composer__footer button")]
        .filter((button) => !button.closest(".k2b-chat-context-popup") && button.getBoundingClientRect().width > 0)
        // The ring grows into its reserved box when it shows the number; its start and height stay.
        .map((button) => [
          button.getAttribute("aria-label")?.startsWith("Verbrauch:") ? "usage" : (button.getAttribute("aria-label") ?? button.id),
          button.classList.contains("k2b-chat-usage__trigger") ? box(button)!.filter((_, index) => index !== 2) : box(button),
        ]),
      reserved: box(document.querySelector(".k2b-chat-usage")),
      triggerLeft: Math.round(trigger.left * 10) / 10,
      triggerFits: trigger.right <= reserved.right + 0.5,
      number: document.querySelector(".k2b-chat-usage__number")?.getBoundingClientRect().width ?? 0,
      composer: box(document.querySelector(".k2b-chat-composer")),
    };
  });

for (const width of [1440, 390]) {
  test(`at ${width} px the ring keeps its reserved box and nothing moves into the warning`, async () => {
    const page = await open(width);
    try {
      const rest = await footer(page);
      // One ring right of "+", the tasks control after it, and model and send on the right.
      const labels = rest.controls.map(([label]) => label);
      expect(labels.indexOf("Zum Chat hinzufügen")).toBe(0);
      expect(labels.indexOf("usage")).toBe(1);
      expect(labels.indexOf("Aufgaben anzeigen")).toBe(2);
      expect(labels.filter((label) => label === "usage")).toHaveLength(1);
      expect(rest.number).toBe(0);

      for (const step of [
        () => fixture.setBudget(86),
        () => fixture.setBudget(100),
        () => {
          fixture.setBudget(10);
          fixture.setContext(97_000);
        },
        () => fixture.setFailed(true),
      ]) {
        await page.evaluate(step);
        await settled(page);
        const next = await footer(page);
        expect(next.controls).toEqual(rest.controls);
        expect(next.reserved).toEqual(rest.reserved);
        expect(next.triggerLeft).toBe(rest.triggerLeft);
        expect(next.composer).toEqual(rest.composer);
        expect(next.triggerFits).toBe(true);
      }
      await page.evaluate(() => {
        fixture.setFailed(false);
        fixture.setContext(18_000);
        fixture.setBudget(100);
      });
      await settled(page);
      const warning = await page.locator(".k2b-chat-usage__trigger").getAttribute("aria-label");
      expect(warning).toBe("Verbrauch: Kontext 18 % voll, Budget 100 % genutzt");
      // The number shows on a wide composer; on a phone the box stays one target wide and the ring carries the warning.
      expect((await footer(page)).number > 0).toBe(width > 480);
    } finally {
      await page.context().close();
    }
  }, 30_000);
}

test("the details hold the old context window and the budget, and the summary icon says why it is off", async () => {
  const page = await open(1440);
  try {
    const trigger = page.locator(".k2b-chat-usage__trigger");
    await trigger.click();
    const popup = page.getByRole("dialog");
    await popup.waitFor();
    // The context details of today stay: model, input, output, whole response, window, remaining.
    for (const text of ["Dieser Chat", "18 % voll", "Orion 2", "Eingabe", "Ausgabe", "Ganze Antwort", "Kontextfenster", "Verbleibend"])
      expect(await popup.textContent()).toContain(text);
    expect(await popup.textContent()).toContain("Dein Budget");
    const compact = popup.getByRole("button", { name: "Jetzt zusammenfassen" });
    await compact.click();
    expect(await page.evaluate(() => calls.compact)).toBe(1);
    // Keyboard Refresh: the button disables itself while it loads, and the details stay open.
    await popup.getByRole("button", { name: "Aktualisieren" }).focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => calls.refresh)).toBe(1);
    const refreshing = '.k2b-chat-context-popup button[aria-label="Aktualisieren"]';
    expect(await page.locator(refreshing).isDisabled()).toBe(true);
    await page.waitForFunction((selector) => !document.querySelector<HTMLButtonElement>(selector)?.disabled, refreshing);
    await expect(trigger.getAttribute("aria-expanded")).resolves.toBe("true");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".k2b-chat-context-popup")))).toBe(true);

    // While an answer runs the icon is off, stays focusable, and its tooltip gives the reason.
    await page.evaluate(() => fixture.setRunning(true));
    await expect(compact.getAttribute("aria-disabled")).resolves.toBe("true");
    await compact.click({ force: true });
    expect(await page.evaluate(() => calls.compact)).toBe(1);
    await popup.getByRole("heading", { name: "Dein Budget" }).hover();
    await compact.hover();
    await page.getByRole("tooltip", { name: "Während eine Antwort läuft, lässt sich der Chat nicht zusammenfassen." }).waitFor();

    // A failed reading says so in the details and offers a retry.
    await page.evaluate(() => fixture.setFailed(true));
    await popup.getByText("Verbrauch nicht verfügbar").waitFor();
    await popup.getByRole("button", { name: "Erneut versuchen" }).click();
    expect(await page.evaluate(() => calls.retry)).toBe(1);
    await popup.getByRole("button", { name: "Aktualisieren" }).waitFor();
    // The retry replaced itself; the details stay open and keep the focus.
    await expect(trigger.getAttribute("aria-expanded")).resolves.toBe("true");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".k2b-chat-context-popup")))).toBe(true);

    // Escape closes and returns focus to the ring.
    await page.keyboard.press("Escape");
    await expect(trigger.getAttribute("aria-expanded")).resolves.toBe("false");
  } finally {
    await page.context().close();
  }
}, 30_000);
