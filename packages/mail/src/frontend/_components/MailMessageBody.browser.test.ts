import { afterAll, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import type { BrowserContextOptions, Frame, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { renderComposeContent } from "../../service/compose-renderer";
import { sanitizeIncomingMailHtml } from "../../service/message-hydration";
import type {} from "./MailMessageBody.browser-harness";
import type { MessageColors } from "./mail-message-presentation";

// A 1x1 PNG; natural width 1 proves the frame decoded delivered image bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const encodePng = (pixel: (x: number, y: number) => number[]) => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) rows.set(pixel(x, y), y * 65 + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
const square = (x: number, y: number) => x >= 4 && x < 12 && y >= 4 && y < 12;
const attachmentImages = new Map([
  ["logo", encodePng((x, y) => [0, 0, 0, square(x, y) ? 255 : 0])],
  ["photo", encodePng(() => [147, 197, 253, 255])],
  ["spacer", encodePng(() => [0, 0, 0, 0])],
  ["icon", encodePng((x, y) => [249, 115, 22, square(x, y) ? 255 : 0])],
]);
const remoteIds = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
const failingId = remoteIds[5]!;
const html = [
  "<p>Hello</p>",
  ...remoteIds.map((id, index) => `<p>Remote ${index}</p><img alt="remote-${index}" data-mail-remote-image="${id}">`),
  '<img alt="cid-0" src="cid:Logo%40Example.com"><img alt="cid-1" src="cid:banner@example.com">',
  // Quoted history inside a dark cell: the toggle must follow the cell's text color.
  '<table><tr><td style="background: #18181b; color: #fafafa"><blockquote type="cite"><p>Earlier message</p></blockquote></td></tr></table>',
].join("");

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
        name: "solid-mail-message-body-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail message body harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const imageHeaders = {
  "Content-Type": "image/png",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript" } });
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg001/remote-images/")) {
      return pathname.endsWith(failingId) ? new Response("Upstream failed", { status: 502 }) : new Response(PNG, { headers: imageHeaders });
    }
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg001/attachments/")) {
      return new Response(attachmentImages.get(pathname.split("/").at(-1)!) ?? PNG, { headers: imageHeaders });
    }
    const dark = searchParams.get("theme") === "dark";
    return new Response(
      `<!doctype html><html class="${dark ? "dark" : ""}"><head><style>
      .bg-white { background-color: white; }
      .bg-transparent, .dark [class~="dark:bg-transparent"] { background-color: transparent; }
    </style></head><body style="margin:0;${dark ? "background:#11151b;color:#f4f4f5" : "background:#ffffff;color:#18181b"}"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      {
        headers: { "Content-Type": "text/html" },
      },
    );
  },
});

afterAll(() => server.stop(true));

type OpenedMessage = { page: Page; frame: Frame; errors: string[] };

type OpenMessageOptions = {
  html?: string;
  attachments?: Parameters<Window["mountMailMessageBody"]>[0]["attachments"];
  theme?: "light" | "dark" | null;
  colors?: MessageColors;
  pageQuery?: string;
  colorScheme?: BrowserContextOptions["colorScheme"];
  reducedMotion?: BrowserContextOptions["reducedMotion"];
  hostMotion?: "reduced";
  viewport?: BrowserContextOptions["viewport"];
};

const withOpenedMessage = async (
  allowedByRule: boolean,
  run: (message: OpenedMessage) => Promise<void>,
  options: OpenMessageOptions = {},
): Promise<void> => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      colorScheme: options.colorScheme,
      reducedMotion: options.reducedMotion,
      viewport: options.viewport,
    });
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("502")) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href + (options.pageQuery ?? ""));
    if (options.hostMotion) await page.evaluate(() => document.documentElement.setAttribute("data-k2b-motion", "reduced"));
    await page.evaluate(
      ({ html, attachments, remoteIds, allowedByRule, theme, colors }) =>
        window.mountMailMessageBody({
          mailboxId: "Box001",
          messageId: "Msg001",
          format: "html",
          theme,
          colors,
          html,
          plainText: null,
          attachments,
          remoteContent: { imageIds: remoteIds, allowedByRule, sender: "sender@example.com", domain: "example.com" },
        }),
      {
        html: options.html ?? html,
        attachments: options.attachments ?? [
          { id: "Att001", contentId: "<logo@example.com>", contentType: "image/png", sizeBytes: 100 },
          { id: "Att002", contentId: "<Banner@example.com>", contentType: "image/png", sizeBytes: 100 },
        ],
        remoteIds,
        allowedByRule,
        theme: options.theme === undefined ? "light" : options.theme,
        colors: options.colors ?? "adapted",
      },
    );
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    if (!frame) throw new Error("Message frame did not load");
    await run({ page, frame, errors });
  } finally {
    await browser.close();
  }
};

const visibleImages = (frame: Frame, count: number) =>
  frame.waitForFunction(
    (count) => Array.from(document.images).filter((image) => image.complete && image.naturalWidth > 0).length === count,
    count,
  );

// The host's messages reach the frame in order. Reopening the quote through the
// same channel and seeing its toggle come back proves every earlier message ran.
const settleFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const target = document.querySelector("iframe")!.contentWindow!;
        const listener = (event: MessageEvent) => {
          if (event.source !== target || event.data?.type !== "quote") return;
          removeEventListener("message", listener);
          resolve();
        };
        addEventListener("message", listener);
        target.postMessage({ source: "cloud-mail-host", channel: "mail-message-Msg001", type: "quotes", value: [0] }, "*");
      }),
  );

const imageStates = (frame: Frame) =>
  frame.evaluate(() => Object.fromEntries(Array.from(document.images).map((image) => [image.alt, image.naturalWidth > 0])));

describe("HTML mail message frame", () => {
  test("follows the host's motion choice before and after the frame loads", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        const expectMotion = async (reduced: boolean) => {
          await frame.waitForFunction(
            (reduced) => (document.documentElement.getAttribute("data-k2b-motion") === "reduced") === reduced,
            reduced,
            { timeout: 5_000 },
          );
          const transitions = await frame.locator("details.mail-quoted-history > summary").evaluate((summary) => ({
            summary: getComputedStyle(summary).transitionDuration,
            chevron: getComputedStyle(summary.querySelector("svg")!).transitionDuration,
          }));
          expect(transitions).toEqual({ summary: reduced ? "0s" : "0.12s, 0.12s", chevron: reduced ? "0s" : "0.16s" });
        };
        await expectMotion(true);
        await page.evaluate(() => document.documentElement.removeAttribute("data-k2b-motion"));
        await expectMotion(false);
        await page.evaluate(() => document.documentElement.setAttribute("data-k2b-motion", "reduced"));
        await expectMotion(true);
        expect(errors).toEqual([]);
      },
      { reducedMotion: "no-preference", hostMotion: "reduced" },
    );
  }, 30_000);

  test("ignores a motion message sent by the frame to itself", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await settleFrame(page);
        await frame.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const received = (event: MessageEvent) => {
                if (event.source !== window || event.data?.type !== "motion") return;
                window.removeEventListener("message", received);
                resolve();
              };
              window.addEventListener("message", received);
              window.postMessage(
                { source: "cloud-mail-host", channel: "mail-message-Msg001", type: "motion", value: { reduced: true } },
                "*",
              );
            }),
        );
        expect(await frame.evaluate(() => document.documentElement.hasAttribute("data-k2b-motion"))).toBe(false);
        expect(
          await frame.locator("details.mail-quoted-history > summary > svg").evaluate((svg) => getComputedStyle(svg).transitionDuration),
        ).toBe("0.16s");
        expect(errors).toEqual([]);
      },
      { reducedMotion: "no-preference" },
    );
  }, 30_000);

  test("toggles quoted text with a chevron that keeps the toggle in place", async () => {
    await withOpenedMessage(false, async ({ frame, errors }) => {
      const summary = frame.locator("details.mail-quoted-history > summary");
      const state = () =>
        summary.evaluate((element) => {
          const visible = [...element.querySelectorAll(".mail-quoted-labels > span")].filter(
            (label) => getComputedStyle(label).visibility === "visible",
          );
          const box = element.getBoundingClientRect();
          return {
            open: (element.parentElement as HTMLDetailsElement).open,
            display: getComputedStyle(element).display,
            chevron: getComputedStyle(element.querySelector("svg")!).transform,
            label: visible.map((label) => label.textContent).join(""),
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        });

      const closed = await state();
      expect(closed).toMatchObject({ open: false, display: "inline-flex", chevron: "none", label: "Show quoted text" });

      await summary.click();
      const opened = await state();
      expect(opened).toMatchObject({ open: true, label: "Hide quoted text" });
      expect(opened.chevron).not.toBe("none");
      expect(opened.box).toEqual(closed.box);
      expect(await frame.getByText("Earlier message").isVisible()).toBeTrue();
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("draws the quote toggle in the text color around it", async () => {
    await withOpenedMessage(false, async ({ frame }) => {
      const summary = frame.locator("details.mail-quoted-history > summary");
      const colors = () =>
        summary.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "color-mix(in srgb, #fafafa 65%, transparent)";
          element.parentElement!.append(probe);
          const dimmed = getComputedStyle(probe).color;
          probe.remove();
          return { toggle: getComputedStyle(element).color, dimmed };
        });

      const resting = await colors();
      expect(resting.toggle).toBe(resting.dimmed);
      await summary.hover();
      await frame.waitForFunction(
        () => getComputedStyle(document.querySelector("details.mail-quoted-history > summary")!).color === "rgb(250, 250, 250)",
      );
    });
  }, 30_000);

  test("keeps opened quoted text open when the frame document reloads", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      await frame.locator("details.mail-quoted-history > summary").click();
      await page.waitForFunction(() => window.mailMessageBodyTrace.quoteToggles === 1);

      // Solid's list reconciliation can move a message article; a moved frame reloads its document.
      await page.evaluate(() => {
        const root = document.getElementById("root")!;
        root.append(root.firstElementChild!);
      });
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 2);
      const reloaded = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await reloaded.waitForFunction(() => document.querySelector<HTMLDetailsElement>("details.mail-quoted-history")?.open === true);
      await visibleImages(reloaded, 2);
      expect(await reloaded.getByText("Earlier message").isVisible()).toBeTrue();
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("follows a changed security verdict on the mounted message", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);

      await page.evaluate(() => window.updateMailMessageBody({ linksDisabled: true }));
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 2);
      const quarantined = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await settleFrame(page);
      expect(await quarantined.evaluate(() => document.querySelectorAll("img[src]").length)).toBe(0);
      expect(await page.getByRole("button", { name: "Load images" }).count()).toBe(0);

      await page.evaluate(() => window.updateMailMessageBody({ linksDisabled: false }));
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 3);
      const cleared = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await visibleImages(cleared, 2);
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("loads remote images once a sender rule arrives as a live update", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      await page.evaluate(
        (remoteIds) =>
          window.updateMailMessageBody({
            remoteContent: { imageIds: remoteIds, allowedByRule: true, sender: "sender@example.com", domain: "example.com" },
          }),
        remoteIds,
      );
      await visibleImages(frame, 7);
      expect((await page.evaluate(() => window.mailMessageBodyTrace)).loads).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("shows allowed remote and inline images without reloading the frame", async () => {
    await withOpenedMessage(true, async ({ page, frame, errors }) => {
      await visibleImages(frame, 7);
      // The failed image keeps the notice; wait until every remote request settled.
      await page.waitForSelector('button:has-text("Load images"):not([disabled])');
      const trace = await page.evaluate(() => window.mailMessageBodyTrace);

      expect(await imageStates(frame)).toEqual({
        "remote-0": true,
        "remote-1": true,
        "remote-2": true,
        "remote-3": true,
        "remote-4": true,
        "remote-5": false,
        "cid-0": true,
        "cid-1": true,
      });
      expect(trace.loads).toHaveLength(1);
      expect(trace.srcdocChanges).toBe(0);
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("keeps the frame document when blocked remote images are loaded on request", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      expect(await frame.evaluate(() => document.querySelectorAll("img[src]").length)).toBe(2);

      await page.getByRole("button", { name: "Load images" }).click();
      await visibleImages(frame, 7);
      await page.waitForSelector('button:has-text("Load images"):not([disabled])');
      const trace = await page.evaluate(() => window.mailMessageBodyTrace);

      expect((await imageStates(frame))["remote-5"]).toBeFalse();
      expect(trace.loads).toHaveLength(1);
      expect(trace.srcdocChanges).toBe(0);
      expect(errors).toEqual([]);
    });
  }, 30_000);
});

const newsletterAttachments = [...attachmentImages].map(([id, image]) => ({
  id,
  contentId: `<${id}@example.com>`,
  contentType: "image/png",
  sizeBytes: image.length,
}));
const newsletter = `
<table bgcolor="#f3f4f6"><tr><td>
  <table id="card" style="background:#ffffff;border:1px solid #e5e7eb"><tr><td>
    <img alt="logo" src="cid:Logo%40Example.com">
    <h1 style="color:#111827">Monthly news</h1>
    <p id="paragraph" style="color:#374151">The latest news. <a id="link" href="https://example.com" style="color:#2563eb">Read more</a></p>
    <p>Default text. <a href="https://example.com">Default link</a></p>
    <table><tr><td id="button" bgcolor="#2563eb"><a href="https://example.com" style="color:#ffffff">Open newsletter</a></td></tr></table>
    <p id="note" style="background:#fef3c7;color:#92400e">A useful note.</p>
    <p style="color:#6b7280">Newsletter footer</p>
    <div id="dark-block" style="background:#0f172a;color:#e2e8f0;border:1px solid #ffffff">Designed for dark mode. <a href="https://example.com" style="color:#a5b4fc">Details</a></div>
    <img alt="photo" src="cid:photo@example.com">
    <img alt="spacer" src="cid:spacer@example.com">
    <img alt="icon" src="cid:icon@example.com">
    <img alt="blocked" data-mail-remote-image="${remoteIds[0]}" width="120" height="40">
  </td></tr></table>
</td></tr></table>`;

const waitForMode = (frame: Frame, dark: boolean) =>
  frame.waitForFunction((dark) => document.documentElement.classList.contains("mail-dark") === dark, dark);

const assertAdaptedContrast = async (frame: Frame) => {
  const failures = await frame.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const colors = new Map<string, number[]>();
    const parse = (color: string) => {
      if (!colors.has(color)) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        colors.set(color, [...context.getImageData(0, 0, 1, 1).data]);
      }
      return colors.get(color)!;
    };
    const luminance = (color: number[]) => {
      const [r, g, b] = color.slice(0, 3).map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
    };
    return [...document.querySelectorAll("#mail-message-root *")].flatMap((element) => {
      if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return [];
      const layers: number[][] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const computed = getComputedStyle(ancestor);
        if (computed.backgroundImage !== "none") return [];
        const color = parse(computed.backgroundColor);
        if (color[3]! > 0) layers.push(color);
        if (color[3] === 255) break;
      }
      const background = layers.reverse().reduce((below, layer) => {
        const alpha = layer[3]! / 255;
        return below.map((value, index) => (index < 3 ? value * (1 - alpha) + layer[index]! * alpha : 255));
      }, parse("#11151b"));
      const text = parse(getComputedStyle(element).color);
      const alpha = text[3]! / 255;
      const foreground = background.map((value, index) => (index < 3 ? value * (1 - alpha) + text[index]! * alpha : 255));
      const first = luminance(foreground),
        second = luminance(background);
      const contrast = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      return contrast >= 4.5 ? [] : [{ text: element.textContent, foreground, background, contrast }];
    });
  });
  expect(failures).toEqual([]);
};

const assertOriginalColors = async (page: Page, frame: Frame) => {
  await waitForMode(frame, false);
  expect(await frame.locator("#card").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(await frame.locator("#paragraph").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(55, 65, 81)");
  expect(await frame.locator("#link").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(37, 99, 235)");
  expect(await frame.locator("#card").getAttribute("style")).toBe("background:#ffffff;border:1px solid #e5e7eb");
  expect(await frame.locator('img[alt="logo"]').getAttribute("style")).toBeNull();
  expect(
    await frame.locator("img").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor)),
  ).toEqual(Array(5).fill("rgba(0, 0, 0, 0)"));
  expect(await page.locator("iframe").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
};

const assertNoReload = async (page: Page) => {
  const trace = await page.evaluate(() => window.mailMessageBodyTrace);
  expect(trace.srcdocChanges).toBe(0);
  expect(trace.loads).toHaveLength(1);
};

const updateTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.body.style.backgroundColor = theme === "dark" ? "#11151b" : "#ffffff";
    document.body.style.color = theme === "dark" ? "#f4f4f5" : "#18181b";
    window.updateMailMessageBody({ theme });
  }, theme);

describe("HTML mail colors", () => {
  test("keeps text readable over gradients and translucent fills and restores original styles", async () => {
    const content = `
<div id="dark-gradient" style="background:linear-gradient(#111111,#111111);color:#ffffff">Dark gradient</div>
<div id="light-gradient" style="background-image:linear-gradient(#fef3c7,#fef3c7)"><span id="gradient-text">Default text</span> <a id="gradient-link" href="https://example.com">Default link</a></div>
<div id="gray" style="background:#999999">Default text <a id="gray-link" href="https://example.com">Default link</a></div>
<div id="outer-gray" style="background:#999999">Outer text<div id="inner-white" style="background:#ffffff">Inner text</div></div>
<div id="translucent-gray" style="background:rgba(153,153,153,.9);color:#000000">Translucent gray</div>
<div id="nested-gray" style="background:#999999"><div id="translucent-black" style="background:rgba(0,0,0,.8);color:#ffffff">Nested translucent black</div></div>
<div id="clear-gradient" style="background:linear-gradient(rgba(255,255,255,.2),rgba(255,255,255,.2))"><span id="clear-gradient-text">Clear gradient</span></div>
<div id="fade-gradient" style="background:linear-gradient(transparent,rgba(255,255,255,.1));color:#18181b">Fade gradient</div>
<p id="translucent-text" style="color:rgba(0,0,195,.6)">Translucent text</p>
<div style="background:linear-gradient(#ffffff,#ffffff)"><div id="panel" style="background:rgba(255,255,255,.9);color:#000000">Panel text</div><div id="panel-default" style="background:rgba(255,255,255,.95)">Panel default</div></div>
<div style="background:linear-gradient(#111111,#111111)"><div id="nested-clear-gradient" style="background:linear-gradient(transparent,transparent);color:#ffffff">Nested gradient</div></div>`;
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await waitForMode(frame, false);
        const originalStyles = await frame
          .locator("[id]")
          .evaluateAll((elements) => elements.map((element) => [element.id, element.getAttribute("style")]));
        await updateTheme(page, "dark");
        await waitForMode(frame, true);
        expect(await frame.locator("#dark-gradient").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(255, 255, 255)");
        expect(await frame.locator("#gradient-text").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(24, 24, 27)");
        expect(await frame.locator("#gradient-link").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(22, 119, 200)");
        // A gradient keeps the light surface it was designed on, also when it is translucent.
        for (const id of ["#light-gradient", "#clear-gradient", "#fade-gradient"]) {
          expect(await frame.locator(id).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
        }
        expect(await frame.locator("#clear-gradient-text").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(24, 24, 27)");
        // Translucent panels on a gradient keep their authored light fill and text.
        expect(
          await frame.locator("#panel").evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]),
        ).toEqual(["rgba(255, 255, 255, 0.9)", "rgb(0, 0, 0)"]);
        expect(await frame.locator("#panel-default").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(24, 24, 27)");
        expect(
          await frame
            .locator("#nested-clear-gradient")
            .evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]),
        ).toEqual(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]);
        await assertAdaptedContrast(frame);
        await updateTheme(page, "light");
        await waitForMode(frame, false);
        expect(
          await frame.locator("[id]").evaluateAll((elements) => elements.map((element) => [element.id, element.getAttribute("style")])),
        ).toEqual(originalStyles);
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: content, theme: "light", colors: "adapted" },
    );
  }, 30_000);

  test("adds a logo plate when switching to dark after images load in light", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await waitForMode(frame, false);
        await visibleImages(frame, 4);
        expect(await frame.locator('img[alt="logo"]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          "rgba(0, 0, 0, 0)",
        );
        await updateTheme(page, "dark");
        await waitForMode(frame, true);
        expect(
          await frame
            .locator("img")
            .evaluateAll((elements) =>
              Object.fromEntries(elements.map((element) => [element.getAttribute("alt"), getComputedStyle(element).backgroundColor])),
            ),
        ).toEqual({
          logo: "rgb(255, 255, 255)",
          photo: "rgba(0, 0, 0, 0)",
          spacer: "rgba(0, 0, 0, 0)",
          icon: "rgba(0, 0, 0, 0)",
          blocked: "rgba(0, 0, 0, 0)",
        });
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: newsletter, attachments: newsletterAttachments, theme: "light", colors: "adapted" },
    );
  }, 30_000);

  test("adapts newsletter colors for contrast and preserves dark designs and images", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await waitForMode(frame, true);
        await visibleImages(frame, 4);
        await assertAdaptedContrast(frame);
        expect(await frame.locator("#button").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(37, 99, 235)");
        expect(await frame.locator("#button a").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(255, 255, 255)");
        expect(
          await frame.locator("#dark-block").evaluate((element) => {
            const computed = getComputedStyle(element);
            return { background: computed.backgroundColor, color: computed.color, border: computed.borderTopColor };
          }),
        ).toEqual({ background: "rgb(15, 23, 42)", color: "rgb(226, 232, 240)", border: "rgb(255, 255, 255)" });
        // A light card's separator darkens with the card instead of turning into a bright outline.
        expect(await frame.locator("#card").evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe("rgb(229, 231, 235)");
        expect(await frame.locator("img").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).filter))).toEqual(
          Array(5).fill("none"),
        );
        expect(
          await frame
            .locator("img")
            .evaluateAll((elements) =>
              Object.fromEntries(elements.map((element) => [element.getAttribute("alt"), getComputedStyle(element).backgroundColor])),
            ),
        ).toEqual({
          logo: "rgb(255, 255, 255)",
          photo: "rgba(0, 0, 0, 0)",
          spacer: "rgba(0, 0, 0, 0)",
          icon: "rgba(0, 0, 0, 0)",
          blocked: "rgba(0, 0, 0, 0)",
        });
        expect(await frame.locator('img[alt="blocked"]').getAttribute("src")).toBeNull();
        expect(await page.locator("iframe").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: newsletter, attachments: newsletterAttachments, theme: "dark", colors: "adapted", pageQuery: "?theme=dark" },
    );
  }, 30_000);

  for (const variant of [
    { theme: "light", colors: "adapted" },
    { theme: "dark", colors: "original" },
  ] as const) {
    test(`${variant.theme} with ${variant.colors} colors preserves the original document`, async () => {
      await withOpenedMessage(
        false,
        async ({ page, frame, errors }) => {
          await visibleImages(frame, 4);
          await assertOriginalColors(page, frame);
          expect(errors).toEqual([]);
        },
        { html: newsletter, attachments: newsletterAttachments, ...variant, pageQuery: variant.theme === "dark" ? "?theme=dark" : "" },
      );
    }, 30_000);
  }

  test("switches themes and original colors without replacing srcdoc or reloading", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await visibleImages(frame, 4);
        await assertOriginalColors(page, frame);
        await assertNoReload(page);
        await updateTheme(page, "dark");
        await waitForMode(frame, true);
        await assertAdaptedContrast(frame);
        await assertNoReload(page);
        await page.evaluate(() => window.updateMailMessageBody({ colors: "original" }));
        await assertOriginalColors(page, frame);
        await assertNoReload(page);
        await page.evaluate(() => window.updateMailMessageBody({ colors: "adapted" }));
        await waitForMode(frame, true);
        await assertAdaptedContrast(frame);
        await updateTheme(page, "light");
        await assertOriginalColors(page, frame);
        await updateTheme(page, "dark");
        await waitForMode(frame, true);
        expect(await frame.locator('img[alt="logo"]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          "rgb(255, 255, 255)",
        );
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: newsletter, attachments: newsletterAttachments },
    );
  }, 30_000);

  test("resolves auto from the device scheme before the host knows its theme", async () => {
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await waitForMode(frame, true);
        await visibleImages(frame, 4);
        await assertAdaptedContrast(frame);
        expect(await page.locator("iframe").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        await updateTheme(page, "light");
        await assertOriginalColors(page, frame);
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: newsletter, attachments: newsletterAttachments, theme: null, pageQuery: "?theme=dark", colorScheme: "dark" },
    );
  }, 30_000);

  test("keeps colors that follow the text color in step with the adapted text", async () => {
    const content = `<p id="reply">Reply</p><blockquote type="cite"><p id="quoted">Earlier message</p></blockquote>
<div id="plain-border" style="border:1px solid">Plain border</div>
<a id="underlined" href="https://example.com" style="color:#111111;text-decoration:underline;text-decoration-color:#000000">Underlined</a>
<p id="embossed" style="color:#333333;text-shadow:0 1px 0 #ffffff">Embossed</p>
<del id="withdrawn" style="color:#000000;text-decoration-color:#000000">Withdrawn offer</del>
<div style="color:#1f2937"><p id="authored-reply">Authored reply</p><blockquote type="cite"><p id="authored-quoted">Authored quote</p></blockquote></div>`;
    await withOpenedMessage(
      false,
      async ({ page, frame, errors }) => {
        await waitForMode(frame, false);
        const lightStyles = await frame
          .locator("[id]")
          .evaluateAll((elements) => elements.map((element) => [element.id, element.getAttribute("style")]));
        await updateTheme(page, "dark");
        await waitForMode(frame, true);
        // A fresh quote part shows what the frame's own rule gives with the adapted text.
        const quoteColors = () =>
          frame.evaluate(() => {
            const details = document.querySelector("details.mail-quoted-history")!;
            const fresh = document.createElement("blockquote");
            details.append(fresh);
            const expected = { color: getComputedStyle(fresh).color, border: getComputedStyle(fresh).borderLeftColor };
            fresh.remove();
            const quote = getComputedStyle(details.querySelector("blockquote")!);
            return {
              expected,
              quote: quote.color,
              quoted: getComputedStyle(document.querySelector("#quoted")!).color,
              border: quote.borderLeftColor,
              toggle: getComputedStyle(details.querySelector("summary")!).color,
            };
          });
        const dark = await quoteColors();
        expect(dark.quote).toBe(dark.expected.color);
        expect(dark.quoted).toBe(dark.expected.color);
        expect(dark.border).toBe(dark.expected.border);
        expect(dark.quote).not.toBe(await frame.locator("#reply").evaluate((element) => getComputedStyle(element).color));
        // The toggle eases its color, so it reaches the dimmed text color after its transition.
        await frame.waitForFunction(
          (expected) => getComputedStyle(document.querySelector("details.mail-quoted-history > summary")!).color === expected,
          dark.expected.color,
        );
        const followers = await frame.evaluate(() => {
          const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
          return {
            border: style("#plain-border").borderTopColor,
            text: style("#plain-border").color,
            underline: style("#underlined").textDecorationColor,
            shadow: style("#embossed").textShadow,
            withdrawn: [style("#withdrawn").color, style("#withdrawn").textDecorationColor],
          };
        });
        expect(followers.border).toBe(followers.text);
        expect(followers.underline).toBe("rgb(255, 255, 255)");
        expect(followers.shadow).toBe("none");
        expect(followers.withdrawn[1]).toBe(followers.withdrawn[0]!);
        expect(followers.withdrawn[0]).not.toBe("rgb(0, 0, 0)");
        // Under a sender color the quote is dimmed from the adapted color, and its toggle still lights up on hover.
        const authoredReply = await frame.locator("#authored-reply").evaluate((element) => getComputedStyle(element).color);
        expect(authoredReply).toMatch(/^rgb\(/);
        expect(await frame.locator("#authored-quoted").evaluate((element) => getComputedStyle(element).color)).toBe(
          authoredReply.replace("rgb(", "rgba(").replace(")", ", 0.65)"),
        );
        const authoredToggle = frame.locator("details.mail-quoted-history").nth(1).locator("summary");
        await frame.waitForFunction(
          (expected) =>
            getComputedStyle(document.querySelectorAll("details.mail-quoted-history > summary .mail-quoted-show")[1]!).color === expected,
          authoredReply.replace("rgb(", "rgba(").replace(")", ", 0.65)"),
        );
        await authoredToggle.hover();
        await frame.waitForFunction(
          (expected) =>
            getComputedStyle(document.querySelectorAll("details.mail-quoted-history > summary .mail-quoted-show")[1]!).color === expected,
          authoredReply,
        );
        await assertAdaptedContrast(frame);
        await updateTheme(page, "light");
        await waitForMode(frame, false);
        expect(
          await frame.locator("[id]").evaluateAll((elements) => elements.map((element) => [element.id, element.getAttribute("style")])),
        ).toEqual(lightStyles);
        const light = await quoteColors();
        expect(light.quote).toBe(light.expected.color);
        expect(light.border).toBe(light.expected.border);
        expect(light.quote).not.toBe(dark.quote);
        await assertNoReload(page);
        expect(errors).toEqual([]);
      },
      { html: content, theme: "light", colors: "adapted" },
    );
  }, 30_000);

  test("keeps background images and readable author colors on their original surface", async () => {
    const content = `<style>a { color: #374151; }</style><div style="background:#fef3c7"><div id="gradient" style="background-image:linear-gradient(#fef3c7,#fef3c7);color:#374151"><p>Readable text <a href="https://example.com">Author link</a></p></div></div>`;
    await withOpenedMessage(
      false,
      async ({ frame, errors }) => {
        await waitForMode(frame, true);
        const gradient = await frame.locator("#gradient").evaluate((element) => {
          const computed = getComputedStyle(element);
          return { image: computed.backgroundImage, color: computed.color, background: computed.backgroundColor };
        });
        expect(gradient.image).toContain("linear-gradient");
        expect(gradient.color).toBe("rgb(55, 65, 81)");
        expect(gradient.background).toBe("rgb(254, 243, 199)");
        expect(await frame.locator("a").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(55, 65, 81)");
        expect(errors).toEqual([]);
      },
      { html: content, theme: "dark", pageQuery: "?theme=dark" },
    );
  }, 30_000);
});

