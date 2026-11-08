import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { FeatCodeMarkProps } from "./FeatCodeMark";

// Solid's server transform, as the app server compiles the component.
const root = mkdtempSync(resolve(tmpdir(), "cloud-feat-code-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { FEAT_CODE_NAME, FeatCodeMark } = await import("./FeatCodeMark");

const html = (props: FeatCodeMarkProps = {}) => renderToString(() => createComponent(FeatCodeMark, props)).replaceAll(/<!--[^>]*-->/g, "");
const attribute = (markup: string, name: string) => markup.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe("FeatCodeMark", () => {
  test("is one image named feat/code, the same in every locale", () => {
    const markup = html();
    expect(FEAT_CODE_NAME).toBe("feat/code");
    expect(attribute(markup, "role")).toBe("img");
    expect(attribute(markup, "aria-label")).toBe("feat/code");
    expect(attribute(markup, "data-variant")).toBe("wordmark");
    expect(attribute(markup, "data-tone")).toBe("brand");
    // The sign stands in for the slash: the word is "feat", the sign, then "code".
    expect(markup.replace(/<[^>]+>/g, "")).toBe("featcode");
  });

  test("decorative marks stay out of the accessibility tree", () => {
    const markup = html({ decorative: true });
    expect(attribute(markup, "aria-hidden")).toBe("true");
    expect(markup).not.toContain("aria-label");
  });

  test("16 px and below, and running text, use the small drawing; headings and larger sizes the slim one", () => {
    expect(attribute(html(), "data-drawing")).toBe("small");
    expect(attribute(html({ size: 12.5 }), "data-drawing")).toBe("small");
    expect(attribute(html({ size: 16 }), "data-drawing")).toBe("small");
    expect(attribute(html({ size: 17 }), "data-drawing")).toBe("large");
    expect(attribute(html({ size: "title" }), "data-drawing")).toBe("large");
    expect(attribute(html({ variant: "glyph", size: 16 }), "data-drawing")).toBe("small");
    expect(attribute(html({ variant: "glyph", size: 32 }), "data-drawing")).toBe("large");
  });

  test("a pixel size sets the font size; named sizes inherit the surrounding text", () => {
    expect(html({ size: 30 })).toContain("font-size:30px");
    expect(html({ size: "title" })).not.toContain("font-size");
    expect(html()).not.toContain("font-size");
    // The class stays exact on the server, so selectors and the client agree.
    expect(html()).toContain('<span class="cloud-featcode" ');
  });

  test("the glyph is the sign alone, on a square box, in the brand or the text colour", () => {
    const glyph = html({ variant: "glyph", tone: "current" });
    expect(attribute(glyph, "data-variant")).toBe("glyph");
    expect(attribute(glyph, "data-tone")).toBe("current");
    expect(attribute(glyph, "viewBox")).toBe("0.5 1 31 31");
    expect(glyph.replace(/<[^>]+>/g, "")).toBe("");
  });
});
