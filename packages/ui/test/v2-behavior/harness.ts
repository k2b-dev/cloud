import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Pattern } from "@ui-sdk/core/testing";
import type { Browser, Page } from "playwright";
import { type Component, createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { settled } from "../browser";
import { registerSsrTestPlugin } from "../ssr-test-plugin";
import type {} from "./mount";

const here = import.meta.dir;

/** The demo's browser bundle: the entry mounts the demo over the server markup in #root. */
export const demoBundle = async (name: string): Promise<string> => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(here, `${name}.entry.tsx`)],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "v2-behavior-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, `${name} bundle failed`);
  return build.outputs[0]!.text();
};

let ssrRoot: string | undefined;

/** The demo rendered on the server, as an @k2b/ssr page sends it before the island mounts. */
export const serverMarkup = async (name: string): Promise<string> => {
  if (!ssrRoot) {
    ssrRoot = mkdtempSync(resolve(tmpdir(), "k2b-ui-v2-behavior-"));
    const root = ssrRoot;
    registerSsrTestPlugin({ dev: true, rootDir: root });
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  }
  const demo: { Demo: Component } = await import(resolve(here, `${name}.demo.tsx`));
  return renderToString(() => createComponent(demo.Demo, {}));
};

export const contractCss = (): Promise<string> => Bun.file(resolve(here, "contract.css")).text();

export type OpenOptions = {
  width?: number;
  height?: number;
  theme?: "light" | "dark";
  touch?: boolean;
  /** Server markup to show before the bundle mounts over it. */
  markup?: string;
  /** Runs in the page before the bundle, for measurements that must see the mount. */
  before?: string;
};

/** A page with the contract CSS, the server markup and the mounted demo, settled. */
export const openDemo = async (browser: Browser, bundle: string, css: string, options: OpenOptions = {}): Promise<Page> => {
  const { width = 1440, height = 900, theme = "light", touch = false, markup = "", before = "" } = options;
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, hasTouch: touch });
  // A missed condition fails at its own step, inside the test's 5 s, instead of timing the whole test out.
  page.setDefaultTimeout(2000);
  await page.setContent(
    `<!doctype html><html lang="de" data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root">${markup}</div></body></html>`,
  );
  if (before) await page.addScriptTag({ content: before });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return page;
};

/** Whether focus is inside the element that `selector` names. */
export const focusInside = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((s) => Boolean(document.querySelector(s)?.contains(document.activeElement)), selector);

/** The test id or text of the focused element. */
export const focusedName = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.textContent?.trim());

/** ui-sdk's own `checkPattern` on the element `selector` names: "ok" or its message. */
export const pattern = (page: Page, selector: string, name: Pattern): Promise<string> =>
  page.evaluate(
    async ([s, n]) => {
      const root = document.querySelector(s);
      if (!root) return `no element for ${s}`;
      try {
        await window.__checkPattern(root, n);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [selector, name] as const,
  );

/** Text of every live region, joined. */
export const heard = (page: Page, text: string): Promise<boolean> =>
  page
    .waitForFunction((t) => [...document.querySelectorAll("[aria-live]")].some((region) => region.textContent?.includes(t)), text, {
      timeout: 2000,
    })
    .then(
      () => true,
      () => false,
    );
