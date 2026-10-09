import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { GestureMenuItem } from "../index";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-gesture-menu-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { GestureMenu, MessageRow } = await import("../index");
const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();

const items: GestureMenuItem[] = [
  { label: "Reply", icon: "ti ti-arrow-back-up", action: () => {}, gesture: "swipe-right" },
  { label: "React", icon: "ti ti-thumb-up", action: () => {}, gesture: "double-tap" },
  { label: "Copy text", icon: "ti ti-copy", action: () => {} },
];

const html = (props: { items: readonly GestureMenuItem[]; tabIndex?: number }) =>
  renderToString(() => createComponent(GestureMenu, { label: "Message from Nora", ...props, children: "Can you check the draft?" }));

describe("GestureMenu on the server", () => {
  test("renders a named group with a menu and the touch behavior its items declare", () => {
    const swipe = html({ items });
    expect(swipe).toMatch(/role="group"[^>]*aria-label="Message from Nora"/);
    expect(swipe).toContain('aria-haspopup="menu"');
    expect(swipe).toContain('aria-expanded="false"');
    expect(swipe).toMatch(/class="k2b-gesture-menu"[^>]*data-active=""[^>]*data-touch="swipe"/);
    expect(swipe).toContain('<div class="k2b-gesture-menu__content">Can you check the draft?</div>');
    // Nothing moves before a swipe: no swipe state, no indicator.
    expect(swipe).not.toContain("data-swipe");
    expect(swipe).not.toContain("k2b-gesture-menu__swipe");

    expect(html({ items: items.slice(1) })).toContain('data-touch="tap"');
    expect(html({ items: items.slice(2) })).not.toContain("data-touch");
    expect(html({ items: items.slice(2), tabIndex: -1 })).toContain('tabindex="-1"');

    const empty = html({ items: [] });
    expect(empty).toContain('aria-disabled="true"');
    expect(empty).not.toContain("data-active");
  });

  test("a disabled gesture item leaves the browser's own touch handling", () => {
    const disabled: GestureMenuItem[] = [{ label: "Reply", action: () => {}, gesture: "swipe-right", disabled: true }];
    expect(html({ items: disabled })).not.toContain("data-touch");
  });

  test("MessageRow marks its code blocks, link preview, and card so gestures never start there", () => {
    const row = renderToString(() =>
      createComponent(MessageRow, {
        author: { name: "Nora" },
        text: "```ts\nconst a = 1;\n```",
        time: "10:42",
        linkPreview: "Preview",
        card: "Card",
      }),
    );
    expect(row).toContain('<div class="k2b-message-row__code" data-gesture-ignore>');
    expect(row).toContain('<div class="k2b-message-row__slot" data-gesture-ignore>Preview</div>');
    expect(row).toContain('<div class="k2b-message-row__slot" data-gesture-ignore>Card</div>');
  });

  test("moves content only by a transform while a swipe runs and keeps reduced motion still", () => {
    expect(css).toContain(
      ".k2b-ui .k2b-gesture-menu[data-swipe] > .k2b-gesture-menu__content {\n  transform: translateX(var(--k2b-gesture-menu-offset, 0px));",
    );
    expect(css).toContain('.k2b-ui .k2b-gesture-menu[data-touch="swipe"] {\n  touch-action: pan-y pinch-zoom;');
    expect(css).toContain('.k2b-ui .k2b-gesture-menu[data-touch="tap"] {\n  touch-action: manipulation;');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.k2b-ui \.k2b-gesture-menu\[data-settling\] > \.k2b-gesture-menu__content \{\s*transition: none;/,
    );
    // With reduced motion the content stays over the icon, so the icon is raised above it, inside the element.
    expect(css).toMatch(
      /\.k2b-ui \.k2b-gesture-menu\[data-swipe\] \{\s*isolation: isolate;\s*\}\s*\.k2b-ui \.k2b-gesture-menu\[data-swipe\] > \.k2b-gesture-menu__swipe \{\s*z-index: 1;\s*\}\s*\}/,
    );
  });
});
