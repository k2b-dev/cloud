import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/run-log.browser-harness";
import type { RunLogAction, RunLogProps, RunStepEntry } from "./RunLog";

const ui = resolve(import.meta.dir, "../..");
const repo = resolve(ui, "../..");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
setDefaultTimeout(20_000);
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(ui, "test/run-log.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "run-log-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!transformed?.code) throw new Error(`Could not transform ${path}`);
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "RunLog harness failed");
  bundle = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, options: { dark?: boolean; reduced?: boolean; touch?: boolean } = {}) => {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 780 : 900 },
    reducedMotion: options.reduced ? "reduce" : "no-preference",
    hasTouch: options.touch,
  });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${readFileSync(resolve(ui, "dist/styles.css"), "utf8")}</style><style>${fonts}</style><style>${icons}</style><style>${readFileSync(resolve(repo, "docs-site/assets/ui-catalog.css"), "utf8")}</style><style>body{margin:0;padding:16px;background:var(--k2b-surface-canvas)}#test-root{max-width:700px}#catalog-root{display:none}</style></head><body class="k2b-ui${options.dark ? " k2b-dark" : ""}"><div id="test-root"></div><div id="catalog-root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("#test-root .k2b-run-log");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
type BrowserRunLogProps = Omit<RunLogProps, "meta" | "actions"> & { meta?: string; actions?: readonly Omit<RunLogAction, "onClick">[] };
const set = async (page: Page, props: BrowserRunLogProps) => {
  await page.evaluate((props) => window.__runLog.set(props), props);
  await settled(page);
};
const box = (page: Page, selector = "#test-root .k2b-run-log") =>
  page.locator(selector).evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  });
const still = (page: Page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll("#test-root .k2b-run-log")].every((node) =>
      node
        .getAnimations({ subtree: true })
        .filter((animation) => animation.timeline === document.timeline)
        .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY),
    ),
  );
const AT = "2026-11-17T16:42:07Z";
const steps: RunStepEntry[] = [
  {
    kind: "step",
    id: "read",
    at: AT,
    label: "Beleg lesen",
    description: "Liest Text und Positionen aus dem PDF.",
    status: "running",
    icon: "ti ti-file-text",
  },
  { kind: "step", id: "find", at: AT, label: "Einlieferer suchen", status: "pending" },
  { kind: "step", id: "write", at: AT, label: "Daten erfassen", status: "pending" },
];
const logs = [{ kind: "log", id: "one", at: AT, level: "info", text: "PDF erhalten" }] as const;
const base: BrowserRunLogProps = { state: "running", duration: 6000, meta: "heute, 16:42", entries: [...steps, ...logs] };