describe("HTML mail from Cloud's Markdown composer", () => {
  test("keeps each extra blank line one text line tall in a received copy", async () => {
    const rendered = renderComposeContent({
      body: "Hello Grace,\n\nthe garden plan is ready.\n\n\nWe meet on Friday.\n\n\n\nSee you soon,\nAda",
      format: "markdown",
      customCss: "",
      renderLiquid: false,
      context: {
        actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
        mailbox: { name: "Example Team", description: "" },
        sender: { display_name: "Example Team", email: "team@example.test", reply_to: "" },
        message: { subject: "Garden", to: ["grace@example.test"], cc: [] },
      },
    });
    if (!rendered.ok || !rendered.data.html) throw new Error("The message did not render");
    const received = sanitizeIncomingMailHtml(rendered.data.html);
    await withOpenedMessage(
      false,
      async ({ frame, errors }) => {
        await frame.getByText("We meet on Friday.").waitFor();
        const layout = await frame.evaluate(() => {
          const paragraphs = Array.from(document.querySelectorAll("p")).filter((element) => element.textContent?.trim());
          const blanks = Array.from(document.querySelectorAll("p")).filter((element) => !element.textContent?.trim());
          return {
            paragraphs: paragraphs
              .map((element) => element.getBoundingClientRect())
              .map((rect) => ({ top: rect.top, bottom: rect.bottom })),
            blanks: blanks.map((element) => element.getBoundingClientRect().height),
          };
        });
        expect(layout.paragraphs).toHaveLength(4);
        expect(layout.blanks).toHaveLength(3);
        const line = layout.paragraphs[0]!.bottom - layout.paragraphs[0]!.top;
        for (const height of layout.blanks) expect(Math.abs(height - line)).toBeLessThan(0.5);
        const gap = (index: number) => layout.paragraphs[index + 1]!.top - layout.paragraphs[index]!.bottom;
        expect(Math.abs(gap(1) - gap(0) - line)).toBeLessThan(0.5);
        expect(Math.abs(gap(2) - gap(0) - 2 * line)).toBeLessThan(0.5);
        expect(errors).toEqual([]);
      },
      { html: received, attachments: [] },
    );
  }, 30_000);
});

