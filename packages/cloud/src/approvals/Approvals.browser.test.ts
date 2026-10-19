import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import type { ApprovalPage, PendingApproval } from "../contracts/approvals";

// How a question card sits on the page and collapses to its outcome line depends on the real layout engine, at desktop and phone widths.
const root = mkdtempSync(resolve(tmpdir(), "cloud-approvals-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Approvals } = await import("./Approvals");
const { LocaleProvider } = await import("@k2b/ui");

const item = (id: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm",
  sentence: "Mail: Send the draft “Offer Q4 – maintenance and support” to external recipients after the undo window",
  review: {
    message: "Sends the draft after the undo window.",
    details: [
      { label: "To", value: "customer@example.com" },
      { label: "Cc", value: "alex@example.com" },
      {
        label: "Body",
        value:
          "Hello,\nplease find our offer for maintenance and support in the fourth quarter attached. Prices are valid until 31 October. If you have questions, reach out to Alex or to me directly.",
        display: "block",
      },
    ],
  },
  requester: { kind: "chat", appId: "assistant", title: "Offer Q4 for the customer", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: "2026-10-11T08:00:00.000Z",
  expiresAt: "2026-10-12T08:00:00.000Z",
  ...overrides,
});

const page: ApprovalPage = {
  items: [item("1"), item("2", { assurance: "standard", remember: { chat: true, always: true, website: false } })],
  nextCursor: null,
  count: 2,
  elsewhere: 1,
};

const render = (locale: string, layout: "list" | "band") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Approvals, { app: "assistant", initial: page, layout });
      },
    }),
  );

