import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-runner-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { default: Runner } = await import("./Runner.island");

test("fullscreen runner stacks its preview surface and control bar directly under the section", () => {
  const html = renderToString(() =>
    createComponent(Runner, {
      userId: "RunnerUser",
      initial: { id: "Run001", title: "Gutter probe", sourceRevision: 1, publishedVersion: 1, serverAccess: true, canManage: true },
    }),
  );
  const tag = (name: string) => new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${name}\\b[^"]*"[^>]*>`).exec(html)?.[0];
  expect(tag("assistant-standalone-runner")).toContain('aria-label="Gutter probe"');
  // The sandbox host renders first but hidden, so the panel's flex gap never
  // pushes the preview below the shell's own gutter.
  expect(html).toMatch(/<div class="artifact-panel"><div hidden><\/div><div[^>]*class="k2b-scroll-area artifact-panel__preview\b/);
  const order = ["assistant-standalone-runner", "artifact-panel__preview", "artifact-panel__console", "artifact-console__header"].map(
    (name) => html.indexOf(tag(name) ?? `missing ${name}`),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("the Cloud shell frames the signed-in runner from lg while the public page and mobile shell keep its inset", async () => {
  const css = await Bun.file(new URL("../styles/app.css", import.meta.url)).text();
  const runner = /^\.assistant-standalone-runner \{[^}]*\}/m.exec(css)?.[0];
  expect(runner).toContain("padding: var(--ui-space-section);");
  const desktopStart = css.indexOf("@media (min-width: 1024px) {\n  .assistant-standalone-runner");
  expect(desktopStart).toBeGreaterThan(-1);
  const desktop = css.slice(desktopStart, css.indexOf("\n}", desktopStart));
  expect(desktop).toContain(".assistant-standalone-runner { padding: 0; }");
  expect(desktop).toContain(".assistant-standalone-page .assistant-standalone-runner { padding: var(--ui-space-section); }");
});
