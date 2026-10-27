import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { radioKeyTarget } from "../internal/radio-keys";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-choice-tiles-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ChoiceTiles } = await import("./ChoiceTiles");
const { ColorChoices } = await import("./ColorChoices");

describe("radioKeyTarget", () => {
  test("arrows wrap, Home and End jump, other keys are left alone", () => {
    expect(radioKeyTarget("ArrowRight", 2, 3)).toBe(0);
    expect(radioKeyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(radioKeyTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(radioKeyTarget("ArrowUp", 1, 3)).toBe(0);
    expect(radioKeyTarget("Home", 2, 3)).toBe(0);
    expect(radioKeyTarget("End", 0, 3)).toBe(2);
    expect(radioKeyTarget("Enter", 0, 3)).toBeUndefined();
    expect(radioKeyTarget("ArrowRight", 0, 0)).toBeUndefined();
  });
});

describe("ChoiceTiles", () => {
  const options = [
    { value: "round", label: "Round", visual: "○" },
    { value: "square", label: "Square", visual: "□", status: "Active" },
  ];

  test("renders a labeled radio group whose chosen tile holds the tab stop and a decorative preview", () => {
    const html = renderToString(() =>
      createComponent(ChoiceTiles, { label: "Face shape", description: "Shown everywhere", value: "square", options }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-labelledby="[^"]+-label"/);
    expect(html).toMatch(/aria-describedby="[^"]+-description"/);
    expect(html).toContain('class="k2b-choice-tiles__visual" aria-hidden="true"');
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*>.*Square/s);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    // The grid shows no status line; the row keeps one for every tile, also when empty, so tiles keep their height.
    expect(html).not.toContain("k2b-choice-tiles__status");
  });

  test("the row layout keeps a status line on every tile and dims previews on request", () => {
    const html = renderToString(() =>
      createComponent(ChoiceTiles, { "aria-label": "Kind", layout: "row" as const, dimmed: true, value: null, options }),
    );
    expect(html).toContain('aria-label="Kind"');
    expect(html).toContain('data-layout="row"');
    expect(html).toContain('data-dimmed="true"');
    expect(html.match(/k2b-choice-tiles__status/g)).toHaveLength(2);
    expect(html).toContain("Active");
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf("Round"));
  });
});

describe("ColorChoices", () => {
  test("names every swatch, so colour is never the only signal", () => {
    const html = renderToString(() =>
      createComponent(ColorChoices, {
        label: "Hair colour",
        value: "red",
        options: [
          { value: "black", label: "Black", color: "#26201d" },
          { value: "red", label: "Red", color: "#b9532d" },
        ],
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Black"');
    expect(html).toContain('title="Red"');
    expect(html).toContain("--k2b-color-choice:#b9532d");
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
});