/** The real component, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "Approvals.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-approvals-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Approvals harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  harness = await buildHarness();
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

const open = async (width: number, locale: string, layout: "list" | "band"): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width, height: 900 } });
  await tab.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div style="padding:16px;max-width:48rem">${render(locale, layout)}</div></body></html>`,
  );
  return tab;
};

describe("Approvals layout", () => {
  for (const width of [1280, 700, 390]) {
    test(`${width} px: each request is the chat's question card, and nothing overflows`, async () => {
      const tab = await open(width, "en", "list");
      try {
        await settled(tab);
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
        expect(await tab.locator("article.cloud-approval .k2b-chat-decision__card").count()).toBe(2);
        // The answers are the shared 44 px buttons; there is no icon column and no box around the card.
        const answer = (await tab.locator("article.cloud-approval .k2b-chat-decision__answer").first().boundingBox())!;
        expect(answer.height).toBeGreaterThanOrEqual(44);
        const card = tab.locator("article.cloud-approval .k2b-chat-decision__card").first();
        expect(await card.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        expect(await tab.locator("article.cloud-approval .cloud-approval__icon").count()).toBe(0);
      } finally {
        await tab.close();
      }
    });

    test(`${width} px: a band keeps its height as a receipt`, async () => {
      const tab = await open(width, "de", "band");
      try {
        await settled(tab);
        const heights = await tab.evaluate(() => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>("article.cloud-approval-band"));
          const before = rows.map((row) => row.getBoundingClientRect().height);
          for (const row of rows) {
            const actions = row.querySelector<HTMLElement>(".cloud-approval__actions")!;
            actions.removeAttribute("inert");
            actions.innerHTML = '<span class="cloud-approval__receipt" data-outcome="approved"><i class="ti ti-check"></i>Approved</span>';
            row.dataset.decided = "true";
          }
          return { before, after: rows.map((row) => row.getBoundingClientRect().height) };
        });
        expect(heights.after).toEqual(heights.before);
      } finally {
        await tab.close();
      }
    });
  }

  test("390 px: the two answers share the row or each takes all of it", async () => {
    const tab = await open(390, "en", "list");
    try {
      await settled(tab);
      const widths = await tab.evaluate(() => {
        const row = document.querySelector<HTMLElement>("article.cloud-approval")!;
        const answers = Array.from(row.querySelectorAll<HTMLElement>(".k2b-chat-decision__answer")).map((node) =>
          node.getBoundingClientRect(),
        );
        return {
          row: row.querySelector(".k2b-chat-decision__answers")!.getBoundingClientRect().width,
          answers: answers.map((box) => box.width),
          top: answers.map((box) => box.top),
        };
      });
      // Either both share one row, or a long answer takes the whole row; never one narrow button beside a gap.
      if (widths.top[0] === widths.top[1]) expect(widths.answers[0]! + widths.answers[1]!).toBeGreaterThan(widths.row - 12);
      else for (const width of widths.answers) expect(width).toBeGreaterThan(widths.row - 1);
    } finally {
      await tab.close();
    }
  });
});

describe("Approvals in a browser", () => {
  const origin = "https://cloud.example.test";
  const live = async (width: number, items: PendingApproval[], decided: string[] = [], layout: "list" | "band" = "list") => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const tab = await context.newPage();
    await tab.route(`${origin}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/view")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body:
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
            `<body class="k2b-ui"><div id="root" style="padding:16px;max-width:48rem"></div><script src="/harness.js"></script></body></html>`,
        });
      if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
      if (pathname === "/tabler.css") return route.fulfill({ contentType: "text/css", body: icons.css });
      if (pathname === "/tabler.woff2") return route.fulfill({ path: icons.font });
      if (pathname === "/api/approvals") return route.fulfill({ json: { items, nextCursor: null, count: items.length, elsewhere: 0 } });
      if (pathname === "/api/approvals/counts") return route.fulfill({ json: { total: 0, apps: {} } });
      const decision = /^\/api\/approvals\/([^/]+)\/decision$/.exec(pathname)?.[1];
      if (decision) {
        decided.push(decision);
        return route.fulfill({ json: { status: route.request().postDataJSON().approved ? "approved" : "rejected" } });
      }
      return route.fulfill({ status: 404 });
    });
    await tab.goto(`${origin}/view?layout=${layout}`);
    await tab.evaluate(() => document.fonts.ready);
    return { tab, close: () => context.close() };
  };

  for (const width of [1280, 390]) {
    test(`${width} px: an answer collapses the card at once to its outcome line, after the answers armed`, async () => {
      const decided: string[] = [];
      const { tab, close } = await live(width, page.items, decided);
      try {
        const first = tab.locator("article.cloud-approval").first();
        await first.waitFor();
        const top = (await first.boundingBox())!.y;
        const confirm = first.locator(".k2b-chat-decision__answer").first();
        // The answers arm after half a second; a click before that does nothing.
        await confirm.click({ force: true });
        expect(decided).toEqual([]);
        await tab.waitForTimeout(600);
        await confirm.click();
        await tab.locator("article.cloud-approval[data-decided]").waitFor();
        expect(decided).toEqual([page.items[0]!.id]);
        expect(await first.locator(".k2b-chat-decision__card").count()).toBe(0);
        expect(await first.locator('.k2b-chat-outcome__text[data-current="true"]').textContent()).toContain("Approved.");
        expect(await tab.evaluate(() => document.activeElement?.classList.contains("k2b-chat-outcome"))).toBe(true);
        // The row keeps its place; only what follows moves up, by the answer the person gave.
        expect((await first.boundingBox())!.y).toBe(top);
      } finally {
        await close();
      }
    });

    test(`${width} px: Details on a band opens the same card in a panel and decides from there`, async () => {
      const decided: string[] = [];
      const { tab, close } = await live(width, page.items, decided, "band");
      try {
        const band = tab.locator("article.cloud-approval-band").nth(1);
        await band.waitFor();
        const before = (await band.boundingBox())!.height;
        await tab.waitForTimeout(600);
        await band.getByRole("button", { name: "Details" }).click();
        const panel = tab.getByRole("dialog");
        await panel.waitFor();
        expect(await panel.textContent()).toContain("This approval applies to exactly this Action.");
        expect(await panel.textContent()).toContain("If you have questions, reach out to Alex or to me directly.");
        expect(await panel.locator(".k2b-chat-decision__sentence").textContent()).toBe("Sends the draft after the undo window.");
        await panel.getByRole("button", { name: "Don't run", exact: true }).click();
        await tab.locator("article.cloud-approval-band[data-decided]").waitFor();
        expect(decided).toEqual([page.items[1]!.id]);
        expect(await tab.getByRole("dialog").count()).toBe(0);
        expect(await band.getAttribute("data-decided")).toBe("rejected");
        expect((await band.boundingBox())!.height).toBe(before);
      } finally {
        await close();
      }
    });
  }

  test("an empty list says nothing is waiting", async () => {
    const { tab, close } = await live(1280, []);
    try {
      await tab.getByText("Nothing is waiting for you.").waitFor();
    } finally {
      await close();
    }
  });
});
