import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mapPalette } from "../content/map-palette";
import { cssDeclarations, parseCssRules } from "./css-contract-test-helpers";

const source = readFileSync(resolve(import.meta.dir, "content-parity.css"), "utf8");
const rules = parseCssRules("content-parity.css", source);

test("light and every dark map selector mirror the map image palette", () => {
  const light = rules.filter((rule) => rule.selector === ".k2b-ui .k2b-map-view");
  const dark = rules.filter(
    (rule) => /\.k2b-map-view(?::where\([^{}]+\))?$/.test(rule.selector) && rule.selector.includes('[data-theme="dark"]'),
  );
  expect(light).toHaveLength(1);
  expect(dark).toHaveLength(4);
  for (const theme of ["light", "dark"] as const) {
    for (const rule of theme === "light" ? light : dark) {
      const declarations = cssDeclarations(rule.body);
      for (const [key, color] of Object.entries(mapPalette[theme])) {
        const kebab = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        expect(declarations.get(`--k2b-map-${kebab}`)?.map((value) => value.toLowerCase())).toEqual([color.toLowerCase()]);
      }
    }
  }
});
