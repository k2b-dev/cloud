import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { RemoteContentAllowRule } from "../../service/remote-content";
import type {} from "./MailMessageBody.browser-harness";

// The external-images row must keep one 48px height through every state, keep the focus, and open its menu as a
// sheet on phones. That needs real layout and the shipped styles, so the real message body runs in a browser.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailMessageBody.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-remote-images-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail remote images harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
// Over half of the reader's 25 MB budget, so the second image reaches the safe limit.
const LARGE = Buffer.alloc(13 * 1024 * 1024, 0);
LARGE.set(PNG);
const imageIds = Array.from({ length: 4 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
/** An invented newsletter from an invented shop. */
const newsletter = [
  '<div style="font-family:system-ui,sans-serif;color:#27272a">',
  `<img alt="Beispiel-Shop · Herbst-Sale" data-mail-remote-image="${imageIds[0]}" style="display:block;width:100%;height:132px;object-fit:cover;background:#f4f4f5;border-radius:6px">`,
  "<p>Hallo, unser Herbst-Sale startet heute. Alle Jacken, Schals und Mützen sind bis Sonntag um 30 % reduziert.</p>",
  '<table width="100%"><tr>',
  ...imageIds
    .slice(1)
    .map(
      (id) =>
        `<td><img alt="Angebot" data-mail-remote-image="${id}" style="display:block;width:100%;height:110px;background:#f4f4f5;border-radius:6px"></td>`,
    ),
  "</tr></table></div>",
].join("");
const SENDER = "newsletter@beispiel-shop.de";
const DOMAIN = "beispiel-shop.de";
const RULE: RemoteContentAllowRule = { id: "00000000-0000-4000-8000-0000000000aa", scope: "sender", value: SENDER };

type ImageMode = "ok" | "fail" | "large";
let imageMode: ImageMode = "ok";
/** Milliseconds each image waits, so the loading state stays visible. */
let imageDelay = 0;
const ruleCalls: string[] = [];
let imageRequests = 0;

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
// The icon font the row's tile, chevron, and menu icons draw with.
const iconsUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
const iconsSource = await Bun.file(fileURLToPath(iconsUrl)).text();
const iconFontAsset = /url\((\.\/[^)"']+\.woff2)[^)]*\)/u.exec(iconsSource)?.[1];
if (!iconFontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
const iconFont = await Bun.file(fileURLToPath(new URL(iconFontAsset, iconsUrl))).arrayBuffer();
const iconsCss = iconsSource.replace(/url\(\.\/[^)"']+\.woff2[^)]*\)/u, "url(/tabler.woff2)");
// Cloud's reading font, so text widths and truncation match the product.
const plexPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
const plexCss = (await Bun.file(plexPath).text()).replaceAll("./fonts/", "/fonts/");
/** Soft colour fields in place of real newsletter photos. */
const swatch = (from: string, to: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="160" fill="url(#g)"/></svg>`;
const swatches = [swatch("#fb923c", "#e11d48"), swatch("#fde68a", "#f59e0b"), swatch("#bae6fd", "#0ea5e9"), swatch("#bbf7d0", "#16a34a")];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (pathname === "/tabler.css") return new Response(iconsCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (pathname === "/tabler.woff2") return new Response(iconFont, { headers: { "Content-Type": "font/woff2" } });
    if (pathname === "/plex.css") return new Response(plexCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const font = /^\/fonts\/([\w.-]+\.woff2)$/u.exec(pathname)?.[1];
    if (font) return new Response(Bun.file(resolve(dirname(plexPath), "fonts", font)), { headers: { "Content-Type": "font/woff2" } });
    // A second message on the page always answers with small images.
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg002/remote-images/")) {
      return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    }
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg001/remote-images/")) {
      imageRequests += 1;
      if (imageDelay) await Bun.sleep(imageDelay);
      if (imageMode === "fail") return new Response("Upstream failed", { status: 502 });
      if (imageMode === "large") return new Response(LARGE, { headers: { "Content-Type": "image/png" } });
      const index = imageIds.indexOf(pathname.split("/").at(-1)!);
      return new Response(swatches[index] ?? PNG, { headers: { "Content-Type": "image/svg+xml" } });
    }
    if (pathname === "/api/mail/mailboxes/Box001/remote-content-rules" && request.method === "POST") {
      const input = (await request.json()) as { scope: "sender" | "domain"; value: string };
      ruleCalls.push(`create ${input.scope} ${input.value}`);
      return Response.json({
        id: "00000000-0000-4000-8000-0000000000bb",
        mailboxId: "Box001",
        ...input,
        createdAt: "2026-11-08T09:00:00.000Z",
      });
    }
    if (pathname === "/api/mail/mailboxes/Box001/remote-content-rules" && request.method === "GET") return Response.json([]);
    const removed = /^\/api\/mail\/mailboxes\/Box001\/remote-content-rules\/([\w-]+)$/u.exec(pathname)?.[1];
    if (removed && request.method === "DELETE") {
      ruleCalls.push(`delete ${removed}`);
      return Response.json({ id: removed });
    }
    return new Response(
      '<!doctype html><html class="light" lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css">' +
        // The reading pane: 760px beside the list at 1440, the full phone width with a 16px inset at 390.
        "<style>#pane{box-sizing:border-box;width:min(760px,100%);padding:12px 24px 24px}@media (max-width:47.99rem){#pane{padding:4px 16px 16px}}</style>" +
        '</head><body class="k2b-ui" style="margin:0;background:#fff"><main id="pane">' +
        '<h1 style="font-size:20px;font-weight:600;line-height:1.25;margin:8px 0 12px">Herbst-Sale: 30 % auf alles bis Sonntag</h1>' +
        `<p style="font-size:14px;margin:0 0 14px"><b>Beispiel-Shop</b> <span style="color:#45454e">&lt;${SENDER}&gt; · an mich</span></p>` +
        '<div id="root"></div></main><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const screens = [
  ["1440", desktop],
  ["390", phone],
] as const;

/** Screenshots for review land here when the variable is set; normal runs write nothing. */
const shots = process.env.MAIL_REMOTE_IMAGES_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  // A resting mouse would show hover underlines that a reader never sees at rest.
  await page.mouse.move(1, 899);
  await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: false });
};

type Remote = { allowRules?: RemoteContentAllowRule[]; sender?: string | null; domain?: string | null };
const open = async (context: BrowserContextOptions, remote: Remote = {}, locale = "de"): Promise<Page> => {
  const page = await (await browser.newContext({ ...context, locale })).newPage();
  await page.goto(server.url.href);
  await page.evaluate(
    ({ html, imageIds, remote, sender, domain, locale }) => {
      // Components read the page language when no provider sets one.
      document.documentElement.lang = locale;
      window.mountMailMessageBody({
        mailboxId: "Box001",
        messageId: "Msg001",
        format: "html",
        html,
        plainText: null,
        attachments: [],
        remoteContent: {
          imageIds,
          allowedByRule: (remote.allowRules ?? []).length > 0,
          allowRules: remote.allowRules ?? [],
          sender: remote.sender === undefined ? sender : remote.sender,
          domain: remote.domain === undefined ? domain : remote.domain,
        },
      });
    },
    { html: newsletter, imageIds, remote, sender: SENDER, domain: DOMAIN, locale },
  );
  await page.locator("section[data-remote-images]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};

/** Waits until the message frame shows `count` delivered images. */
const shownImages = async (page: Page, count: number) => {
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  await frame!.waitForFunction(
    (count) => Array.from(document.images).filter((image) => image.complete && image.naturalWidth > 0).length === count,
    count,
  );
};

const row = (page: Page) =>
  page.evaluate(() => {
    const section = document.querySelector<HTMLElement>("section[data-remote-images]")!;
    const box = section.lastElementChild!.getBoundingClientRect();
    const line = section.querySelector<HTMLElement>("p:not(.sr-only)")!;
    const text = line.getBoundingClientRect();
    return {
      kind: section.dataset.remoteImages,
      // The short phone wording fits without an ellipsis.
      fits: line.scrollWidth <= line.clientWidth,
      height: Math.round(box.height),
      top: Math.round(box.top),
      textLeft: Math.round(text.left - box.left),
      frameTop: Math.round(document.querySelector("iframe")!.getBoundingClientRect().top),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      announcement: section.querySelector(".sr-only")!.textContent,
      focused:
        document.activeElement?.textContent?.trim() ||
        document.activeElement?.getAttribute("aria-label") ||
        document.activeElement?.tagName,
    };
  });

const waitKind = (page: Page, kind: string) => page.locator(`section[data-remote-images="${kind}"]`).waitFor();

describe("Mail external images row", () => {
  for (const [width, context] of screens) {
    test(`at ${width}px every state keeps one 48px row and the message never moves`, async () => {
      imageMode = "ok";
      imageDelay = 400;
      const page = await open(context);
      try {
        const blocked = await row(page);
        expect(blocked).toMatchObject({ kind: "blocked", height: 48, overflow: false, fits: true });
        await shoot(page, `1-blockiert-${width}`);

        await page.getByRole("button", { name: width === "390" ? "Laden" : "Bilder laden" }).click();
        await waitKind(page, "loading");
        const loading = await row(page);
        expect(loading).toMatchObject({ height: 48, top: blocked.top, textLeft: blocked.textLeft, frameTop: blocked.frameTop, fits: true });
        expect(loading.announcement).toBe("Bilder werden geladen …");
        await shoot(page, `3-laedt-${width}`);

        await waitKind(page, "once");
        await settled(page);
        const once = await row(page);
        expect(once).toMatchObject({
          height: 48,
          top: blocked.top,
          textLeft: blocked.textLeft,
          frameTop: blocked.frameTop,
          overflow: false,
        });
        expect(once.announcement).toBe("Bilder geladen");
        // The focus moves to the same place, the row's control, instead of getting lost with the pressed button.
        expect(once.focused).toContain("Immer laden");
        await shoot(page, `4-einmal-geladen-${width}`);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("the blocked row reads in order: Load images, then the menu with its rules and the tracking note", async () => {
    imageMode = "ok";
    imageDelay = 0;
    const page = await open(desktop);
    try {
      await page.getByRole("button", { name: "Bilder laden" }).focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Weitere Optionen für externe Bilder");
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Weitere Optionen für externe Bilder" });
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        `Immer von ${SENDER}`,
        `Immer von allen bei ${DOMAIN}`,
        "Regeln für externe Bilder …",
      ]);
      expect(await page.locator(".k2b-dropdown__note").first().textContent()).toContain("IP-Adresse");
      await settled(page);
      await shoot(page, "2-menue-1440");
      await page.keyboard.press("Escape");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a phone opens the same choices as a sheet", async () => {
    const page = await open(phone);
    try {
      await page.getByRole("button", { name: "Weitere Optionen für externe Bilder" }).tap();
      const sheet = page.getByRole("dialog", { name: "Weitere Optionen für externe Bilder" }).last();
      await sheet.waitFor();
      // The trigger under the tap keeps fading its hover behind the scrim; only the sheet's own motion matters here.
      await sheet.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.timeline === document.timeline)
            .map((animation) => animation.finished),
        ),
      );
      expect(await sheet.getByRole("menuitem", { name: `Immer von ${SENDER}` }).isVisible()).toBe(true);
      expect(await sheet.textContent()).toContain("IP-Adresse");
      await shoot(page, "2-menue-390");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("always from the sender saves the rule, loads at once, and can be taken back from the quiet line", async () => {
    imageMode = "ok";
    imageDelay = 0;
    ruleCalls.length = 0;
    const page = await open(desktop);
    try {
      await page.getByRole("button", { name: "Weitere Optionen für externe Bilder" }).click();
      await page.getByRole("menuitem", { name: `Immer von ${SENDER}` }).click();
      await waitKind(page, "always");
      await settled(page);
      expect(ruleCalls).toEqual([`create sender ${SENDER}`]);
      const always = await row(page);
      expect(always.height).toBe(48);
      expect(await page.locator("section[data-remote-images]").textContent()).toContain(`Bilder von ${SENDER} werden immer geladen`);

      await page.getByRole("button", { name: "Ändern" }).click();
      const menu = page.getByRole("menu", { name: "Weitere Optionen für externe Bilder" });
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Nicht mehr automatisch laden", "Regeln für externe Bilder …"]);
      expect(await page.locator(".k2b-dropdown__note").first().textContent()).toBe(`Gilt durch die Regel „Absender: ${SENDER}“.`);
      await page.getByRole("menuitem", { name: "Nicht mehr automatisch laden" }).click();
      await waitKind(page, "once");
      await settled(page);
      expect(ruleCalls).toEqual([`create sender ${SENDER}`, "delete 00000000-0000-4000-8000-0000000000bb"]);
      const once = await row(page);
      expect(once).toMatchObject({
        height: 48,
        top: always.top,
        frameTop: always.frameTop,
        announcement: "Bilder werden nicht mehr automatisch geladen",
      });
      expect(once.focused).toContain("Immer laden");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [width, context] of screens) {
    test(`at ${width}px a rule from the server shows the quiet line from the start and revokes every matching rule`, async () => {
      imageMode = "ok";
      imageDelay = 0;
      ruleCalls.length = 0;
      const domainRule: RemoteContentAllowRule = { id: "00000000-0000-4000-8000-0000000000cc", scope: "domain", value: DOMAIN };
      const page = await open(context, { allowRules: [RULE, domainRule] });
      try {
        await waitKind(page, "always");
        await shownImages(page, imageIds.length);
        await settled(page);
        expect((await row(page)).height).toBe(48);
        const text = await page.locator("section[data-remote-images]").innerText();
        expect(text).toContain(width === "390" ? "Bilder werden immer geladen" : `Bilder von ${SENDER} werden immer geladen`);
        await (width === "390" ? page.getByRole("button", { name: "Ändern" }).tap() : page.getByRole("button", { name: "Ändern" }).click());
        const surface = width === "390" ? page.getByRole("dialog").last() : page.getByRole("menu");
        await surface.waitFor();
        await settled(page);
        expect(await surface.textContent()).toContain(`Gilt durch die Regeln „Absender: ${SENDER}“ und „Domain: ${DOMAIN}“.`);
        await shoot(page, `5-immer-erlaubt-${width}`);
        const stop = surface.getByRole("menuitem", { name: "Nicht mehr automatisch laden" });
        await (width === "390" ? stop.tap() : stop.click());
        await waitKind(page, "once");
        expect(ruleCalls.sort()).toEqual([`delete ${RULE.id}`, `delete ${domainRule.id}`]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  for (const [width, context] of screens) {
    test(`at ${width}px a failed load stays in the row with a retry that works`, async () => {
      imageMode = "fail";
      imageDelay = 0;
      const page = await open(context);
      try {
        const blocked = await row(page);
        await page.getByRole("button", { name: width === "390" ? "Laden" : "Bilder laden" }).click();
        await waitKind(page, "failed");
        await settled(page);
        const failed = await row(page);
        expect(failed).toMatchObject({ height: 48, top: blocked.top, frameTop: blocked.frameTop, overflow: false, fits: true });
        expect(await page.getByRole("alert").textContent()).toContain(
          width === "390" ? "Laden fehlgeschlagen" : "Bilder konnten nicht geladen werden",
        );
        expect(failed.focused).toContain(width === "390" ? "Erneut laden" : "Erneut versuchen");
        await shoot(page, `6-fehler-${width}`);
        imageMode = "ok";
        imageDelay = 300;
        await page.getByRole("button", { name: width === "390" ? "Erneut laden" : "Erneut versuchen" }).click();
        // A retry goes straight to loading and then hands the focus to the quiet line's control.
        await waitKind(page, "loading");
        await waitKind(page, "once");
        await settled(page);
        expect((await row(page)).focused).toContain("Immer laden");
      } finally {
        imageDelay = 0;
        await page.context().close();
      }
    }, 30_000);
  }

  test("a rule removed here never loads images again, also after the message body mounts again", async () => {
    imageMode = "ok";
    imageDelay = 0;
    const page = await open(desktop, { allowRules: [RULE] });
    try {
      await waitKind(page, "always");
      await shownImages(page, imageIds.length);
      await page.getByRole("button", { name: "Ändern" }).click();
      await page.getByRole("menuitem", { name: "Nicht mehr automatisch laden" }).click();
      await waitKind(page, "once");
      const requests = imageRequests;
      // The snapshot still lists the removed rule until the server sends a new one.
      await page.evaluate(() => window.remountMailMessageBody());
      await waitKind(page, "blocked");
      await Bun.sleep(500);
      expect(imageRequests).toBe(requests);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("removing another message's rule does not start a new load in a message that stays allowed", async () => {
    imageMode = "large";
    imageDelay = 0;
    const page = await open(desktop, { allowRules: [RULE] });
    try {
      await waitKind(page, "limited");
      const requests = imageRequests;
      const other: RemoteContentAllowRule = { id: "00000000-0000-4000-8000-0000000000dd", scope: "sender", value: "team@verein.example" };
      await page.evaluate(
        ({ html, imageIds, other }) =>
          window.mountMailMessageBody({
            mailboxId: "Box001",
            messageId: "Msg002",
            format: "html",
            html,
            plainText: null,
            attachments: [],
            remoteContent: { imageIds, allowedByRule: true, allowRules: [other], sender: other.value, domain: "verein.example" },
          }),
        { html: newsletter, imageIds, other },
      );
      const second = page.locator("section[data-remote-images]").nth(1);
      await page.locator('section[data-remote-images="always"]').waitFor();
      await second.getByRole("button", { name: "Ändern" }).click();
      await page.getByRole("menuitem", { name: "Nicht mehr automatisch laden" }).click();
      await page.locator('section[data-remote-images="once"]').waitFor();
      await Bun.sleep(500);
      expect(imageRequests).toBe(requests);
    } finally {
      imageMode = "ok";
      await page.context().close();
    }
  }, 60_000);

  test("a snapshot that no longer lists a rule saved here ends the always line", async () => {
    imageMode = "ok";
    imageDelay = 0;
    const page = await open(desktop);
    try {
      await page.getByRole("button", { name: "Weitere Optionen für externe Bilder" }).click();
      await page.getByRole("menuitem", { name: `Immer von ${SENDER}` }).click();
      await waitKind(page, "always");
      const saved = { id: "00000000-0000-4000-8000-0000000000bb", scope: "sender", value: SENDER } as const;
      const snapshot = (allowRules: RemoteContentAllowRule[]) =>
        page.evaluate(
          ({ allowRules, imageIds, sender, domain }) =>
            window.updateMailMessageBody({
              remoteContent: { imageIds, allowedByRule: allowRules.length > 0, allowRules, sender, domain },
            }),
          { allowRules, imageIds, sender: SENDER, domain: DOMAIN },
        );
      await snapshot([saved]);
      await waitKind(page, "always");
      // Removed elsewhere, such as in the rules dialog or another tab.
      await snapshot([]);
      await waitKind(page, "once");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [width, context] of screens) {
    test(`at ${width}px the size limit stays as a row without a button`, async () => {
      imageMode = "large";
      imageDelay = 0;
      const page = await open(context);
      try {
        const blocked = await row(page);
        await page.getByRole("button", { name: width === "390" ? "Laden" : "Bilder laden" }).click();
        await waitKind(page, "limited");
        await settled(page);
        const limited = await row(page);
        expect(limited).toMatchObject({ height: 48, top: blocked.top, frameTop: blocked.frameTop, overflow: false, fits: true });
        expect(limited.announcement).toBe("Einige Bilder nicht geladen. Die Nachricht ist größer als das sichere Limit.");
        expect(await page.locator("section[data-remote-images] button").count()).toBe(0);
        await shoot(page, `6b-limit-${width}`);
      } finally {
        imageMode = "ok";
        await page.context().close();
      }
    }, 60_000);
  }

  test("several senders get a plain Load images without the arrow", async () => {
    imageMode = "ok";
    const page = await open(desktop, { sender: null, domain: null });
    try {
      expect(await page.getByRole("button", { name: "Bilder laden" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Weitere Optionen für externe Bilder" }).count()).toBe(0);
      expect((await row(page)).height).toBe(48);
      await shoot(page, "7-mehrere-absender-1440");
      await page.getByRole("button", { name: "Bilder laden" }).click();
      await waitKind(page, "once");
      // Nothing to choose for several senders, so the quiet line has no menu.
      expect(await page.locator("section[data-remote-images] button").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Rules for external images opens the mailbox's rules dialog", async () => {
    const page = await open(desktop);
    try {
      await page.getByRole("button", { name: "Weitere Optionen für externe Bilder" }).click();
      await page.getByRole("menuitem", { name: "Regeln für externe Bilder …" }).click();
      await page.locator(".k2b-dialog[open]").waitFor();
      expect(await page.locator(".k2b-dialog[open]").textContent()).toContain("Externe Bilder");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("English names the row and its controls for screen readers", async () => {
    const page = await open(desktop, {}, "en");
    try {
      expect(await page.getByRole("region", { name: "External images" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Load images" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "More options for external images" }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
