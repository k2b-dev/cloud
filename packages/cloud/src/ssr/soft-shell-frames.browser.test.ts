import { beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import type { BunPlugin } from "bun";
import { launchBrowser } from "../../../ui/test/browser";
import { html, installCompactShellHarness, ipadPortrait, open, phone } from "./compact-shell.browser-harness";

installCompactShellHarness(launchBrowser);

const solid = (await import(Bun.resolveSync("babel-preset-solid", `${import.meta.dir}/`))).default;
const compile: BunPlugin = {
  name: "soft-shell-client",
  setup(builder) {
    // The distributed UI and CloudShell must share the browser Solid runtime.
    builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(import.meta.dir, "../../../ui/dist/browser/index.js") }));
    builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        babelrc: false,
        configFile: false,
        presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
      });
      if (!result?.code) throw new Error(`Could not compile ${path}`);
      return { contents: result.code, loader: "js", resolveDir: dirname(path) };
    });
  },
};

// Stringified into the server response and executed only after its first animation frame.
const measure = () => {
  const selectors = [
    ".layout-rail",
    ".layout-rail .rail-item",
    ".layout-header",
    ".layout-header button",
    ".layout-header a",
    ".layout-shell-content",
    "main.layout-content-main",
    ".k2b-app-workspace",
  ];
  return selectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((element, index) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { selector, index, visible: element.checkVisibility(), left, top, right, bottom, width, height };
    }),
  );
};
let client: string;
beforeAll(async () => {
  const entry = resolve(import.meta.dir, "soft-shell-frames.client.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { fromJSON } from "seroval";
import { LocaleProvider, installAppWorkspaceController } from "@k2b/ui";
import CloudShell from "./CloudShell.island";
window.mountShell = () => {
  const islands = [...document.querySelectorAll("solid-island")].filter(element => element.innerHTML.includes("layout-rail-navigation") || element.closest(".layout-header"));
  if (islands.length !== 2) throw new Error("Expected the real rail and header CloudShell islands, got " + islands.length);
  for (const island of islands) {
    const props = fromJSON(JSON.parse(island.dataset.props));
    island.replaceChildren();
    render(() => createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() { return createComponent(CloudShell, props); },
    }), island);
  }
  installAppWorkspaceController();
};`,
    },
    plugins: [compile],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the real shell islands");
  client = await bundle.outputs[0]!.text();
}, 60_000);

describe("soft shell server, mounted and settled frames", () => {
  for (const device of [ipadPortrait, phone]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device.width}×${device.height} ${theme}: ten reloads preserve every shell rectangle`, async () => {
        const { context, page } = await open(device, "/app/mail/inbox", { theme, attached: false });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const markup = await html("/app/mail/inbox", { theme });
          // Serve real SSR HTML. Framework asset scripts are stripped by the harness; the
          // first measurement runs in rAF before the client bundle is inserted or mounted.
          await page.route("https://shell.example.test/**", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: markup.replace(
                "</body>",
                `<script>
window.measureShell = ${measure.toString()};
requestAnimationFrame(() => { window.serverFrame = window.measureShell(); });
</script></body>`,
              ),
            }),
          );
          for (let reload = 0; reload < 10; reload++) {
            if (reload === 0) await page.goto("https://shell.example.test/app/mail/inbox");
            else await page.reload();
            await page.waitForFunction(() => "serverFrame" in window);
            await page.addScriptTag({ content: client });
            const frames = await page.evaluate(async () => {
              const host = window as unknown as {
                serverFrame: ReturnType<typeof measure>;
                measureShell: typeof measure;
                mountShell: () => void;
              };
              const server = host.serverFrame;
              host.mountShell();
              const mounted = host.measureShell();
              await new Promise<void>((settle) => requestAnimationFrame(() => requestAnimationFrame(() => settle())));
              return { server, mounted, settled: host.measureShell() };
            });
            expect(frames.server.some((rect) => rect.selector === ".layout-rail .rail-item")).toBe(true);
            // Phones have no bottom dock: the card takes its place in the server's first frame already.
            expect(frames.server.some((rect) => rect.selector === ".layout-header button")).toBe(true);
            if (device.width < 768) {
              const main = frames.server.find((rect) => rect.selector === "main.layout-content-main");
              expect(main?.bottom).toBe(device.height);
            }
            for (const [stage, frame] of Object.entries({ mounted: frames.mounted, settled: frames.settled })) {
              expect(frame.length, `${reload} ${stage}: element count`).toBe(frames.server.length);
              for (const [index, rect] of frame.entries()) {
                const before = frames.server[index]!;
                const label = `${reload} ${stage} ${rect.selector}[${rect.index}]`;
                expect([rect.selector, rect.index, rect.visible], label).toEqual([before.selector, before.index, before.visible]);
                for (const edge of ["left", "top", "right", "bottom", "width", "height"] as const)
                  expect(Math.abs(rect[edge] - before[edge]), `${label}.${edge}`).toBeLessThanOrEqual(0.01);
              }
            }
          }
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }
});

test("390×844: without a dock the workspace primary is the round button in the head and the last task stays reachable", async () => {
  const { context, page } = await open(phone, "/app/mail/inbox?list=page&head=1");
  try {
    expect(await page.locator(".cloud-tab-bar").count()).toBe(0);
    const primary = page.getByRole("link", { name: "New task", exact: true });
    const action = await primary.boundingBox();
    const head = await page.locator(".k2b-app-workspace__head").first().boundingBox();
    expect(action).not.toBeNull();
    // The round button stays in the head row, as on hosts without a bottom bar; nothing floats over the list.
    expect(Math.round(action!.width)).toBe(Math.round(action!.height));
    expect(action!.y).toBeGreaterThanOrEqual(head!.y);
    expect(action!.y + action!.height).toBeLessThanOrEqual(head!.y + head!.height);
    expect(action!.x + action!.width).toBeLessThanOrEqual(phone.width);
    expect(await primary.evaluate((element) => getComputedStyle(element).position)).not.toBe("fixed");
    const assertLastIsClear = async () => {
      const geometry = await page
        .locator(".list-row")
        .last()
        .evaluate((element) => {
          const row = element.getBoundingClientRect();
          return {
            top: row.top,
            bottom: row.bottom,
            covered: [...document.querySelectorAll("[data-workspace-primary]")].some((overlay) => {
              const box = overlay.getBoundingClientRect();
              return row.left < box.right && row.right > box.left && row.top < box.bottom && row.bottom > box.top;
            }),
          };
        });
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(phone.height);
      expect(geometry.covered).toBe(false);
    };
    await page.locator(".k2b-app-workspace__main").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await page.locator(".k2b-app-workspace__main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await assertLastIsClear();
    await page.locator(".list-row").last().focus();
    await assertLastIsClear();
    expect(
      await page
        .locator(".list-row")
        .last()
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