describe("HTML mail with Markdown dividers", () => {
  for (const [label, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 375, height: 812 }],
  ] as const) {
    test(`keeps two full-width 1px dividers with paragraph spacing on ${label}`, async () => {
      const rendered = renderComposeContent({
        body: "Hello Grace,\n\nthe garden plan is ready.\n\n---\n\nWe meet on Friday.\nSee you soon\n---\nAda",
        format: "markdown",
        customCss: "",
        renderLiquid: false,
        context: {
          actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
          mailbox: { name: "Example Team", description: "" },
          sender: { display_name: "Example Team", email: "team@example.test", reply_to: "" },
          message: { subject: "Garden", to: ["grace@example.test"], cc: [] },
        },
      });
      if (!rendered.ok || !rendered.data.html) throw new Error("The divider message did not render");
      const received = sanitizeIncomingMailHtml(rendered.data.html);
      await withOpenedMessage(
        false,
        async ({ frame, errors }) => {
          await frame.getByText("Ada", { exact: true }).waitFor();
          const dividers = await frame.locator("hr").evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect();
              const before = element.previousElementSibling;
              const after = element.nextElementSibling;
              if (before?.tagName !== "P" || after?.tagName !== "P") throw new Error("Divider needs neighboring paragraphs");
              const previous = before.getBoundingClientRect();
              const next = after.getBoundingClientRect();
              return {
                height: rect.height,
                width: rect.width,
                paragraphWidth: previous.width,
                nextWidth: next.width,
                above: rect.top - previous.bottom,
                below: next.top - rect.bottom,
              };
            }),
          );
          expect(dividers).toHaveLength(2);
          for (const divider of dividers) {
            expect(divider.height).toBeGreaterThanOrEqual(0.5);
            expect(divider.height).toBeLessThanOrEqual(1.5);
            expect(Math.abs(divider.width - divider.paragraphWidth)).toBeLessThanOrEqual(1);
            expect(Math.abs(divider.width - divider.nextWidth)).toBeLessThanOrEqual(1);
            expect(divider.above).toBeGreaterThanOrEqual(8);
            expect(divider.below).toBeGreaterThanOrEqual(8);
          }
          expect(errors).toEqual([]);
        },
        { html: received, attachments: [], viewport },
      );
    }, 30_000);
  }
});
