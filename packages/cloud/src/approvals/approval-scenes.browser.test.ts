import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { FIXTURE_AT } from "../ai/chat/action-question.fixtures";

// The approval in each of its states and places, painted by a real layout engine at desktop and phone width.
const ui = resolve(import.meta.dir, "../../../ui");
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "approval-scenes.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-approval-scenes-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Approval scenes harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness = "";
let css = "";
let icons: { css: string; font: string };
beforeAll(async () => {
  const [bundle, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  css = await styles.outputs[0]!.text();
  harness = bundle;
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("The Tabler preset references no WOFF2 file.");
  icons = { css: source.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const SCENE_CSS = `
  body { margin: 0; background: var(--k2b-surface); }
  .scene { box-sizing: border-box; width: min(100%, 796px); margin: 0 auto; padding: 24px 16px; }
  .scene-label { margin: 18px 0 0; font: 600 13px/1.4 var(--font-sans, sans-serif); color: var(--k2b-text-secondary); }
  .scene--everywhere { width: min(100%, 1400px); }
  .scene-places { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 24px 28px; align-items: start; }
  .scene-places [data-place="page"] { grid-column: 1 / -1; }
  .scene-places [data-place="panel"] { max-width: 420px; }
  @media (max-width: 720px) { .scene-places { grid-template-columns: 1fr; } }
`;

const open = async (scene: string, width: number, theme: "light" | "dark" = "light"): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [at]);
      },
      get(target, key, receiver) {
        return key === "now" ? () => at : Reflect.get(target, key, receiver);
      },
    });
  }, Date.parse(FIXTURE_AT));
  const origin = "https://cloud.example.test";
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (path === "/tabler.woff2") return route.fulfill({ path: icons.font });
    if (path === "/api/approvals/counts") return route.fulfill({ json: { total: 1, apps: { spaces: 1 } } });
    if (path !== "/") return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark dark" : ""}"><script type="module" src="/harness.js"></script></body></html>`,
    });
  });
  await page.goto(`${origin}/?scene=${scene}`);
  await page.locator(".k2b-chat-decision, .cloud-blocks__choice, .cloud-capability-view").first().waitFor();
  await settled(page);
  return page;
};

const shot = async (page: Page, name: string) => {
  const dir = process.env.CAPBLOCKS_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // The whole page in one viewport: a full-page capture would pin an answer row that sticks to the bottom of the view.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height });
  await settled(page);
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
  await page.setViewportSize(size);
};

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe("Approval scenes", () => {
  for (const width of [1440, 390])
    test(`Gustav's chart at ${width} px is an island under Cloud's head, like an app's result`, async () => {
      const page = await open("gustav", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        await page.locator('.cloud-blocks__cell[data-kind="Chart"] .k2b-dashboard-frame').first().waitFor();
        await settled(page);
        const look = await page.evaluate(() => {
          const head = document.querySelector(".cloud-capability-view__head");
          const frame = document.querySelector<HTMLElement>('.cloud-blocks__cell[data-kind="Chart"] .k2b-dashboard-frame');
          return {
            head: head?.textContent?.replace(/\s+/g, " ").trim(),
            tools: [...(head?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("aria-label")),
            island: frame ? getComputedStyle(frame).boxShadow !== "none" || getComputedStyle(frame).borderTopWidth !== "0px" : false,
          };
        });
        await shot(page, `06-gustav-diagramm-light-${width}`);
        expect(look.head).toContain("Gustav");
        expect(look.head).toContain("Diagramm");
        expect(look.tools).toEqual(["Groß öffnen", "Daten zeigen"]);
        expect(look.island).toBe(true);
      } finally {
        await page.close();
      }
    });

  for (const width of [1440, 390])
    test(`Gustav's key figures at ${width} px stand flat in one row under one head, his chart as an island`, async () => {
      const page = await open("konten", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        await page.locator(".k2b-stat-cell:not([data-status='loading'])").first().waitFor();
        await settled(page);
        const look = await page.evaluate(() => ({
          heads: [...document.querySelectorAll(".cloud-capability-view__head")].map((head) =>
            head.textContent?.replace(/\s+/g, " ").trim(),
          ),
          stats: document.querySelectorAll('.cloud-blocks__cell[data-kind="Stats"]').length,
          negative: getComputedStyle(document.querySelectorAll(".k2b-stat-cell__value")[3]!).color,
          positive: getComputedStyle(document.querySelectorAll(".k2b-stat-cell__value")[0]!).color,
          cells: [...document.querySelectorAll(".k2b-stat-cell")].map((cell) => [
            cell.textContent?.replace(/\s+/g, " ").trim(),
            getComputedStyle(cell).boxShadow,
            getComputedStyle(cell).borderTopWidth,
          ]),
          // Every key figure has its small sign before its name (v12, "Kennzahlen flach"): a plain glyph, no chip.
          signs: [...document.querySelectorAll(".k2b-stat-cell__head")].map((head) => {
            const sign = head.querySelector<HTMLElement>(":scope > .k2b-stat-cell__icon");
            const label = head.querySelector(".k2b-stat-cell__label")!.getBoundingClientRect();
            if (!sign) return null;
            const box = sign.getBoundingClientRect();
            return { before: box.right <= label.left, fill: getComputedStyle(sign).backgroundColor, size: Math.round(box.height) };
          }),
        }));
        await shot(page, `06-gustav-konten-light-${width}`);
        expect(look.heads).toHaveLength(2);
        expect(look.heads[0]).toContain("Kennzahlen");
        expect(look.heads[1]).toContain("Diagramm");
        expect(look.stats).toBe(1);
        expect(look.cells.map(([text]) => text)).toEqual([
          expect.stringContaining("2.481,20 €"),
          expect.stringContaining("12.050,00 €"),
          expect.stringContaining("640,00 €"),
          expect.stringContaining("−312,45 €"),
        ]);
        expect(look.signs).toHaveLength(4);
        for (const sign of look.signs) expect(sign).toMatchObject({ before: true, fill: "rgba(0, 0, 0, 0)" });
        // A negative figure reads red, given as text with its minus sign.
        expect(look.negative).not.toBe(look.positive);
        // Flat: no tile shadow and no frame around a key figure.
        for (const [, shadow, border] of look.cells) {
          expect(["none", "rgba(0, 0, 0, 0) 0px 0px 0px 0px"]).toContain(shadow ?? "");
          expect(border).toBe("0px");
        }
      } finally {
        await page.close();
      }
    });

  for (const width of [1440, 390])
    test(`key figures Gustav drew as stat charts or as cards stand as one flat row under his head at ${width} px`, async () => {
      const page = await open("kennzahlen", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        await page.locator(".k2b-stat-cell:not([data-status='loading'])").first().waitFor();
        await settled(page);
        const look = await page.evaluate(() => ({
          heads: [...document.querySelectorAll(".cloud-capability-view__head")].map((head) =>
            head.textContent?.replace(/\s+/g, " ").trim(),
          ),
          rows: document.querySelectorAll('.cloud-blocks__cell[data-kind="Stats"]').length,
          charts: document.querySelectorAll('.cloud-blocks__cell[data-kind="Chart"]').length,
          cells: document.querySelectorAll(".k2b-stat-cell").length,
          signs: document.querySelectorAll(".k2b-stat-cell__head > .k2b-stat-cell__icon").length,
          neutral: document.querySelectorAll(".k2b-stat-cell__head > .k2b-stat-cell__icon .ti-hash").length,
        }));
        await shot(page, `78-kennzahlen-light-${width}`);
        expect(look.heads).toHaveLength(2);
        for (const head of look.heads) expect(head).toContain("Kennzahlen");
        // Both rows carry the sign before each name (v12), the stat charts through their icon like the cards.
        // A figure that names no icon has the neutral sign: every key figure has one.
        expect(look).toMatchObject({ rows: 2, charts: 0, cells: 6, signs: 6, neutral: 1 });
      } finally {
        await page.close();
      }
    });

  // "Open large" shows the same view in the Lightbox from the data the chat holds; closing returns to the button.
  for (const [scene, content] of [
    ["gustav", ".k2b-chart svg path"],
    ["kennzahlen", ".k2b-stat-cell"],
  ] as const)
    test(`"Open large" shows the ${scene} view itself in the Lightbox, and closing gives the focus back`, async () => {
      const page = await open(scene, 1440);
      try {
        const opener = page.getByRole("button", { name: "Groß öffnen" }).first();
        await opener.click();
        const lightbox = page.locator(".k2b-lightbox[open]");
        await lightbox.locator(`.k2b-lightbox__view ${content}`).first().waitFor();
        await settled(page);
        expect(await lightbox.textContent()).not.toContain("nicht mehr verfügbar");
        if (scene === "gustav" && process.env.CAPBLOCKS_SHOTS)
          await page.screenshot({ path: resolve(process.env.CAPBLOCKS_SHOTS, "lightbox-diagramm-light-1440.png") });
        await page.keyboard.press("Escape");
        await lightbox.waitFor({ state: "detached" });
        expect(await opener.evaluate((button) => button === document.activeElement)).toBe(true);
      } finally {
        await page.close();
      }
    });

  for (const width of [1440, 390])
    test(`Gustav's survey at ${width} px is a flat choice: no hull, flat cards, the chosen one tinted`, async () => {
      const page = await open("survey", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        await page.getByRole("radio", { name: "Jana Berger" }).click();
        await settled(page);
        const look = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(".cloud-blocks__choice")!;
          const options = [...root.querySelectorAll<HTMLElement>(".k2b-choice-list__option")];
          const style = getComputedStyle(root);
          return {
            hull: [style.borderTopWidth, style.backgroundColor],
            ai: root.getAttribute("data-k2b-primary"),
            edges: options.map((option) =>
              [getComputedStyle(option).borderTopWidth, getComputedStyle(option).boxShadow, getComputedStyle(option).outlineWidth].join(
                "|",
              ),
            ),
            chosen: options.map((option) => getComputedStyle(option).backgroundColor),
            state: root.querySelector(".cloud-blocks__choice-state")?.textContent,
            answer: root.querySelector(".cloud-blocks__choice-foot .k2b-button")?.getAttribute("data-variant"),
          };
        });
        await shot(page, `07-auswahl-light-${width}`);
        expect(look.hull).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
        // Flat cards: the shared 2 px edge drawn inside, no outer border; the chosen one in the AI colour.
        for (const edge of look.edges) expect(edge).toMatch(/^0px\|.* 0px 0px 0px 2px inset\|/);
        expect(look.ai).toBe("ai");
        expect(look.chosen[0]).not.toBe(look.chosen[1]);
        expect(look.state).toBe("1 gewählt");
        expect(look.answer).toBe("secondary");
      } finally {
        await page.close();
      }
    });

  for (const width of [1440, 390])
    test(`the approval frame a Code version fills at ${width} px draws the same card from data`, async () => {
      const page = await open("frame", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        const frames = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            const answers = node.querySelector<HTMLElement>(".k2b-chat-decision__answers");
            return {
              primary: node.getAttribute("data-k2b-primary"),
              radius: style.borderTopLeftRadius,
              shadow: style.boxShadow,
              sentence: node.querySelector(".k2b-chat-decision__sentence")
                ? getComputedStyle(node.querySelector(".k2b-chat-decision__sentence")!).fontSize
                : null,
              note: node.querySelector(".k2b-chat-decision__details-note")?.textContent ?? null,
              notes: node.querySelectorAll(".k2b-chat-decision__note").length,
              facts: [...node.querySelectorAll(".k2b-chat-decision__fact")].map((fact) => fact.getAttribute("data-tone")),
              answers: [...node.querySelectorAll(".k2b-chat-decision__buttons > *")].map((answer) => [
                answer.textContent?.trim(),
                answer.getAttribute("data-variant"),
              ]),
              sticky: answers ? getComputedStyle(answers).position : null,
              status: node.querySelector(".k2b-chat-decision__status")?.textContent ?? null,
              // A text action reads the same wherever the card shows it: among the answers or under a decided outcome.
              textAction: (() => {
                const action = node.querySelector<HTMLElement>(
                  '.k2b-chat-decision__buttons > [data-variant="text"], .k2b-chat-outcome__actions > *',
                );
                if (!action) return null;
                const style = getComputedStyle(action);
                return { text: action.textContent?.trim(), color: style.color, weight: style.fontWeight, fill: style.backgroundColor };
              })(),
              busy: node.querySelector("[aria-busy='true']") !== null,
              origin: node.querySelector(".k2b-chat-decision__details-label strong")
                ? getComputedStyle(node.querySelector(".k2b-chat-decision__details-label strong")!).fontWeight
                : null,
              edges: [...node.querySelectorAll<HTMLElement>('.k2b-chat-decision__buttons [data-variant="secondary"]')].map(
                (button) => getComputedStyle(button).borderTopColor,
              ),
              // Facts and answers share one line when they fit: the first fact's middle lies within the buttons' line.
              oneLine: (() => {
                const fact = node.querySelector(".k2b-chat-decision__fact")?.getBoundingClientRect();
                const button = node.querySelector(".k2b-chat-decision__buttons > *")?.getBoundingClientRect();
                return fact && button ? Math.abs(fact.top + fact.height / 2 - (button.top + button.height / 2)) < 4 : null;
              })(),
            };
          }),
        );
        await shot(page, `40-freigabe-rahmen-light-${width}`);
        expect(frames.map((frame) => [frame.primary, frame.radius, frame.shadow])).toEqual(
          Array.from({ length: 5 }, () => ["ai", "12px", "none"]),
        );
        // The answers come first and "See everything" last; side answers are white without an edge.
        expect(frames[0]).toMatchObject({
          sentence: "18px",
          note: "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.",
          origin: "600",
          facts: ["success", "neutral"],
          answers: [
            ["Version 5 einschalten", "ai"],
            ["Alles ansehen", "text"],
          ],
          sticky: "sticky",
        });
        expect(frames[1]).toMatchObject({
          notes: 2,
          facts: ["success"],
          answers: [
            ["Zurückziehen", "secondary"],
            ["Ohne Dateien ablegen bauen", "secondary"],
            ["Alles ansehen", "text"],
          ],
          edges: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
        });
        expect(frames[2]).toMatchObject({
          facts: ["warning", "neutral"],
          answers: [
            ["Erst Beispiele ausprobieren", "secondary"],
            ["Trotzdem einschalten", "ai"],
          ],
        });
        // On a wide card the short fact stands left in the answer row, not on a line of its own.
        if (width === 1440) expect(frames[1]!.oneLine).toBe(true);
        // On the Code page a waiting version's "See everything" sits under its outcome: the same text action in the
        // place's colour as among the answers, not black text.
        expect(frames[3]!.status).toBe("Wartet auf Admin");
        expect(frames[3]!.textAction).toEqual(frames[0]!.textAction);
        expect(frames[0]!.textAction).toMatchObject({ text: "Alles ansehen", weight: "600", fill: "rgba(0, 0, 0, 0)" });
        expect(frames[4]).toMatchObject({ status: "Lädt", busy: true, sentence: null });
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const width of [1440, 390])
    test(`every state at ${width} px keeps its tinted ground and head, and says its state`, async () => {
      const page = await open("states", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        const cards = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => ({
            ground: getComputedStyle(node).backgroundColor,
            head: node.querySelector(".k2b-chat-decision__kind")?.textContent,
            status: node.querySelector(".k2b-chat-decision__status")?.textContent ?? null,
          })),
        );
        expect(cards.map((card) => card.status)).toEqual([
          null,
          "Läuft",
          "Erledigt",
          "Abgelehnt",
          "Abgelaufen",
          "Fehlgeschlagen",
          "Unklar",
        ]);
        expect(new Set(cards.map((card) => card.ground)).size).toBe(1);
        expect(new Set(cards.map((card) => card.head))).toEqual(new Set(["Freigabe"]));
        await shot(page, `08-zustaende-alle-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const width of [1440, 390])
    test(`a mail draft at ${width} px turns into its approval in place`, async () => {
      const page = await open("mail", width);
      try {
        const card = page.locator(".k2b-chat-decision").first();
        expect(await card.getAttribute("data-mode")).toBe("edit");
        expect(await card.locator(".k2b-chat-decision__kind").textContent()).toBe("Entwurf");
        await shot(page, `05-mail-entwurf-light-${width}`);
        await card.locator(".k2b-chat-decision__answer").last().click();
        await page.waitForFunction(() => document.querySelector(".k2b-chat-decision")?.getAttribute("data-mode") === "approve");
        await settled(page);
        expect(await card.locator(".k2b-chat-decision__kind").textContent()).toBe("Freigabe");
        expect(await card.locator("textarea").evaluate((field) => (field as HTMLTextAreaElement).readOnly)).toBe(true);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `06-mail-freigabe-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const width of [1440, 390])
    test(`drafts of three apps at ${width} px share one form with labels above the fields`, async () => {
      const page = await open("drafts", width);
      try {
        const labels = await page.locator(".cloud-blocks__field").evaluateAll((fields) =>
          fields.map((field) => {
            const label = field.querySelector("label")?.getBoundingClientRect();
            const input = field.querySelector("input, textarea")?.getBoundingClientRect();
            return label && input ? label.bottom <= input.top + 1 : false;
          }),
        );
        expect(labels.length).toBe(7);
        expect(labels.every(Boolean)).toBe(true);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `21-entwuerfe-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const [width, theme] of [
    [1440, "light"],
    [390, "light"],
    [1440, "dark"],
  ] as const)
    test(`one approval looks the same in the chat, a flat panel and the approvals page (${width} px, ${theme})`, async () => {
      const page = await open("everywhere", width, theme);
      try {
        const looks = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => {
            const css = getComputedStyle(node);
            const approve = node.querySelector<HTMLElement>('.k2b-chat-decision__answer[data-variant="ai"]');
            return [
              css.backgroundColor,
              css.borderRadius,
              css.paddingTop,
              css.boxShadow,
              approve ? getComputedStyle(approve).backgroundColor : "",
            ].join(" ");
          }),
        );
        expect(looks.length).toBe(3);
        expect(new Set(looks).size).toBe(1);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `24-freigabe-ueberall-${theme}-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);
});
