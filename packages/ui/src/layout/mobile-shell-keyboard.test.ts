import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-mobile-shell-keyboard-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { keyboardInset } = await import("./MobileShell");

const view = (innerHeight: number, visual?: { height: number; offsetTop: number }) =>
  ({ innerHeight, visualViewport: visual ? (visual as VisualViewport) : null }) as Pick<Window, "innerHeight" | "visualViewport">;

describe("the keyboard inset of the mobile shell", () => {
  test("is the height the visual viewport leaves uncovered at the bottom of the layout viewport", () => {
    expect(keyboardInset(view(844, { height: 553, offsetTop: 0 }))).toBe(291);
    // A page the browser scrolled up to keep the field in view still knows where the keyboard begins.
    expect(keyboardInset(view(844, { height: 553, offsetTop: 40 }))).toBe(251);
  });

  test("is zero without a keyboard, for browser chrome such as a hiding address bar, and without visualViewport", () => {
    expect(keyboardInset(view(844, { height: 844, offsetTop: 0 }))).toBe(0);
    expect(keyboardInset(view(844, { height: 780, offsetTop: 0 }))).toBe(0);
    expect(keyboardInset(view(844))).toBe(0);
  });
});
