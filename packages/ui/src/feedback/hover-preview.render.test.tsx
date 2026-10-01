import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, createRoot } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-hover-preview-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { createHoverPreview, HoverPreview } = await import("../index");

test("renders a closed card on the server without touching browser globals", () => {
  const html = renderToString(() => {
    const preview = createHoverPreview<string>({ openDelay: 200, placement: { beside: () => undefined } });
    return createComponent(HoverPreview<string>, {
      preview,
      label: "Quick look",
      size: "fixed",
      children: (id: string) => `Conversation ${id}`,
    });
  });

  expect(html).toContain('popover="auto"');
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-label="Quick look"');
  expect(html).toContain('data-size="fixed"');
  expect(html).toMatch(/id="k2b-hover-preview-[^"]+"/);
  // Nothing is open yet, so a function child renders nothing.
  expect(html).not.toContain("Conversation");
});

test("a server render that disposes the card, as a streamed page does, touches no browser globals", () => {
  expect(() =>
    createRoot((dispose) => {
      const preview = createHoverPreview<string>();
      renderToString(() => createComponent(HoverPreview<string>, { preview, label: "Quick look", children: "Details" }));
      dispose();
    }),
  ).not.toThrow();
});