for (const width of [1440, 390])
  describe(`RunLog at ${width}px`, () => {
    test("state, reason, clocks, connection and action changes never move the card or the content below", async () => {
      const page = await open(width);
      try {
        const idle = await box(page);
        await set(page, { ...base, state: "starting" });
        expect(await box(page)).toEqual(idle);
        await set(page, base);
        const initial = await box(page);
        const below = await box(page, "#below");
        for (const state of ["running", "succeeded", "failed"] as const) {
          await set(page, {
            ...base,
            state,
            duration: 128000,
            meta: "Verbindung weg, verbinde neu …",
            entries: [
              ...steps.map((step, i) => ({
                ...step,
                status: i === 1 ? ("failed" as const) : ("succeeded" as const),
                message: "Kein Einlieferer mit Kundennummer K-20418 im Adressbuch. Prüfe die Kundennummer und wiederhole den Lauf.",
                startedAt: AT,
                endedAt: "2026-11-17T16:42:12Z",
              })),
              ...logs,
            ],
            actions: [
              { icon: "ti ti-refresh", label: "Wiederholen", href: "#retry" },
              { icon: "ti ti-pencil", label: "Ändern", href: "#edit" },
            ],
          });
          expect(await box(page)).toEqual(initial);
          expect(await box(page, "#below")).toEqual(below);
        }
        expect(await page.locator("#test-root .k2b-run-log__step").count()).toBe(3);
        expect(await page.locator("#test-root .k2b-run-log").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      } finally {
        await page.close();
      }
    });

    test("output and compact disclosures change only height, retain their head, and keep closed controls inert", async () => {
      const page = await open(width);
      try {
        await set(page, base);
        const closed = await box(page);
        const head = await box(page, "#test-root .k2b-run-log__head");
        const toggle = page.locator("#test-root .k2b-run-log__output-toggle");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await still(page);
        await settled(page);
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        expect((await box(page)).height).toBe(closed.height + 180);
        expect(await box(page, "#test-root .k2b-run-log__head")).toEqual(head);
        await page.keyboard.press("Space");
        await still(page);
        await settled(page);
        expect(await box(page)).toEqual(closed);
        expect(await page.locator("#test-root [role=log]").evaluate((node) => Boolean(node.closest("[inert]")))).toBe(true);
        await set(page, { ...base, size: "compact" });
        await still(page);
        await settled(page);
        const compact = await box(page);
        const compactHead = await box(page, "#test-root .k2b-run-log__head");
        const expand = page.locator("#test-root .k2b-run-log__toggle");
        await expand.focus();
        await page.keyboard.press("Enter");
        await still(page);
        await settled(page);
        expect((await box(page)).height).toBeGreaterThan(compact.height);
        expect(await box(page, "#test-root .k2b-run-log__head")).toEqual(compactHead);
        await page.keyboard.press("Space");
        await still(page);
        await settled(page);
        expect(await box(page)).toEqual(compact);
      } finally {
        await page.close();
      }
    });

    test("keyboard focus survives immutable step updates; reasons and descriptions stay reachable", async () => {
      const page = await open(width);
      try {
        await set(page, base);
        const info = page.getByRole("button", { name: "Details zu Beleg lesen" }).first();
        await info.focus();
        await settled(page);
        const geometry = await box(page);
        expect(await info.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
        await set(page, { ...base, entries: [...steps.map((step) => ({ ...step, status: "succeeded" as const })), ...logs] });
        expect(await info.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(await box(page)).toEqual(geometry);
        await info.click();
        await settled(page);
        expect(await page.getByText("Liest Text und Positionen aus dem PDF.", { exact: true }).first().isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        const reason = "Kein Einlieferer mit Kundennummer K-20418 im Adressbuch. Prüfe die Kundennummer und wiederhole den Lauf.";
        await set(page, {
          ...base,
          state: "failed",
          entries: [{ ...steps[0]!, status: "failed", message: reason }, ...steps.slice(1), ...logs],
        });
        const reasonButton = page.locator("#test-root .k2b-run-log__reason-button");
        await reasonButton.focus();
        await settled(page);
        expect(await reasonButton.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
        expect(await page.getByRole("tooltip").filter({ hasText: reason }).isVisible()).toBe(true);
        expect(await box(page)).toEqual(geometry);
      } finally {
        await page.close();
      }
    });
  });

test("phone actions collapse into the shared menu, one action stays, and touch targets are at least 44px", async () => {
  const page = await open(390, { touch: true });
  try {
    await set(page, {
      ...base,
      actions: [
        { icon: "ti ti-refresh", label: "Wiederholen", href: "#retry" },
        { icon: "ti ti-pencil", label: "Ändern", href: "#edit" },
      ],
    });
    const menu = page.locator("#test-root").getByRole("button", { name: "Aktionen", exact: true });
    expect(await menu.isVisible()).toBe(true);
    await menu.click();
    await settled(page);
    expect(await page.getByRole("menuitem", { name: "Wiederholen", exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await settled(page);
    await set(page, { ...base, actions: [{ icon: "ti ti-refresh", label: "Wiederholen", href: "#retry" }] });
    expect(await page.locator("#test-root").getByRole("link", { name: "Wiederholen" }).isVisible()).toBe(true);
    const heights = await page
      .locator("#test-root button:visible, #test-root a:visible")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.every((height) => height >= 44)).toBe(true);
  } finally {
    await page.close();
  }
});

test("dark semantic tones, off-live output, and both reduced-motion sources preserve the same layout", async () => {
  const page = await open(390, { dark: true, reduced: true });
  try {
    await set(page, base);
    const before = await box(page);
    expect(await page.locator("#test-root [role=log]").getAttribute("aria-live")).toBe("off");
    const running = await page.locator("#test-root .k2b-run-log__head").evaluate((node) => getComputedStyle(node).backgroundColor);
    await set(page, { ...base, state: "failed" });
    expect(await box(page)).toEqual(before);
    expect(await page.locator("#test-root .k2b-run-log__head").evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
      running,
    );
    for (const attribute of [false, true]) {
      await page.emulateMedia({ reducedMotion: attribute ? "no-preference" : "reduce" });
      await page.evaluate((attribute) => {
        document.documentElement.dataset.k2bMotion = attribute ? "reduced" : "full";
      }, attribute);
      await settled(page);
      expect(
        await page
          .locator("#test-root .k2b-run-log__fold")
          .first()
          .evaluate((node) => getComputedStyle(node).transitionDuration),
      ).toBe("0s");
    }
  } finally {
    await page.close();
  }
});

test("many steps and loaded output keep their fixed windows", async () => {
  const page = await open(1440);
  try {
    await set(page, {
      ...base,
      entries: Array.from({ length: 13 }, (_, i) => ({ ...steps[0]!, id: String(i), label: `Schritt ${i + 1}` })),
    });
    const before = await box(page);
    await page.getByRole("button", { name: "8 frühere Schritte anzeigen" }).click();
    await settled(page);
    expect(await box(page)).toEqual(before);
    await page.getByRole("button", { name: "3 frühere Schritte anzeigen" }).click();
    await settled(page);
    expect(await box(page)).toEqual(before);
    await page.getByRole("button", { name: "Aktuelle Schritte anzeigen" }).click();
    await settled(page);
    expect(await box(page)).toEqual(before);
    await set(page, { ...base, output: "open", olderCount: 312 });
    await still(page);
    await settled(page);
    const opened = await box(page);
    await set(page, {
      ...base,
      output: "open",
      entries: [...steps, ...Array.from({ length: 80 }, (_, i) => ({ ...logs[0], id: String(i), text: `Zeile ${i}` }))],
    });
    expect(await box(page)).toEqual(opened);
  } finally {
    await page.close();
  }
});

test("output follows appended lines until the reader scrolls away, without moving the page", async () => {
  const page = await open(390);
  const lines = (count: number) => Array.from({ length: count }, (_, i) => ({ ...logs[0], id: String(i), text: `Zeile ${i}` }));
  try {
    await set(page, { ...base, output: "open", entries: [...steps, ...lines(80)] });
    await still(page);
    const output = page.locator("#test-root [role=log]");
    const atEnd = () => output.evaluate((node) => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight);
    expect(await atEnd()).toBe(true);
    await set(page, { ...base, output: "open", entries: [...steps, ...lines(90)] });
    expect(await atEnd()).toBe(true);
    await output.evaluate((node) => {
      node.scrollTop = 50;
      node.dispatchEvent(new Event("scroll"));
    });
    await set(page, { ...base, output: "open", entries: [...steps, ...lines(100)] });
    expect(await output.evaluate((node) => node.scrollTop)).toBe(50);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await page.close();
  }
});

test("the catalog host loads history and reports action requests without changing the card height", async () => {
  const page = await open(1440);
  try {
    await page.addStyleTag({
      content: "#test-root{display:none}#catalog-root{display:block}.ui-demo-card{display:none}#runlog-many{display:block}",
    });
    await settled(page);
    const card = page.locator("#runlog-many .k2b-run-log");
    const height = await card.evaluate((node) => node.getBoundingClientRect().height);
    await page.getByRole("button", { name: "312 ältere Zeilen anzeigen", exact: true }).click();
    await settled(page);
    expect(await page.locator("#runlog-many .k2b-run-log__line").count()).toBe(315);
    expect(await page.getByText("Ältere Ausgabe geladen", { exact: true }).isVisible()).toBe(true);
    expect(await card.evaluate((node) => node.getBoundingClientRect().height)).toBe(height);
    await page.addStyleTag({ content: "#runlog-many{display:none}#runlog-succeeded{display:block}" });
    await page.locator("#runlog-succeeded").getByRole("button", { name: "Wiederholen", exact: true }).click();
    await settled(page);
    expect(await page.getByText("Wiederholen angefordert", { exact: true }).first().isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});

test("step names and output use the four-level type scale, and descriptions share the leading axis", async () => {
  const page = await open(1440);
  try {
    await set(page, base);
    for (const [selector, size] of [
      ["__main", "14px"],
      ["__name", "14px"],
      ["__counts", "12px"],
      ["__output", "12px"],
    ]) {
      expect(
        await page
          .locator(`#test-root .k2b-run-log${selector}`)
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe(size!);
    }
    const axes = await page
      .locator("#test-root .k2b-run-log__leading")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
    expect(new Set(axes).size).toBe(1);
  } finally {
    await page.close();
  }
});

for (const width of [1440, 390])
  test(`capture every light catalog state at ${width}px when requested`, async () => {
    const out = process.env.RUNLOG_SCREENSHOT_DIR;
    if (!out) return;
    mkdirSync(out, { recursive: true });
    const page = await open(width, { reduced: true });
    try {
      await page.addStyleTag({
        content: "#test-root{display:none}#catalog-root{display:block}.ui-demo-card{display:none}.ui-demo-card[data-shot]{display:block}",
      });
      const cards = await page.locator("#catalog-root .ui-demo-card").evaluateAll((nodes) => nodes.map((node) => node.id));
      for (const id of cards) {
        await page.evaluate((id) => {
          for (const node of document.querySelectorAll("[data-shot]")) node.removeAttribute("data-shot");
          document.getElementById(id)!.setAttribute("data-shot", "");
          window.scrollTo(0, 0);
        }, id);
        await settled(page);
        await page.screenshot({ path: resolve(out, `${id}-light-${width}.png`) });
        if (["runlog-compact-running", "runlog-compact-failed", "runlog-compact-done", "runlog-compact-idle"].includes(id)) {
          await page.locator(`#${id} .k2b-run-log__toggle`).click();
          await settled(page);
          await page.screenshot({ path: resolve(out, `${id}-expanded-light-${width}.png`) });
        }
        if (id === "runlog-failed" && width === 390) {
          await page.locator(`#${id}`).getByRole("button", { name: "Aktionen", exact: true }).click();
          await settled(page);
          await page.screenshot({ path: resolve(out, `runlog-actions-menu-light-${width}.png`) });
          await page.keyboard.press("Escape");
        }
        if (id === "runlog-failed-output-open") {
          await page.evaluate(() => document.body.classList.add("k2b-dark"));
          await settled(page);
          await page.screenshot({ path: resolve(out, `${id}-dark-${width}.png`) });
          await page.evaluate(() => document.body.classList.remove("k2b-dark"));
        }
      }
    } finally {
      await page.close();
    }
  });
