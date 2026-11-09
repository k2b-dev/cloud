import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../../../../../ui/test/browser";
import type { DetailPanelHarness } from "./detail-panel.browser-harness";

// Each fixture types its browser window locally; other harnesses use the same property.
declare const window: { harness: DetailPanelHarness };

const activityPage = {
  data: ["note.edited", "comment.created", "note.restored", "note.edited", "note.created"].map((action, index) => ({
    id: `activity-${index}`,
    actor: { kind: "user", id: "00000000-0000-4000-8000-000000000002", displayName: "Jana Berger", avatarHash: "h1" },
    action,
    metadata: { commentId: "m11" },
    occurrenceCount: 1,
    lastOccurredAt: "2026-10-16T19:18:00.000Z",
  })),
  nextCursor: null,
};
const accessMembers = [
  { principal: { type: "group", groupId: "00000000-0000-4000-8000-0000000000a1" }, permission: "write", displayName: "Lager-Team" },
  ...(
    [
      ["00000000-0000-4000-8000-000000000002", "Jana Berger", "admin"],
      ["00000000-0000-4000-8000-000000000001", "Anna Becker", "admin"],
      ["00000000-0000-4000-8000-000000000004", "Mira Schulz", "write"],
      ["00000000-0000-4000-8000-000000000003", "Paul Wagner", "read"],
      ["00000000-0000-4000-8000-000000000005", "Tom Krüger", "write"],
    ] as const
  ).map(([userId, displayName, permission]) => ({
    principal: { type: "user", userId },
    permission,
    displayName,
    // One picture and initials for the others, so the access list shows both avatar forms.
    avatarHash: displayName === "Jana Berger" ? "h1" : null,
  })),
  { principal: { type: "authenticated" }, permission: "read" },
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "detail-panel.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    // The PDF dialog includes MapLibre's import.meta worker URLs.
    format: "esm",
    plugins: [
      {
        name: "solid-detail-panel-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail-panel harness.");
  const bundle = await build.outputs[0]!.text();
  // Use the shipped page-head order and cascade, including the responsive switch rule.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")].map(
      async (entry) => {
        const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
        return build.outputs[0]!.text();
      },
    ),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/notebooks/overview/activity") return Response.json(activityPage);
      if (path === "/api/notebooks/book01/access/members") return Response.json(accessMembers);
      if (/^\/api\/accounts\/users\/[^/]+\/avatar$/.test(path))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#247b92"/><circle cx="12" cy="9" r="4" fill="#fff"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(path)) return new Response(Bun.file(resolve(ui, "dist", path.slice(1))));
      if (path.startsWith("/api/")) return new Response("Unexpected harness API", { status: 404 });
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
};
const open = async (width: number, delayActivity = false, state = "many") => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  try {
    await page.clock.setFixedTime(new Date("2026-10-16T19:30:00.000Z"));
    if (delayActivity)
      await page.route("**/api/notebooks/overview/activity?*", async (route) => {
        requested();
        await gate;
        if (!page.isClosed()) await route.continue();
      });
    await page.goto(`${server.url}?state=${state}`);
    await page.waitForFunction(() => Boolean(window.harness));
    if (delayActivity) await request;
    else await page.locator(".notebook-activity-skeleton").first().waitFor({ state: "detached" });
    await settle(page);
    return { page, release };
  } catch (error) {
    release();
    await page.close();
    throw error;
  }
};
const box = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
const closeTo = (actual: number, expected: number, tolerance = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const sameBox = (actual: Awaited<ReturnType<typeof box>>, expected: Awaited<ReturnType<typeof box>>) => {
  for (const key of ["x", "y", "width", "height"] as const) closeTo(actual[key], expected[key], 0.5);
};
const header = ".k2b-discussion > .k2b-section__header";
/** A panel section by its title, open or closed. */
const titled = (title: string) => `section.k2b-section:has(.k2b-section__title:text-is("${title}"))`;
const access = titled("Zugriff");
const presence = "section.k2b-section:has(.k2b-detail-presence)";
const contents = 'section.k2b-section:has(.k2b-section__title:text-is("Inhalt"))';

for (const width of [1440, 390]) {
  test(`${width}: every section's content starts on its title's text edge`, async () => {
    const { page } = await open(width);
    try {
      await page.evaluate(() => window.harness.presence(3));
      // Closed sections under "Mehr zu dieser Notiz" open, so their rows count too.
      for (const name of [/^Zugriff/, /^Eigenschaften/, /^Aktivität/, /^Referenzen/])
        await page
          .getByRole("button", { name, expanded: false })
          .first()
          .evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
      await page.locator(`${access} .k2b-detail-panel__row`, { hasText: "Lager-Team" }).waitFor();
      await settle(page);
      const edges = await page.evaluate(() => {
        const visible = (element: Element) => element.getBoundingClientRect().width > 0 && element.getClientRects().length > 0;
        const titles = [...document.querySelectorAll(".k2b-detail-panel__body .k2b-section__title")]
          .filter(visible)
          .map((element) => ({ label: element.textContent, x: element.getBoundingClientRect().left }));
        // Ink is what a person sees: text, icons and their filled tiles, avatars, images, bars. Hover fills and
        // paddings do not count.
        const inkLeft = (root: Element) => {
          let left = Number.POSITIVE_INFINITY;
          for (const element of root.querySelectorAll(
            "i, .k2b-icon-tile, .k2b-avatar, img, svg, [role='progressbar'], .k2b-detail-tag, .k2b-detail-presence__swatch",
          ))
            if (visible(element)) left = Math.min(left, element.getBoundingClientRect().left);
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            if (!node.textContent?.trim() || !node.parentElement || !visible(node.parentElement)) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            if (rect.width > 0) left = Math.min(left, rect.left);
          }
          return left;
        };
        const bodies = [...document.querySelectorAll(".k2b-detail-panel__body .k2b-section__body")]
          .filter((body) => visible(body) && !body.closest("[hidden]"))
          .map((body) => ({
            label: body.closest("section")?.querySelector(".k2b-section__title")?.textContent ?? "",
            x: inkLeft(body),
          }))
          .filter((body) => Number.isFinite(body.x));
        // Each row on its own, so one row stepping in or back is not hidden by another on the edge.
        const rows = [
          ...document.querySelectorAll(
            ".k2b-detail-panel__body .k2b-section__body :is(.k2b-detail-panel__action:not(.notebook-outline-row:not([data-depth='0'])), .k2b-detail-panel__row, .k2b-discussion__item, .k2b-file-grid__item, .k2b-detail-section-label, .k2b-detail-tags > li:first-child, .k2b-detail-properties dt, .k2b-detail-presence__strip, .k2b-detail-presence__where)",
          ),
        ]
          .filter((row) => visible(row) && !row.closest("[hidden]"))
          .map((row) => ({ label: row.textContent?.trim().slice(0, 30) ?? "", x: inkLeft(row) }))
          .filter((row) => Number.isFinite(row.x));
        const right = [
          ...document.querySelectorAll(
            ".k2b-discussion__timestamp, .notebook-activity .notebook-time time, .k2b-section__actions .k2b-button",
          ),
        ]
          .filter(visible)
          .map((element) => {
            // Compare label ink, excluding a control's padding and icon column.
            const range = document.createRange();
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let last: Text | null = null;
            // The last painted text: a tooltip's hidden content inside the element does not count.
            while (walker.nextNode())
              if (walker.currentNode.textContent?.trim() && (walker.currentNode.parentElement?.getClientRects().length ?? 0) > 0)
                last = walker.currentNode as Text;
            if (!last) throw new Error(`No label text: ${element.outerHTML}`);
            range.setStart(last, 0);
            range.setEnd(last, last.length - (last.textContent?.match(/\s*$/)?.[0].length ?? 0));
            return { label: element.textContent, x: range.getBoundingClientRect().right };
          });
        return { titles, bodies, rows, right };
      });
      const edge = edges.titles[0]!.x;
      expect(edges.titles.length).toBeGreaterThan(9);
      expect(edges.titles.filter((title) => Math.abs(title.x - edge) > 1).map((title) => title.label)).toEqual([]);
      // Presence, comments, tasks, contents, tags, links, attachments, references, access, properties, activity.
      expect(edges.bodies.length).toBeGreaterThanOrEqual(10);
      expect(edges.bodies.filter((body) => Math.abs(body.x - edge) > 1).map((body) => `${body.label}: ${body.x - edge}`)).toEqual([]);
      expect(edges.rows.length).toBeGreaterThan(30);
      expect(edges.rows.filter((row) => Math.abs(row.x - edge) > 1).map((row) => `${row.label}: ${row.x - edge}`)).toEqual([]);
      expect(edges.right.length).toBeGreaterThan(8);
      for (const right of edges.right) closeTo(right.x, edges.right[0]!.x, 2);
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`${width}: every avatar in the panel is round, pictures and initials alike`, async () => {
    const { page } = await open(width);
    try {
      await page.evaluate(() => window.harness.presence(5));
      for (const name of [/^Zugriff/, /^Eigenschaften/, /^Aktivität/])
        await page
          .getByRole("button", { name, expanded: false })
          .first()
          .evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
      await page.locator(`${access} .k2b-detail-panel__row`, { hasText: "Lager-Team" }).waitFor();
      await settle(page);
      const avatars = await page.evaluate(() =>
        [...document.querySelectorAll(".k2b-detail-panel .k2b-avatar")]
          .filter((avatar) => avatar.getClientRects().length > 0)
          .map((avatar) => {
            const { width, height } = avatar.getBoundingClientRect();
            const slot = avatar.parentElement?.className.split(" ")[0] ?? "";
            return { slot, picture: avatar.tagName === "IMG", width, height, radius: getComputedStyle(avatar).borderTopLeftRadius };
          }),
      );
      // Presence chips and slots, comments, activity rows, access, and properties, with pictures among them.
      for (const slot of [
        "k2b-detail-presence__face",
        "k2b-detail-presence-slot",
        "k2b-discussion__avatar",
        "k2b-detail-panel__action-leading",
        "k2b-detail-properties__leading",
      ])
        expect(avatars.some((avatar) => avatar.slot === slot)).toBe(true);
      expect(avatars.filter((avatar) => avatar.picture).length).toBeGreaterThan(4);
      expect(avatars.filter((avatar) => Math.abs(avatar.width - avatar.height) > 0.5)).toEqual([]);
      expect(avatars.filter((avatar) => parseFloat(avatar.radius) < avatar.width / 2 - 0.5)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`${width}: people coming, going, and the connection failing never move the panel`, async () => {
    const { page } = await open(width);
    try {
      const tracked = [presence, header, `${contents} > .k2b-section__header`];
      const outlineTitle = `${contents} .notebook-outline-row .k2b-detail-panel__action-title`;
      const loading = await Promise.all([...tracked, outlineTitle].map((selector) => box(page, selector)));
      const steps: [string, () => void][] = [
        ["five here", () => window.harness.presence(5)],
        ["one here", () => window.harness.presence(1)],
        ["only you", () => window.harness.presence(0)],
        ["four here", () => window.harness.presence(4)],
        ["outage", () => window.harness.presenceStatus("down")],
        ["back", () => window.harness.presence(2)],
        ["offline", () => window.harness.offline(true)],
      ];
      for (const [, step] of steps) {
        await page.evaluate(step);
        await settle(page);
        // The offline band in the header is the one approved shift (16.10.); it moves the body, not its sections' sizes.
        const after = await Promise.all([...tracked, outlineTitle].map((selector) => box(page, selector)));
        after.forEach((current, index) => {
          closeTo(current.height, loading[index]!.height, 0.5);
          closeTo(current.width, loading[index]!.width, 0.5);
          closeTo(current.x, loading[index]!.x, 0.5);
        });
      }
      expect(await page.locator(".k2b-detail-presence__face[data-live='true']").count()).toBe(0);
      await page.evaluate(() => window.harness.offline(false));
      await page.evaluate(() => window.harness.presence(5));
      await settle(page);
      expect(await page.locator(".k2b-detail-presence__face[data-live='true']").count()).toBeGreaterThan(0);
      for (let index = 0; index < tracked.length; index++) sameBox(await box(page, tracked[index]!), loading[index]!);
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`${width}: access is a read-only list that public-link readers never see`, async () => {
    const { page } = await open(width);
    try {
      // Closed, the section names the first entries once the list has loaded after the first paint.
      await page
        .locator(`${access} .k2b-section__summary`, { hasText: "Lager-Team, Jana Berger und 5 weitere" })
        .waitFor({ state: "attached" });
      await page
        .getByRole("button", { name: /^Zugriff/, expanded: false })
        .evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
      await page.locator(`${access} .k2b-detail-panel__row`, { hasText: "Lager-Team" }).waitFor();
      const rows = await page.locator(`${access} .k2b-detail-panel__row`).allTextContents();
      expect(rows).toHaveLength(5);
      expect(rows[0]).toContain("Lager-Team");
      expect(rows[0]).toContain("Bearbeiten");
      expect(rows.some((row) => row.includes("Du") && row.includes("Verwalten"))).toBe(true);
      expect(await page.getByRole("button", { name: "2 weitere anzeigen" }).count()).toBe(1);
      expect(await page.locator(`${access} input, ${access} select`).count()).toBe(0);
    } finally {
      await page.close();
    }
    const reader = await open(width, false, "publiclink");
    try {
      expect(await reader.page.locator(access).count()).toBe(0);
    } finally {
      await reader.page.close();
    }
  }, 30_000);

  test(`${width}: activity, presence and disclosure keep earlier content in place`, async () => {
    const { page, release } = await open(width, true);
    try {
      expect(await page.locator(".notebook-activity-skeleton").count()).toBe(4);
      const tracked = [header, `${contents} > .k2b-section__header`, ".k2b-discussion__item"];
      const before = await Promise.all(tracked.map((selector) => box(page, selector)));
      release();
      await page.locator(".notebook-activity-skeleton").first().waitFor({ state: "detached" });
      await settle(page);
      for (let index = 0; index < tracked.length; index++) sameBox(await box(page, tracked[index]!), before[index]!);
      const presenceTracked = [".k2b-detail-panel__supporting > p", ".k2b-detail-panel__body > :first-child", ".k2b-detail-panel__header"];
      const priorPresence = await Promise.all(presenceTracked.map((selector) => box(page, selector)));
      await page.evaluate(() => window.harness.presence(5));
      await settle(page);
      for (let index = 0; index < presenceTracked.length; index++) {
        const after = await box(page, presenceTracked[index]!);
        const before = priorPresence[index]!;
        if (index === 0) {
          closeTo(after.x, before.x, 0.5);
          closeTo(after.y, before.y, 0.5);
          closeTo(after.height, before.height, 0.5);
        } else sameBox(after, before);
      }
      // Contents now precedes the comments (K1 order), so only what stands above it must hold still.
      const above = [".k2b-detail-panel__header", ".notebook-tasks"];
      const beforeCollapse = await Promise.all(above.map((selector) => box(page, selector)));
      // DOM click avoids Playwright scrolling the body to the disclosure.
      await page
        .locator(contents)
        .getByRole("button", { name: /^Inhalt/ })
        .evaluate((button) => {
          if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
          button.click();
        });
      await settle(page);
      for (let index = 0; index < above.length; index++) sameBox(await box(page, above[index]!), beforeCollapse[index]!);
      await page.getByRole("button", { name: /^Inhalt/ }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
        button.click();
      });
      await settle(page);
      for (let index = 0; index < above.length; index++) sameBox(await box(page, above[index]!), beforeCollapse[index]!);
      const beforeFold = await box(page, header);
      await page.getByRole("button", { name: "9 ältere anzeigen" }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
        button.click();
      });
      await settle(page);
      sameBox(await box(page, header), beforeFold);
      expect(await page.locator(".k2b-discussion__item").count()).toBe(12);
    } finally {
      release();
      await page.close();
    }
  }, 30_000);

  test(`${width}: Ansicht offers the available modes and offline actions explain recovery`, async () => {
    const { page } = await open(width);
    try {
      await page.getByRole("button", { name: "Ansicht", exact: true }).click();
      for (const name of ["Bearbeiten", "Lesen", "Buch", "Formatiert", "Markdown"])
        expect(await page.getByRole("menuitemradio", { name, exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).isVisible()).toBe(width === 1440);
      if (width === 1440) {
        await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).click();
        expect(await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).isVisible()).toBe(true);
        await page.keyboard.press("Escape");
      } else await page.getByRole("button", { name: "Schließen", exact: true }).click();
      await page.evaluate(() => window.harness.offline(true));
      expect(await page.getByText("Keine Verbindung zum Server", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Erneut verbinden", exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /^Mit KI bearbeiten/ }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: /^Kommentieren/ }).isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
}

// A size prop alone does not prevent app CSS from stretching or resizing a shared control.
for (const width of [320, 390, 768, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: AI and View keep the shared compact size`, async () => {
      const { page } = await open(width);
      try {
        await page.evaluate((theme) => {
          document.body.dataset.theme = theme;
          document.body.classList.toggle("k2b-dark", theme === "dark");
        }, theme);
        await settled(page);
        const ai = page.getByRole("button", { name: "Mit KI bearbeiten", exact: true });
        const view = page.getByRole("button", { name: "Ansicht", exact: true });
        const metrics = () =>
          page.locator('.notebook-detail-actions button[data-variant="ai"], .notebook-view-menu__trigger').evaluateAll((buttons) =>
            buttons.map((button) => {
              const style = getComputedStyle(button);
              const { x, y, width, height } = button.getBoundingClientRect();
              return { x, y, width, height, padding: style.padding, fontSize: style.fontSize };
            }),
          );
        const before = await metrics();
        expect(before).toHaveLength(2);
        const [action, menu] = before;
        expect(action!.height).toBe(28);
        expect(menu!.height).toBe(action!.height);
        expect(action!.padding).toBe(menu!.padding);
        expect(action!.fontSize).toBe(menu!.fontSize);
        closeTo(action!.y, menu!.y);
        // The content width is independent of the room left by the view menu.
        const intrinsicWidth = await ai.evaluate((button) => {
          const style = getComputedStyle(button);
          return (
            button.querySelector(".k2b-button__label")!.getBoundingClientRect().width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth)
          );
        });
        closeTo(action!.width, intrinsicWidth);
        expect(await ai.getAttribute("data-variant")).toBe("ai");
        expect(await view.getAttribute("data-variant")).toBe("secondary");
        const row = await box(page, ".notebook-detail-actions");
        for (const control of before) {
          expect(control.x).toBeGreaterThanOrEqual(row.x);
          expect(control.x + control.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
          expect(control.x + control.width).toBeLessThanOrEqual(width);
        }
        for (const control of [ai, view]) {
          await hoverInPlace(control);
          await settled(page);
          expect(await metrics()).toEqual(before);
        }
        // Enter the pair from the preceding header control using the keyboard.
        await page.getByRole("button", { name: "Notizdetails schließen", exact: true }).focus();
        await page.keyboard.press("Tab");
        expect(await ai.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
        await settled(page);
        expect(await metrics()).toEqual(before);
        await page.keyboard.press("Tab");
        expect(await view.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
        await settled(page);
        expect(await metrics()).toEqual(before);
        await page.evaluate(() => window.harness.offline(true));
        await settled(page);
        expect(await page.getByRole("button", { name: /^Mit KI bearbeiten/ }).isDisabled()).toBe(true);
        // The connection notice can move a phone sheet; the controls keep their own dimensions.
        const offline = await metrics();
        offline.forEach((control, index) => {
          expect(control.width).toBe(before[index]!.width);
          expect(control.height).toBe(before[index]!.height);
        });
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}

for (const width of [390, 1440]) {
  test(`${width}: the AI action keeps its size while launching and after failure`, async () => {
    const { page } = await open(width);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.route("**/api/ai/conversations", async (route) => {
        await pending;
        if (!page.isClosed()) await route.fulfill({ status: 503, json: { message: "Fixture: Assistant unavailable" } });
      });
      await settled(page);
      const selector = '.notebook-detail-actions button[data-variant="ai"]';
      const before = await box(page, selector);
      await page.getByRole("button", { name: "Mit KI bearbeiten", exact: true }).click();
      await page.locator(`${selector}[aria-busy="true"]`).waitFor();
      await settled(page);
      sameBox(await box(page, selector), before);
      expect(await page.locator(selector).isDisabled()).toBe(true);
      // Move off the button before the error dialog covers it, so its hover does not change mid-dialog animation.
      await page.mouse.move(0, 0);
      await settled(page);
      release();
      await page.getByText("Fixture: Assistant unavailable", { exact: true }).waitFor();
      await page.locator(`${selector}:not(:disabled)`).waitFor();
      await settled(page);
      sameBox(await box(page, selector), before);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  }, 30_000);
}
